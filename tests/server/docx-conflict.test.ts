/**
 * .docx external-conflict detection + restore-vs-reload prompt (#1069).
 *
 * Covers:
 *  - file-watcher delivery on an externally-changed .docx: dirty doc → conflict
 *    flag (NO auto-reload); clean doc → reload from disk (binary-safe).
 *  - own-save suppression seam: the binary save branch arms suppressNextChange
 *    BEFORE atomicWriteBuffer (arrival-time consumption semantics are covered
 *    by tests/server/file-watcher.test.ts).
 *  - resolveExternalConflict: "keep" clears the flag + re-baselines savedAt,
 *    "reload" routes through reloadFromDisk.
 *  - session restore: a dirty .docx session restores (even over a changed
 *    disk file) and raises the unsaved-restore flag; a clean .docx session
 *    over a changed file falls back to disk (unchanged behavior).
 *  - saveSession persists the dirty flag.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// vi.mock factories are hoisted before module-level code; compute paths inline.
vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-docx-conflict-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return {
    ...original,
    SESSION_DIR: pathMod.join(appDataDir, "sessions"),
  };
});

// Mock the watcher seam: capture the per-path onChanged callback so tests can
// deliver "external change" events deterministically, and spy on
// suppressNextChange to assert the own-save pre-arm.
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  suppressNextChange: vi.fn(),
}));

import type { Request, Response } from "express";
import { resetForTesting as resetDirtyState } from "../../src/server/documents/dirty.js";
import { suppressNextChange, watchFile } from "../../src/server/file-watcher.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import {
  getOpenDocs,
  hasDoc,
  removeDoc,
  saveDocumentToDisk,
  setActiveDocId,
} from "../../src/server/mcp/document-service.js";
import { openFileByPath, resolveExternalConflict } from "../../src/server/mcp/file-opener.js";
import { handleResolveDocxConflict } from "../../src/server/mcp/routes/docx-conflict.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
} from "../../src/server/notifications.js";
import { loadSession, saveSession } from "../../src/server/session/manager.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_SAVED_AT_VERSION,
} from "../../src/shared/constants.js";
import { withBrowser } from "../../src/shared/origins.js";
import type { ExternalConflictState } from "../../src/shared/types.js";

/** Build a minimal one-paragraph .docx buffer with the given text. */
async function buildSimpleDocx(text: string): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>` +
      `</w:document>`,
  );
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

/** The LATEST watcher onChanged callback captured for `filePath` by the
 *  watchFile mock (reopen paths re-wire; the real watchFile would no-op). */
function capturedWatcherCallback(filePath: string): (p: string) => Promise<void> {
  const calls = vi.mocked(watchFile).mock.calls.filter(([p]) => p === filePath);
  expect(calls.length, `watchFile was not called for ${filePath}`).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as (p: string) => Promise<void>;
}

/** Make a doc dirty via a browser-origin body edit (bumps the dirty counter). */
function makeDirty(doc: Y.Doc): void {
  const fragment = doc.getXmlFragment("default");
  withBrowser(doc, () => {
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    p.insert(0, [t]);
    fragment.insert(fragment.length, [p]);
    t.insert(0, "local unsaved edit");
  });
}

function conflictOf(doc: Y.Doc): ExternalConflictState | undefined {
  return doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_EXTERNAL_CONFLICT) as
    | ExternalConflictState
    | undefined;
}

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  resetDirtyState();
  resetNotifications();
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-docx-conflict-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.TANDEM_APP_DATA_DIR;
});

// ---------------------------------------------------------------------------
// Watcher delivery — dirty doc flags, clean doc reloads
// ---------------------------------------------------------------------------
describe("docx watcher — external change with unsaved edits", () => {
  it("flags an external-edit conflict and does NOT reload the content", async () => {
    const filePath = path.join(tmpDir, "conflict.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("Original body"));

    const opened = await openFileByPath(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];

    makeDirty(doc);
    const textBefore = extractText(doc);
    expect(textBefore).toContain("local unsaved edit");

    // External tool rewrites the .docx, then the (debounced) watcher delivers.
    await fs.writeFile(filePath, await buildSimpleDocx("External rewrite"));
    await capturedWatcherCallback(watcherPath)(watcherPath);

    // Flag set, content untouched — never auto-reload over unsaved edits.
    expect(conflictOf(doc)).toMatchObject({ kind: "external-edit", diskChanged: true });
    expect(extractText(doc)).toBe(textBefore);
    expect(extractText(doc)).not.toContain("External rewrite");

    // A warning notification was pushed for the client toast surface.
    const note = getBuffer().find((n) => n.type === "external-conflict");
    expect(note).toBeDefined();
    expect(note!.severity).toBe("warning");
    expect(note!.documentId).toBe(opened.documentId);
  });

  it("reloads a CLEAN .docx from disk (binary-safe) and clears nothing it shouldn't", async () => {
    const filePath = path.join(tmpDir, "clean-reload.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("First version"));

    const opened = await openFileByPath(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    expect(extractText(doc)).toContain("First version");

    await fs.writeFile(filePath, await buildSimpleDocx("Second version"));
    const stat = await fs.stat(filePath);
    await capturedWatcherCallback(watcherPath)(watcherPath);

    expect(extractText(doc)).toContain("Second version");
    expect(conflictOf(doc)).toBeUndefined();
    // savedAt baseline refreshed to the new disk mtime so future explicit
    // saves aren't permanently blocked by the external-modification guard.
    const savedAt = doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION) as number;
    expect(savedAt).toBe(stat.mtimeMs);

    const note = getBuffer().find((n) => n.type === "file-reloaded");
    expect(note).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Own-save suppression seam
// ---------------------------------------------------------------------------
describe("docx own-save suppression", () => {
  it("arms suppressNextChange for the file path on an explicit binary save", async () => {
    const filePath = path.join(tmpDir, "own-save.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("Save me"));

    const opened = await openFileByPath(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    makeDirty(doc);

    const result = await saveDocumentToDisk(opened.documentId, "manual");
    expect(result.status).toBe("saved");

    // The suppress pre-arm means the watcher swallows Tandem's own write at
    // event ARRIVAL — so the dirty-doc conflict branch never sees it.
    expect(vi.mocked(suppressNextChange)).toHaveBeenCalledWith(
      getOpenDocs().get(opened.documentId)!.filePath,
    );
    // And a successful save resolves any pending conflict flag.
    expect(conflictOf(doc)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveExternalConflict — keep / reload routing
// ---------------------------------------------------------------------------
describe("resolveExternalConflict", () => {
  async function flaggedSetup() {
    const filePath = path.join(tmpDir, "resolve.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("Disk body"));
    const opened = await openFileByPath(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    makeDirty(doc);
    await fs.writeFile(filePath, await buildSimpleDocx("Newer disk body"));
    await capturedWatcherCallback(watcherPath)(watcherPath);
    expect(conflictOf(doc)).toBeDefined();
    return { filePath, id: opened.documentId, doc };
  }

  it('"keep" clears the flag, keeps edits, and re-baselines savedAt to disk mtime', async () => {
    const { filePath, id, doc } = await flaggedSetup();
    const textBefore = extractText(doc);

    await resolveExternalConflict(id, "keep");

    expect(conflictOf(doc)).toBeUndefined();
    expect(extractText(doc)).toBe(textBefore); // edits kept
    const stat = await fs.stat(filePath);
    const savedAt = doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION) as number;
    expect(savedAt).toBe(stat.mtimeMs); // explicit save unblocked
  });

  it('"keep" re-baselines via Date.now() when the file is unreadable, so saves stay unblocked', async () => {
    const { filePath, id, doc } = await flaggedSetup();
    const baselineBefore = doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION) as number;
    // Make fs.stat fail (transient lock / ENOENT). Without the fallback the
    // banner clears but the stale baseline blocks every subsequent save.
    await fs.rm(filePath);
    const before = Date.now();

    await resolveExternalConflict(id, "keep");

    expect(conflictOf(doc)).toBeUndefined();
    const savedAt = doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION) as number;
    expect(savedAt).toBeGreaterThanOrEqual(before);
    expect(savedAt).toBeGreaterThan(baselineBefore);
  });

  it('"reload" discards edits and loads the on-disk content', async () => {
    const { id, doc } = await flaggedSetup();

    await resolveExternalConflict(id, "reload");

    expect(conflictOf(doc)).toBeUndefined();
    expect(extractText(doc)).toContain("Newer disk body");
    expect(extractText(doc)).not.toContain("local unsaved edit");
  });

  it("is a no-op success when no conflict is pending", async () => {
    const filePath = path.join(tmpDir, "no-conflict.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("Quiet"));
    const opened = await openFileByPath(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    makeDirty(doc);
    const textBefore = extractText(doc);

    await expect(resolveExternalConflict(opened.documentId, "reload")).resolves.toBeUndefined();
    // Without a pending conflict, "reload" must NOT silently discard edits.
    expect(extractText(doc)).toBe(textBefore);
  });

  it("throws NO_DOCUMENT for an unopened document", async () => {
    await expect(resolveExternalConflict("nope", "keep")).rejects.toMatchObject({
      code: "NO_DOCUMENT",
    });
  });
});

// ---------------------------------------------------------------------------
// handleResolveDocxConflict — route-level doc selection (#1162)
//
// The banner is per-tab and the server's active doc does NOT track the client's
// focused tab, so the handler must resolve the conflict on the body's
// `documentId`, not on `getActiveDocId()`. Regression: on an upgrade boot the
// read-only CHANGELOG.md becomes server-active, and clicking "Reload from file"
// on a restored .docx tab silently no-op'd because the handler resolved the
// active (CHANGELOG) doc instead of the docx.
// ---------------------------------------------------------------------------
describe("handleResolveDocxConflict — route doc selection", () => {
  function makeRes() {
    const res = {
      _status: 0,
      _body: null as unknown,
      status(code: number) {
        this._status = code;
        return this;
      },
      json(body: unknown) {
        this._body = body;
        return this;
      },
    };
    return res;
  }

  function makeReq(body: unknown): Request {
    return { body } as unknown as Request;
  }

  /** Open a docx, dirty it, deliver an external change → pending conflict flag. */
  async function flaggedDocx(name: string, diskBody: string) {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, await buildSimpleDocx("Original"));
    const opened = await openFileByPath(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi
      .mocked(watchFile)
      .mock.calls.filter(([p]) => p === filePath)
      .at(-1)![0];
    makeDirty(doc);
    await fs.writeFile(filePath, await buildSimpleDocx(diskBody));
    await capturedWatcherCallback(watcherPath)(watcherPath);
    expect(conflictOf(doc)).toBeDefined();
    return { id: opened.documentId, doc };
  }

  it("honors the body documentId over a DIFFERENT server-active doc (the regression)", async () => {
    // The docx that carries the conflict and is the client's focused tab.
    const { id: docxId, doc: docxDoc } = await flaggedDocx("focused.docx", "Newer disk body");

    // A second, conflict-free doc that the server considers active (mimics the
    // read-only CHANGELOG.md opened on upgrade).
    const otherPath = path.join(tmpDir, "active-other.docx");
    await fs.writeFile(otherPath, await buildSimpleDocx("Other doc"));
    const other = await openFileByPath(otherPath);
    setActiveDocId(other.documentId);
    expect(hasDoc(docxId)).toBe(true);

    const res = makeRes();
    await handleResolveDocxConflict(
      makeReq({ documentId: docxId, choice: "reload" }),
      res as unknown as Response,
    );

    expect(res._status).toBe(0); // success (no error status)
    expect(res._body).toMatchObject({ success: true });
    // The docx — NOT the active doc — was reloaded: flag cleared, disk content in.
    expect(conflictOf(docxDoc)).toBeUndefined();
    expect(extractText(docxDoc)).toContain("Newer disk body");
    expect(extractText(docxDoc)).not.toContain("local unsaved edit");
  });

  it("rejects an unknown documentId with 400 instead of falling back to the active doc", async () => {
    // A valid, different active doc proves the body id was consulted + rejected,
    // not silently bypassed via getActiveDocId().
    const { id: activeId } = await flaggedDocx("active.docx", "Active disk body");
    setActiveDocId(activeId);

    const res = makeRes();
    await handleResolveDocxConflict(
      makeReq({ documentId: "does-not-exist", choice: "reload" }),
      res as unknown as Response,
    );

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ error: "NO_DOCUMENT" });
  });

  it("rejects a non-string documentId with 400", async () => {
    const res = makeRes();
    await handleResolveDocxConflict(
      makeReq({ documentId: 123, choice: "reload" }),
      res as unknown as Response,
    );

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ error: "BAD_REQUEST" });
  });

  it("falls back to the active doc when documentId is absent", async () => {
    const { id, doc } = await flaggedDocx("fallback.docx", "Fallback disk body");
    setActiveDocId(id);

    const res = makeRes();
    await handleResolveDocxConflict(makeReq({ choice: "reload" }), res as unknown as Response);

    expect(res._status).toBe(0);
    expect(conflictOf(doc)).toBeUndefined();
    expect(extractText(doc)).toContain("Fallback disk body");
  });

  it("rejects an invalid choice with 400", async () => {
    const res = makeRes();
    await handleResolveDocxConflict(makeReq({ choice: "nope" }), res as unknown as Response);

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ error: "BAD_REQUEST" });
  });
});

// ---------------------------------------------------------------------------
// Session restore — restore-vs-reload detection
// ---------------------------------------------------------------------------
describe("docx session restore (#1069)", () => {
  it("restores a dirty session over an UNCHANGED file and flags unsaved-restore (diskChanged: false)", async () => {
    const filePath = path.join(tmpDir, "restore-unchanged.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("Stable disk"));

    const first = await openFileByPath(filePath);
    const doc = getOrCreateDocument(first.documentId);
    makeDirty(doc);
    await saveSession(filePath, "docx", doc, { dirty: true });
    removeDoc(first.documentId);
    setActiveDocId(null);

    const second = await openFileByPath(filePath);
    expect(second.restoredFromSession).toBe(true);
    const restoredDoc = getOrCreateDocument(second.documentId);
    expect(conflictOf(restoredDoc)).toMatchObject({
      kind: "unsaved-restore",
      diskChanged: false,
    });

    // The restored session re-arms the module-state dirty flag (lost across
    // restarts), so a SUBSEQUENT external change flags instead of auto-
    // reloading over the only copy of the restored unsaved edits.
    const textBefore = extractText(restoredDoc);
    await fs.writeFile(filePath, await buildSimpleDocx("Post-restore external rewrite"));
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    await capturedWatcherCallback(watcherPath)(watcherPath);
    expect(extractText(restoredDoc)).toBe(textBefore);
    expect(conflictOf(restoredDoc)).toMatchObject({ kind: "external-edit" });
  });

  it("restores a dirty session over a CHANGED file (no silent data loss) and flags diskChanged: true", async () => {
    const filePath = path.join(tmpDir, "restore-changed.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("Old disk"));

    const first = await openFileByPath(filePath);
    const doc = getOrCreateDocument(first.documentId);
    makeDirty(doc);
    await saveSession(filePath, "docx", doc, { dirty: true });
    removeDoc(first.documentId);
    setActiveDocId(null);

    // External rewrite + explicit mtime bump (filesystem mtime granularity).
    await fs.writeFile(filePath, await buildSimpleDocx("New disk"));
    await fs.utimes(filePath, new Date(), new Date(Date.now() + 10_000));

    const second = await openFileByPath(filePath);
    expect(second.restoredFromSession).toBe(true); // session is the only copy of the edits
    const restoredDoc = getOrCreateDocument(second.documentId);
    expect(extractText(restoredDoc)).toContain("local unsaved edit");
    expect(conflictOf(restoredDoc)).toMatchObject({
      kind: "unsaved-restore",
      diskChanged: true,
    });

    // The save baseline is held at the SESSION's mtime, so an explicit save is
    // blocked by the external-modification guard until the banner is resolved
    // (no pre-overwrite backup exists for binary formats).
    const blocked = await saveDocumentToDisk(second.documentId, "manual");
    expect(blocked).toMatchObject({ status: "skipped", reason: "File modified externally" });

    // "Keep my edits" re-baselines — the next explicit save proceeds.
    await resolveExternalConflict(second.documentId, "keep");
    expect(conflictOf(restoredDoc)).toBeUndefined();
    const saved = await saveDocumentToDisk(second.documentId, "manual");
    expect(saved.status).toBe("saved");
  });

  it("falls back to disk for a CLEAN session over a changed file (unchanged behavior, no flag)", async () => {
    const filePath = path.join(tmpDir, "restore-clean.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("Old disk"));

    const first = await openFileByPath(filePath);
    const doc = getOrCreateDocument(first.documentId);
    await saveSession(filePath, "docx", doc); // no dirty flag
    removeDoc(first.documentId);
    setActiveDocId(null);

    await fs.writeFile(filePath, await buildSimpleDocx("New disk"));
    await fs.utimes(filePath, new Date(), new Date(Date.now() + 10_000));

    const second = await openFileByPath(filePath);
    expect(second.restoredFromSession).toBe(false);
    expect(conflictOf(getOrCreateDocument(second.documentId))).toBeUndefined();
  });

  it("does not flag a dirty .md session (docx-only prompt)", async () => {
    const filePath = path.join(tmpDir, "restore-md.md");
    await fs.writeFile(filePath, "# Markdown");

    const first = await openFileByPath(filePath);
    const doc = getOrCreateDocument(first.documentId);
    await saveSession(filePath, "md", doc, { dirty: true });
    removeDoc(first.documentId);
    setActiveDocId(null);

    const second = await openFileByPath(filePath);
    expect(second.restoredFromSession).toBe(true);
    expect(conflictOf(getOrCreateDocument(second.documentId))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// saveSession dirty flag round-trip
// ---------------------------------------------------------------------------
describe("saveSession dirty flag", () => {
  it("persists dirty: true and omits the field when clean", async () => {
    const filePath = path.join(tmpDir, "flag.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("Body"));
    const doc = new Y.Doc();

    await saveSession(filePath, "docx", doc, { dirty: true });
    expect((await loadSession(filePath))?.dirty).toBe(true);

    await saveSession(filePath, "docx", doc, { dirty: false });
    expect((await loadSession(filePath))?.dirty).toBeUndefined();

    await saveSession(filePath, "docx", doc);
    expect((await loadSession(filePath))?.dirty).toBeUndefined();
  });
});
