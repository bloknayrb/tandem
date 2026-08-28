/**
 * External-conflict detection + restore-vs-reload prompt (#1069, every format
 * since #1238).
 *
 * Covers:
 *  - file-watcher delivery on an externally-changed file: dirty doc → conflict
 *    flag (NO auto-reload); clean doc → reload from disk (binary-safe).
 *  - own-save suppression seam: the binary save branch arms suppressNextChange
 *    BEFORE atomicWriteBuffer (arrival-time consumption semantics are covered
 *    by tests/server/file-watcher.test.ts).
 *  - resolveExternalConflict: "keep" clears the flag + re-baselines savedAt,
 *    "reload" routes through reloadFromDisk.
 *  - session restore: a dirty session restores (even over a changed disk file)
 *    and raises the unsaved-restore flag; a clean session over a changed file
 *    falls back to disk (unchanged behavior).
 *  - saveSession persists the dirty flag.
 *
 * #1238 additions, in their own blocks below:
 *  - the widened `.md` watcher guard (the regression test for the issue);
 *  - the conflict flag as an AUTHORITATIVE save gate rather than an advisory
 *    one — including the mtime-tolerance hole that made it necessary;
 *  - the restart carry, which is where the protection used to evaporate;
 *  - `narrowConflict`'s coercion of an unvalidated session field.
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
    `tandem-test-external-conflict-${cryptoMod.randomUUID()}`,
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
import { openFromDisk } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { getAdapter } from "../../src/server/file-io/index.js";
import { suppressNextChange, watchFile } from "../../src/server/file-watcher.js";
import { registerDocumentTools } from "../../src/server/mcp/document.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import {
  closeDocumentById,
  EXTERNAL_CONFLICT_SKIP_REASON,
  getOpenDocs,
  hasDoc,
  renameDocument,
  saveCurrentSession,
  saveDocumentToDisk,
} from "../../src/server/mcp/document-service.js";
import {
  reloadDocumentFromMarkdown,
  resolveExternalConflict,
} from "../../src/server/mcp/file-opener.js";
import { handleResolveExternalConflict } from "../../src/server/mcp/routes/external-conflict.js";
import { handleSave } from "../../src/server/mcp/routes/save.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
} from "../../src/server/notifications.js";
import { loadSession, narrowConflict, saveSession } from "../../src/server/session/manager.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  TAURI_HOSTNAME,
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_SAVED_AT_VERSION,
} from "../../src/shared/constants.js";
import {
  BROWSER_ORIGIN,
  INTERNAL_ORIGIN,
  MCP_ORIGIN,
  withBrowser,
} from "../../src/shared/origins.js";
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

/**
 * Dispatch an MCP tool by name against a stub `McpServer` that just captures
 * the registered handlers. Registration is idempotent across tests (module
 * state is per-file), so the map is built once on first use.
 */
type McpToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;
const toolHandlers = new Map<string, ToolHandler>();

/** Dispatch a tool and return its decoded JSON payload (the wire shape). */
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (toolHandlers.size === 0) {
    const capture = (n: string, ...rest: unknown[]) => {
      toolHandlers.set(n, rest[rest.length - 1] as ToolHandler);
    };
    registerDocumentTools({ tool: capture, registerTool: capture } as never);
  }
  const handler = toolHandlers.get(name);
  expect(handler, `tool ${name} was not registered`).toBeDefined();
  const result = await handler!(args);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-external-conflict-"));
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

    const opened = await openFromDisk(filePath);
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

    const opened = await openFromDisk(filePath);
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

    const opened = await openFromDisk(filePath);
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
    const opened = await openFromDisk(filePath);
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

  it('"keep" tags its metadata write `internal`, so it emits no channel event', async () => {
    // Critical Rule 2: the helper choice IS the contract, and nothing else in
    // this repo checks this one. `withInternal` marks a server-owned setup
    // write — `browser` is the only origin that generates a channel event, and
    // `file-sync`/`internal` are the two the durable annotation ledger skips.
    // Resolving a conflict banner is neither a user edit nor a file sync.
    //
    // Written ahead of ADR-034 Unit 7c, which moves this function to a new
    // module. A copy-paste across a module boundary is exactly where a helper
    // gets picked wrong, and swapping `withInternal` for `withMcp` here would
    // pass typecheck, pass every other spec in this file, and be invisible to
    // all four written-down inventories — none of them looks at how a write is
    // tagged. The only other detector is a warn-only PostToolUse hook, which
    // is not a gate.
    const { id, doc } = await flaggedSetup();
    const origins: unknown[] = [];
    doc.on("afterTransaction", (txn: Y.Transaction) => origins.push(txn.origin));

    await resolveExternalConflict(id, "keep");

    expect(conflictOf(doc), "control: the write under test actually happened").toBeUndefined();
    expect(origins, "control: it wrote at all").not.toEqual([]);
    expect(origins).toContain(INTERNAL_ORIGIN);
    expect(origins, "a conflict resolution is not a browser edit").not.toContain(BROWSER_ORIGIN);
    expect(origins, "nor an MCP write").not.toContain(MCP_ORIGIN);
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
    const opened = await openFromDisk(filePath);
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

  it('"keep" resolves normally when the passed detectedAt matches the pending conflict', async () => {
    const { filePath, id, doc } = await flaggedSetup();
    const matchingDetectedAt = conflictOf(doc)!.detectedAt;

    await resolveExternalConflict(id, "keep", matchingDetectedAt);

    expect(conflictOf(doc)).toBeUndefined();
    const stat = await fs.stat(filePath);
    const savedAt = doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION) as number;
    expect(savedAt).toBe(stat.mtimeMs);
  });

  it('"keep" no-ops when the passed detectedAt does not match the currently-pending conflict (episode race, #1238)', async () => {
    // Race regression (review finding): the user saw conflict A (the client
    // has A.detectedAt in hand), clicked "Keep"; before the request lands, a
    // second external write replaces the pending conflict with a DIFFERENT
    // episode B. Resolving whatever is CURRENTLY pending under A's semantics
    // would silently accept B's disk state as the new baseline — the user
    // never saw a banner for B. Simulated with a direct map write (not a
    // second watcher trigger) so the two episodes have deterministic, distinct
    // `detectedAt` values regardless of test-run timing.
    const { id, doc } = await flaggedSetup();
    const staleDetectedAt = conflictOf(doc)!.detectedAt;
    const textAtStaleClick = extractText(doc);
    const baselineBeforeStaleClick = doc
      .getMap(Y_MAP_DOCUMENT_META)
      .get(Y_MAP_SAVED_AT_VERSION) as number;

    const newerConflict: ExternalConflictState = {
      kind: "external-edit",
      diskChanged: true,
      detectedAt: staleDetectedAt + 1000,
    };
    doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_EXTERNAL_CONFLICT, newerConflict);

    await resolveExternalConflict(id, "keep", staleDetectedAt);

    // No-op: the newer conflict (B) survives untouched, content is unaffected,
    // and the savedAt baseline is NOT re-stamped (a stale "keep" must not
    // unblock a save the user hasn't actually accepted for episode B).
    expect(conflictOf(doc)).toEqual(newerConflict);
    expect(extractText(doc)).toBe(textAtStaleClick);
    expect(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION)).toBe(
      baselineBeforeStaleClick,
    );
  });
});

// ---------------------------------------------------------------------------
// handleResolveExternalConflict — route-level doc selection (#1162)
//
// The banner is per-tab and the server's active doc does NOT track the client's
// focused tab, so the handler must resolve the conflict on the body's
// `documentId`, not on `getActiveDocId()`. Regression: on an upgrade boot the
// read-only CHANGELOG.md becomes server-active, and clicking "Reload from file"
// on a restored .docx tab silently no-op'd because the handler resolved the
// active (CHANGELOG) doc instead of the docx.
// ---------------------------------------------------------------------------
describe("handleResolveExternalConflict — route doc selection", () => {
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
    return {
      body,
      headers: { origin: `http://${TAURI_HOSTNAME}` },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as Request;
  }

  /** Open a docx, dirty it, deliver an external change → pending conflict flag. */
  async function flaggedDocx(name: string, diskBody: string) {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, await buildSimpleDocx("Original"));
    const opened = await openFromDisk(filePath);
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
    const other = await openFromDisk(otherPath);
    setActiveDocId(other.documentId);
    expect(hasDoc(docxId)).toBe(true);

    const res = makeRes();
    await handleResolveExternalConflict(
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
    await handleResolveExternalConflict(
      makeReq({ documentId: "does-not-exist", choice: "reload" }),
      res as unknown as Response,
    );

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ error: "NO_DOCUMENT" });
  });

  it("rejects a non-string documentId with 400", async () => {
    const res = makeRes();
    await handleResolveExternalConflict(
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
    await handleResolveExternalConflict(makeReq({ choice: "reload" }), res as unknown as Response);

    expect(res._status).toBe(0);
    expect(conflictOf(doc)).toBeUndefined();
    expect(extractText(doc)).toContain("Fallback disk body");
  });

  it("treats an empty-string documentId as absent (falls back to the active doc)", async () => {
    // The `documentId.length > 0` / `documentId?.length` ladder deliberately
    // treats "" as "not supplied" rather than an invalid id — pin it so a
    // refactor (e.g. to `documentId ?? getActiveDocId()`) can't silently change it.
    const { id, doc } = await flaggedDocx("empty-id.docx", "Empty-id disk body");
    setActiveDocId(id);

    const res = makeRes();
    await handleResolveExternalConflict(
      makeReq({ documentId: "", choice: "reload" }),
      res as unknown as Response,
    );

    expect(res._status).toBe(0);
    expect(conflictOf(doc)).toBeUndefined();
    expect(extractText(doc)).toContain("Empty-id disk body");
  });

  it("forwards choice 'keep' for the body documentId (clears flag, retains edits, re-baselines)", async () => {
    // Every other handler test uses "reload"; this proves the handler forwards
    // the validated `choice` rather than hard-coding/swapping it.
    const { id, doc } = await flaggedDocx("keep.docx", "Keep disk body");
    setActiveDocId(null); // no active doc — proves the body id is what's used
    const textBefore = extractText(doc);

    const res = makeRes();
    await handleResolveExternalConflict(
      makeReq({ documentId: id, choice: "keep" }),
      res as unknown as Response,
    );

    expect(res._status).toBe(0);
    expect(res._body).toMatchObject({ success: true });
    expect(conflictOf(doc)).toBeUndefined();
    expect(extractText(doc)).toBe(textBefore); // edits kept, NOT reloaded
    expect(extractText(doc)).toContain("local unsaved edit");
    // savedAt re-baselined so a subsequent explicit save is unblocked.
    expect(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION)).toBeGreaterThan(0);
  });

  it("rejects an invalid choice with 400", async () => {
    const res = makeRes();
    await handleResolveExternalConflict(makeReq({ choice: "nope" }), res as unknown as Response);

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ error: "BAD_REQUEST" });
  });

  it("rejects a non-number detectedAt with 400", async () => {
    const res = makeRes();
    await handleResolveExternalConflict(
      makeReq({ choice: "keep", detectedAt: "not-a-number" }),
      res as unknown as Response,
    );

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ error: "BAD_REQUEST" });
  });

  it("forwards a matching detectedAt through to resolveExternalConflict (resolves normally)", async () => {
    const { id, doc } = await flaggedDocx("detected-at-match.docx", "Matching disk body");
    const matchingDetectedAt = conflictOf(doc)!.detectedAt;

    const res = makeRes();
    await handleResolveExternalConflict(
      makeReq({ documentId: id, choice: "reload", detectedAt: matchingDetectedAt }),
      res as unknown as Response,
    );

    expect(res._status).toBe(0);
    expect(res._body).toMatchObject({ success: true });
    expect(conflictOf(doc)).toBeUndefined();
    expect(extractText(doc)).toContain("Matching disk body");
  });

  it("no-ops via a stale detectedAt (episode race, #1238) instead of resolving the wrong conflict", async () => {
    const { id, doc } = await flaggedDocx("detected-at-stale.docx", "First disk body");
    const staleDetectedAt = conflictOf(doc)!.detectedAt;

    // A second external write replaces the pending conflict with a newer
    // episode before the (stale) request is handled.
    const newerConflict: ExternalConflictState = {
      kind: "external-edit",
      diskChanged: true,
      detectedAt: staleDetectedAt + 1000,
    };
    doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_EXTERNAL_CONFLICT, newerConflict);
    const textBeforeStaleRequest = extractText(doc);

    const res = makeRes();
    await handleResolveExternalConflict(
      makeReq({ documentId: id, choice: "reload", detectedAt: staleDetectedAt }),
      res as unknown as Response,
    );

    // The route still reports success (a no-op is a valid outcome, same as
    // the "no conflict pending" case), but the newer conflict and content
    // must survive untouched — "reload" for the stale episode never fired.
    expect(res._status).toBe(0);
    expect(res._body).toMatchObject({ success: true });
    expect(conflictOf(doc)).toEqual(newerConflict);
    expect(extractText(doc)).toBe(textBeforeStaleRequest);
  });
});

// ---------------------------------------------------------------------------
// Session restore — restore-vs-reload detection
// ---------------------------------------------------------------------------
describe("docx session restore (#1069)", () => {
  it("restores a dirty session over an UNCHANGED file and flags unsaved-restore (diskChanged: false)", async () => {
    const filePath = path.join(tmpDir, "restore-unchanged.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("Stable disk"));

    const first = await openFromDisk(filePath);
    const doc = getOrCreateDocument(first.documentId);
    makeDirty(doc);
    await saveSession(filePath, "docx", doc, { dirty: true });
    removeDoc(first.documentId);
    setActiveDocId(null);

    const second = await openFromDisk(filePath);
    expect(second.kind).toBe("restored");
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

    const first = await openFromDisk(filePath);
    const doc = getOrCreateDocument(first.documentId);
    makeDirty(doc);
    await saveSession(filePath, "docx", doc, { dirty: true });
    removeDoc(first.documentId);
    setActiveDocId(null);

    // External rewrite + explicit mtime bump (filesystem mtime granularity).
    await fs.writeFile(filePath, await buildSimpleDocx("New disk"));
    await fs.utimes(filePath, new Date(), new Date(Date.now() + 10_000));

    const second = await openFromDisk(filePath);
    expect(second.kind).toBe("restored"); // session is the only copy of the edits
    const restoredDoc = getOrCreateDocument(second.documentId);
    expect(extractText(restoredDoc)).toContain("local unsaved edit");
    expect(conflictOf(restoredDoc)).toMatchObject({
      kind: "unsaved-restore",
      diskChanged: true,
    });

    // An explicit save is blocked until the banner is resolved. Since #1238 the
    // conflict flag itself is what blocks (`diskChanged: true` → every source),
    // reported ahead of the mtime guard that used to be the only thing holding
    // this line. Both would fire here; the flag is checked first because it is
    // the one that stays correct when the mtime heuristic is defeated.
    const blocked = await saveDocumentToDisk(second.documentId, "manual");
    expect(blocked).toMatchObject({
      status: "skipped",
      reason: EXTERNAL_CONFLICT_SKIP_REASON,
    });

    // "Keep my edits" re-baselines — the next explicit save proceeds.
    await resolveExternalConflict(second.documentId, "keep");
    expect(conflictOf(restoredDoc)).toBeUndefined();
    const saved = await saveDocumentToDisk(second.documentId, "manual");
    expect(saved.status).toBe("saved");
  });

  it("falls back to disk for a CLEAN session over a changed file (unchanged behavior, no flag)", async () => {
    const filePath = path.join(tmpDir, "restore-clean.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("Old disk"));

    const first = await openFromDisk(filePath);
    const doc = getOrCreateDocument(first.documentId);
    await saveSession(filePath, "docx", doc); // no dirty flag
    removeDoc(first.documentId);
    setActiveDocId(null);

    await fs.writeFile(filePath, await buildSimpleDocx("New disk"));
    await fs.utimes(filePath, new Date(), new Date(Date.now() + 10_000));

    const second = await openFromDisk(filePath);
    expect(second.kind).not.toBe("restored");
    expect(conflictOf(getOrCreateDocument(second.documentId))).toBeUndefined();
  });

  it("does not flag a dirty .md session when the disk is unchanged and autosave can resolve it", async () => {
    const filePath = path.join(tmpDir, "restore-md.md");
    await fs.writeFile(filePath, "# Markdown");

    const first = await openFromDisk(filePath);
    const doc = getOrCreateDocument(first.documentId);
    await saveSession(filePath, "md", doc, { dirty: true });
    removeDoc(first.documentId);
    setActiveDocId(null);

    // Still no prompt after #1238 widened the path — but for a narrower reason
    // than "docx only". `.md` is autosaveable and the disk didn't change, so
    // the next 60s tick persists the restored edits with nothing to choose
    // between. A prompt here would be a choice with only one branch.
    const second = await openFromDisk(filePath);
    expect(second.kind).toBe("restored");
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

// ===========================================================================
// #1238 — the same protection, every format
// ===========================================================================

// ---------------------------------------------------------------------------
// Watcher delivery on a text format
// ---------------------------------------------------------------------------
describe("watcher — external change with unsaved edits (.md, #1238)", () => {
  it("flags an external-edit conflict and does NOT reload the content", async () => {
    const filePath = path.join(tmpDir, "conflict.md");
    await fs.writeFile(filePath, "# Original body");

    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];

    makeDirty(doc);
    const textBefore = extractText(doc);
    expect(textBefore).toContain("local unsaved edit");

    await fs.writeFile(filePath, "# External rewrite");
    await capturedWatcherCallback(watcherPath)(watcherPath);

    // Before #1238 this reloaded unconditionally, discarding the edits with no
    // undo path (server writes arrive as remote updates, which y-prosemirror's
    // UndoManager does not track).
    expect(conflictOf(doc)).toMatchObject({ kind: "external-edit", diskChanged: true });
    expect(extractText(doc)).toBe(textBefore);
    expect(extractText(doc)).not.toContain("External rewrite");

    const note = getBuffer().find((n) => n.type === "external-conflict");
    expect(note).toBeDefined();
    expect(note!.severity).toBe("warning");
    expect(note!.documentId).toBe(opened.documentId);
  });

  it("still reloads a CLEAN .md silently and refreshes the save baseline", async () => {
    const filePath = path.join(tmpDir, "clean-reload.md");
    await fs.writeFile(filePath, "# First version");

    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];

    await fs.writeFile(filePath, "# Second version");
    const stat = await fs.stat(filePath);
    await capturedWatcherCallback(watcherPath)(watcherPath);

    // The unchanged half of the behaviour. A regression here ("external changes
    // never appear again") would be louder than the bug #1238 fixed.
    expect(extractText(doc)).toContain("Second version");
    expect(conflictOf(doc)).toBeUndefined();
    expect(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION)).toBe(stat.mtimeMs);
  });

  it("reloads a READ-ONLY document even when dirty (a banner there has no working branch)", async () => {
    const filePath = path.join(tmpDir, "readonly.md");
    await fs.writeFile(filePath, "# Read only original");

    const opened = await openFromDisk(filePath, { readOnly: true });
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    makeDirty(doc);

    await fs.writeFile(filePath, "# Read only rewrite");
    await capturedWatcherCallback(watcherPath)(watcherPath);

    // A read-only doc refuses every save path, so "Keep my edits" would clear
    // the banner and still leave the edits unsavable. Reload is the honest
    // outcome.
    expect(conflictOf(doc)).toBeUndefined();
    expect(extractText(doc)).toContain("Read only rewrite");
  });
});

// ---------------------------------------------------------------------------
// The flag as an authoritative save gate
// ---------------------------------------------------------------------------
describe("conflict flag blocks saves (#1238)", () => {
  /** Flag a `.md` conflict WITHOUT bumping mtime past the guard's tolerance. */
  async function flaggedWithinTolerance() {
    const filePath = path.join(tmpDir, "gate.md");
    await fs.writeFile(filePath, "# Disk body");
    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    makeDirty(doc);
    await fs.writeFile(filePath, "# Newer disk body");
    await capturedWatcherCallback(watcherPath)(watcherPath);
    expect(conflictOf(doc)).toMatchObject({ kind: "external-edit", diskChanged: true });

    // Re-baseline SAVED_AT_VERSION to NOW so the mtime guard
    // (`mtimeMs > lastSavedAt + 1000`) reads the file as unmodified. This is
    // the hole the flag exists to close: an external write landing inside the
    // 1s tolerance, a rename re-baselining, or initSavedBaseline after a
    // restart all reach exactly this state. Without the flag gate the next
    // save silently overwrites the external file with the banner still up.
    withBrowser(doc, () => {
      doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_SAVED_AT_VERSION, Date.now());
    });
    return { filePath, id: opened.documentId, doc };
  }

  it("blocks auto-save, Ctrl+S and MCP saves alike, and leaves the disk file intact", async () => {
    const { filePath, id } = await flaggedWithinTolerance();

    for (const source of ["auto-save", "manual", "mcp"] as const) {
      expect(await saveDocumentToDisk(id, source)).toMatchObject({
        status: "skipped",
        reason: EXTERNAL_CONFLICT_SKIP_REASON,
      });
    }
    expect(await fs.readFile(filePath, "utf-8")).toBe("# Newer disk body");
  });

  it("unblocks after the user resolves the conflict", async () => {
    const { id, doc } = await flaggedWithinTolerance();

    await resolveExternalConflict(id, "keep");
    expect(conflictOf(doc)).toBeUndefined();
    expect((await saveDocumentToDisk(id, "manual")).status).toBe("saved");
  });

  it('"reload" on a flagged .md loads the disk content and clears the flag', async () => {
    const { id, doc } = await flaggedWithinTolerance();

    await resolveExternalConflict(id, "reload");

    expect(conflictOf(doc)).toBeUndefined();
    expect(extractText(doc)).toContain("Newer disk body");
    expect(extractText(doc)).not.toContain("local unsaved edit");
  });

  it("still permits an explicit save on an unsaved-restore over an UNCHANGED disk", async () => {
    // The one case the `diskChanged` discriminator deliberately leaves open:
    // nothing on disk diverged, so an explicit Ctrl+S is unambiguous intent.
    // This is the pre-#1238 .docx behaviour, preserved.
    const filePath = path.join(tmpDir, "restore-then-save.docx");
    await fs.writeFile(filePath, await buildSimpleDocx("Stable disk"));

    const first = await openFromDisk(filePath);
    const doc = getOrCreateDocument(first.documentId);
    makeDirty(doc);
    await saveSession(filePath, "docx", doc, { dirty: true });
    removeDoc(first.documentId);
    setActiveDocId(null);

    const second = await openFromDisk(filePath);
    const restoredDoc = getOrCreateDocument(second.documentId);
    expect(conflictOf(restoredDoc)).toMatchObject({
      kind: "unsaved-restore",
      diskChanged: false,
    });

    expect((await saveDocumentToDisk(second.documentId, "manual")).status).toBe("saved");
    expect(conflictOf(restoredDoc)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Session restore + the restart carry
// ---------------------------------------------------------------------------
describe("session restore across a restart (#1238)", () => {
  it("restores a dirty .md session over a CHANGED disk file instead of dropping it", async () => {
    const filePath = path.join(tmpDir, "restore-changed.md");
    await fs.writeFile(filePath, "# Old disk");

    const first = await openFromDisk(filePath);
    const doc = getOrCreateDocument(first.documentId);
    makeDirty(doc);
    await saveSession(filePath, "md", doc, { dirty: true });
    removeDoc(first.documentId);
    setActiveDocId(null);

    await fs.writeFile(filePath, "# New disk");
    await fs.utimes(filePath, new Date(), new Date(Date.now() + 10_000));

    const second = await openFromDisk(filePath);
    // Pre-#1238 this took disk and silently dropped the session — the same
    // data loss as the watcher path, just at the restart boundary.
    expect(second.kind).toBe("restored");
    const restoredDoc = getOrCreateDocument(second.documentId);
    expect(extractText(restoredDoc)).toContain("local unsaved edit");
    expect(conflictOf(restoredDoc)).toMatchObject({
      kind: "unsaved-restore",
      diskChanged: true,
    });
  });

  it("carries an unresolved conflict across a restart with its original kind", async () => {
    // The restart-laundering regression. saveSession stats the file at save
    // time, so on reopen `sourceFileChanged` reads FALSE — the conflict cannot
    // be re-derived and must be carried in the session. Without the carry,
    // reopening a conflicted .md clears the banner and the next 60s tick
    // overwrites the external file.
    const filePath = path.join(tmpDir, "carry.md");
    await fs.writeFile(filePath, "# Disk body");

    const first = await openFromDisk(filePath);
    const doc = getOrCreateDocument(first.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    makeDirty(doc);
    await fs.writeFile(filePath, "# External rewrite");
    await capturedWatcherCallback(watcherPath)(watcherPath);
    expect(conflictOf(doc)).toMatchObject({ kind: "external-edit" });

    await saveCurrentSession();
    expect((await loadSession(filePath))?.conflict).toMatchObject({
      kind: "external-edit",
      diskChanged: true,
    });

    removeDoc(first.documentId);
    setActiveDocId(null);
    // Note: the file is NOT touched again — the whole point is that the
    // restore path has no disk-level evidence a conflict ever happened.
    const second = await openFromDisk(filePath);
    const restoredDoc = getOrCreateDocument(second.documentId);

    // Re-flagged verbatim, not rewritten to "unsaved-restore".
    expect(conflictOf(restoredDoc)).toMatchObject({
      kind: "external-edit",
      diskChanged: true,
    });
    // And still authoritative: `initSavedBaseline` has re-baselined the mtime
    // guard to the EXTERNAL write's own mtime, so the flag is the only thing
    // left holding the line.
    expect(await saveDocumentToDisk(second.documentId, "auto-save")).toMatchObject({
      status: "skipped",
      reason: EXTERNAL_CONFLICT_SKIP_REASON,
    });
    expect(await fs.readFile(filePath, "utf-8")).toBe("# External rewrite");
  });

  it("does NOT carry a conflict the save already resolved", async () => {
    // saveSession runs BEFORE the flag delete on the success path, so a
    // self-read inside saveSession would persist a conflict that no longer
    // exists — re-raising a banner on a clean, in-sync document after a crash.
    const filePath = path.join(tmpDir, "resolved.md");
    await fs.writeFile(filePath, "# Disk body");

    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    makeDirty(doc);
    await fs.writeFile(filePath, "# External rewrite");
    await capturedWatcherCallback(watcherPath)(watcherPath);

    await resolveExternalConflict(opened.documentId, "keep");
    expect((await saveDocumentToDisk(opened.documentId, "manual")).status).toBe("saved");

    await saveCurrentSession();
    expect((await loadSession(filePath))?.conflict).toBeUndefined();
  });

  it("carries a conflict across a rename, whose mtime re-baseline would otherwise launder it", async () => {
    const filePath = path.join(tmpDir, "rename-carry.md");
    await fs.writeFile(filePath, "# Disk body");

    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    makeDirty(doc);
    await fs.writeFile(filePath, "# External rewrite");
    await capturedWatcherCallback(watcherPath)(watcherPath);
    expect(conflictOf(doc)).toBeDefined();

    const renamed = await renameDocument(opened.documentId, "renamed-carry.md");
    expect(renamed.status).toBe("renamed");
    const newPath = path.join(tmpDir, "renamed-carry.md");

    expect((await loadSession(newPath))?.conflict).toMatchObject({ kind: "external-edit" });

    removeDoc(opened.documentId);
    setActiveDocId(null);
    const second = await openFromDisk(newPath);
    expect(conflictOf(getOrCreateDocument(second.documentId))).toMatchObject({
      kind: "external-edit",
    });
  });

  it("carries a conflict through a READ-ONLY reopen instead of destroying it", async () => {
    // Suppressing the carry for a read-only doc does not defer it, it destroys
    // it: writeDocMeta tombstones the flag out of the restored Y.Doc, and the
    // next session write (60s tick / shutdown — neither filters read-only
    // docs) rewrites `conflict` from that now-empty doc. Reopening writable
    // afterwards would then find no flag and autosave over the external
    // change. Reachable via View Changelog or POST /api/open {readOnly:true}.
    const filePath = path.join(tmpDir, "readonly-carry.md");
    await fs.writeFile(filePath, "# Disk body");

    const first = await openFromDisk(filePath);
    const doc = getOrCreateDocument(first.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    makeDirty(doc);
    await fs.writeFile(filePath, "# External rewrite");
    await capturedWatcherCallback(watcherPath)(watcherPath);
    await saveCurrentSession();
    removeDoc(first.documentId);
    setActiveDocId(null);

    // Reopen read-only, then let a session write happen while it is open.
    const ro = await openFromDisk(filePath, { readOnly: true });
    expect(conflictOf(getOrCreateDocument(ro.documentId))).toMatchObject({
      kind: "external-edit",
    });
    await saveCurrentSession();
    expect((await loadSession(filePath))?.conflict).toMatchObject({ kind: "external-edit" });
    removeDoc(ro.documentId);
    setActiveDocId(null);

    // Reopen writable: the conflict must still be there, and still blocking.
    const rw = await openFromDisk(filePath);
    expect(conflictOf(getOrCreateDocument(rw.documentId))).toMatchObject({
      kind: "external-edit",
    });
    expect(await saveDocumentToDisk(rw.documentId, "auto-save")).toMatchObject({
      status: "skipped",
      reason: EXTERNAL_CONFLICT_SKIP_REASON,
    });
    expect(await fs.readFile(filePath, "utf-8")).toBe("# External rewrite");
  });

  it("does not silently reload a READ-ONLY document that already has a pending conflict", async () => {
    // Composition bug (review finding): the previous test shows a carried
    // conflict IS correctly re-raised on a read-only reopen, which means a doc
    // can be simultaneously read-only, dirty, AND conflict-pending. The
    // ORIGINAL watcher gate (`isDirty && !readOnly`) evaluates `true && false`
    // there and falls into the reload branch on any FURTHER external write —
    // silently destroying the still-unresolved edits. This is exactly the
    // class of bug #1238 exists to prevent, reintroduced by composing two
    // individually-correct changes.
    const filePath = path.join(tmpDir, "readonly-composition.md");
    await fs.writeFile(filePath, "# Disk body");

    const first = await openFromDisk(filePath);
    const doc = getOrCreateDocument(first.documentId);
    makeDirty(doc);
    await fs.writeFile(filePath, "# External rewrite");
    await capturedWatcherCallback(filePath)(filePath);
    await saveCurrentSession();
    removeDoc(first.documentId);
    setActiveDocId(null);

    // Reopen read-only: carries the conflict (per the previous test).
    const ro = await openFromDisk(filePath, { readOnly: true });
    const roDoc = getOrCreateDocument(ro.documentId);
    expect(conflictOf(roDoc)).toMatchObject({ kind: "external-edit" });
    const contentBeforeThirdWrite = extractText(roDoc);

    // A THIRD write lands on disk while the read-only tab is still open.
    await fs.writeFile(filePath, "# Yet another external rewrite");
    await capturedWatcherCallback(filePath)(filePath);

    // The still-unresolved edits must survive — no silent reload — and the
    // conflict must still be flagged (not clobbered by a no-op reload branch).
    expect(extractText(roDoc)).toBe(contentBeforeThirdWrite);
    expect(conflictOf(roDoc)).toMatchObject({ kind: "external-edit" });
  });

  it("preserves a NEWER conflict flagged while a 'reload' resolve is still in flight", async () => {
    // Race regression (review finding): reloadFromDisk's fs.stat/fs.readFile
    // are async, so a DISTINCT external write can get flagged by the watcher
    // while a "Reload from file" click is still in progress. The completing
    // reload used to unconditionally delete Y_MAP_EXTERNAL_CONFLICT afterward,
    // silently wiping a newer, real conflict for content the reload never saw.
    const filePath = path.join(tmpDir, "race.md");
    await fs.writeFile(filePath, "# Disk body v1");

    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    makeDirty(doc);
    await fs.writeFile(filePath, "# Disk body v2 (external edit A)");
    await capturedWatcherCallback(filePath)(filePath);
    expect(conflictOf(doc)).toMatchObject({ kind: "external-edit" });

    const originalReadFile = fs.readFile;
    const readFileSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementationOnce(async (...args: Parameters<typeof fs.readFile>) => {
        // Simulate a SECOND, later external write racing in while THIS
        // reload's read is in flight — exactly what the file watcher would do
        // on its own if it fired here.
        await fs.writeFile(filePath, "# Disk body v3 (external edit B, races the reload)");
        doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_EXTERNAL_CONFLICT, {
          kind: "external-edit",
          diskChanged: true,
          detectedAt: 999,
        } satisfies ExternalConflictState);
        return (
          originalReadFile as (
            ...a: Parameters<typeof fs.readFile>
          ) => ReturnType<typeof fs.readFile>
        )(...args);
      });
    try {
      await resolveExternalConflict(opened.documentId, "reload");
    } finally {
      readFileSpy.mockRestore();
    }

    // The newer conflict (B) must survive the reload that raced against it —
    // NOT be silently cleared as if the reload had resolved it.
    expect(conflictOf(doc)).toMatchObject({ kind: "external-edit", detectedAt: 999 });
  });

  it("preserves a NEWER conflict flagged while an autosave's write is still in flight", async () => {
    // Same race, at the OTHER call site (review finding covered both):
    // saveDocumentToDisk's atomicWrite is async, so a distinct external write
    // can get flagged while a save is in flight. The save's completion used to
    // unconditionally clear the flag.
    const filePath = path.join(tmpDir, "race-save.md");
    await fs.writeFile(filePath, "# Disk body v1");

    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    // No conflict pending yet — saveDocumentToDisk's own gate only blocks when
    // one IS pending; this exercises the race for a save that starts clean.
    makeDirty(doc);

    const originalStat = fs.stat;
    const statSpy = vi
      .spyOn(fs, "stat")
      .mockImplementationOnce(async (...args: Parameters<typeof fs.stat>) => {
        // A NEW external write lands and gets flagged while this save's
        // pre-write mtime check is in flight.
        doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_EXTERNAL_CONFLICT, {
          kind: "external-edit",
          diskChanged: true,
          detectedAt: 888,
        } satisfies ExternalConflictState);
        return (originalStat as (...a: Parameters<typeof fs.stat>) => ReturnType<typeof fs.stat>)(
          ...args,
        );
      });
    try {
      const result = await saveDocumentToDisk(opened.documentId, "manual");
      expect(result.status).toBe("saved");
    } finally {
      statSpy.mockRestore();
    }

    // The conflict flagged mid-write must survive the save that raced against
    // it — the save resolved a divergence it never saw, not this one.
    expect(conflictOf(doc)).toMatchObject({ kind: "external-edit", detectedAt: 888 });
  });

  it("prompts for a dirty .html session even over an UNCHANGED file", async () => {
    // .html is in neither AUTO_SAVE_FORMATS nor BINARY_SAVE_FORMATS, so
    // saveDocumentToDisk refuses it outright — nothing will ever persist these
    // edits on its own. That is a real choice to surface, unlike the .md case
    // above where the next autosave tick resolves it.
    const filePath = path.join(tmpDir, "restore.html");
    await fs.writeFile(filePath, "<p>Stable disk</p>");

    const first = await openFromDisk(filePath);
    const doc = getOrCreateDocument(first.documentId);
    makeDirty(doc);
    await saveSession(filePath, "html", doc, { dirty: true });
    removeDoc(first.documentId);
    setActiveDocId(null);

    const second = await openFromDisk(filePath);
    expect(second.kind).toBe("restored");
    expect(conflictOf(getOrCreateDocument(second.documentId))).toMatchObject({
      kind: "unsaved-restore",
      diskChanged: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Surfaces that must not resolve a conflict behind the user's back (#1238)
// ---------------------------------------------------------------------------
describe("conflict-adjacent surfaces", () => {
  /** Flag a conflict on an open .md and return its handles. */
  async function flagged(name: string) {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, "# Disk body");
    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    makeDirty(doc);
    await fs.writeFile(filePath, "# External rewrite");
    await capturedWatcherCallback(watcherPath)(watcherPath);
    expect(conflictOf(doc)).toBeDefined();
    return { filePath, id: opened.documentId, doc };
  }

  it("refuses a source-view commit while a conflict is pending", async () => {
    const { filePath, id } = await flagged("sourceview.md");

    // clearAndReload would delete the flag and re-baseline the mtime guard, so
    // an allowed commit would resolve the conflict silently in the "keep"
    // direction and then overwrite the external file — reversing a "Reload
    // from file" the user may already have chosen against a stale textarea.
    await expect(reloadDocumentFromMarkdown(id, "# Stale draft")).rejects.toMatchObject({
      code: "EXTERNAL_CONFLICT",
    });
    expect(await fs.readFile(filePath, "utf-8")).toBe("# External rewrite");
    expect(conflictOf(getOrCreateDocument(id))).toBeDefined();

    // Resolving unblocks it — the refusal is a gate, not a dead end.
    await resolveExternalConflict(id, "keep");
    await expect(reloadDocumentFromMarkdown(id, "# Deliberate draft")).resolves.toBeUndefined();
  });

  it("preserves a NEW conflict flagged during the async prepareContent gap (source-view commit race, #1238)", async () => {
    // Race regression (review finding): reloadDocumentFromMarkdown's entry
    // guard only rejects a conflict pending AT THE TIME OF THE CHECK.
    // clearAndReload then does real async work (`prepareContent`, the
    // markdown parse) before its transact deletes Y_MAP_EXTERNAL_CONFLICT — a
    // genuine external write can land and get flagged by the file watcher
    // during that gap. The unconditional delete used to silently wipe that
    // newer, real conflict for content this commit never saw.
    const filePath = path.join(tmpDir, "sourceview-race.md");
    await fs.writeFile(filePath, "# Disk body");
    const opened = await openFromDisk(filePath);
    const id = opened.documentId;
    const doc = getOrCreateDocument(id);
    expect(conflictOf(doc)).toBeUndefined();

    const adapter = getAdapter("md");
    const originalParse = adapter.parse;
    const parseSpy = vi
      .spyOn(adapter, "parse")
      .mockImplementationOnce(async (...args: Parameters<typeof adapter.parse>) => {
        // Simulate the file watcher flagging a genuinely new conflict WHILE
        // this reload's own pre-parse is in flight.
        doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_EXTERNAL_CONFLICT, {
          kind: "external-edit",
          diskChanged: true,
          detectedAt: 777,
        } satisfies ExternalConflictState);
        return originalParse.apply(adapter, args);
      });

    try {
      await reloadDocumentFromMarkdown(id, "# Edited via source view");
    } finally {
      parseSpy.mockRestore();
    }

    // The commit itself succeeded (content replaced)...
    expect(extractText(doc)).toContain("Edited via source view");
    // ...but the conflict flagged mid-reload must survive, not be silently
    // cleared as if this reload had resolved it.
    expect(conflictOf(doc)).toMatchObject({ kind: "external-edit", detectedAt: 777 });
  });

  it("clears the flag normally when NO race occurs during a source-view commit", async () => {
    // Companion to the race test above: the guard must not become an
    // unconditional refusal-to-clear. With no conflict flagged during the
    // async gap, the commit still resolves cleanly (baseline behavior).
    const filePath = path.join(tmpDir, "sourceview-no-race.md");
    await fs.writeFile(filePath, "# Disk body");
    const opened = await openFromDisk(filePath);
    const id = opened.documentId;
    const doc = getOrCreateDocument(id);

    await reloadDocumentFromMarkdown(id, "# Edited via source view, no race");

    expect(extractText(doc)).toContain("Edited via source view, no race");
    expect(conflictOf(doc)).toBeUndefined();
  });

  it("keeps the session when a conflicted tab is closed (it is the only copy)", async () => {
    const { filePath, id } = await flagged("close-conflicted.md");

    await closeDocumentById(id);

    // Saves are blocked, so these edits never reached disk. Closing must write
    // the session and keep it — merely declining to delete a session written
    // at some earlier tick would preserve a file that doesn't hold the edits.
    const session = await loadSession(filePath);
    expect(session?.conflict).toMatchObject({ kind: "external-edit" });
    expect(session?.dirty).toBe(true);

    // And it must actually round-trip: reopening restores the edits with the
    // conflict still pending.
    const reopened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(reopened.documentId);
    expect(extractText(doc)).toContain("local unsaved edit");
    expect(conflictOf(doc)).toMatchObject({ kind: "external-edit" });
  });

  it("still deletes the session when an unconflicted tab is closed", async () => {
    const filePath = path.join(tmpDir, "close-clean.md");
    await fs.writeFile(filePath, "# Disk body");
    const opened = await openFromDisk(filePath);

    await closeDocumentById(opened.documentId);

    // The unchanged half: closing normally must still forget the document.
    expect(await loadSession(filePath)).toBeNull();
  });

  it('does not re-baseline the save marker on "keep" for a format that can never be saved', async () => {
    // TabItem reads any SAVED_AT_VERSION change as "saved" — writing one for
    // .html would clear the unsaved dot on a document whose edits still exist
    // only in memory, since saveDocumentToDisk refuses .html outright.
    const filePath = path.join(tmpDir, "keep.html");
    await fs.writeFile(filePath, "<p>Disk body</p>");
    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    makeDirty(doc);
    const baselineBefore = doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION);
    await fs.writeFile(filePath, "<p>External rewrite</p>");
    await capturedWatcherCallback(watcherPath)(watcherPath);

    await resolveExternalConflict(opened.documentId, "keep");

    expect(conflictOf(doc)).toBeUndefined();
    expect(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION)).toBe(baselineBefore);
  });

  it('still re-baselines on "keep" for a saveable format', async () => {
    const { filePath, id, doc } = await flagged("keep-md.md");

    await resolveExternalConflict(id, "keep");

    const stat = await fs.stat(filePath);
    expect(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION)).toBe(stat.mtimeMs);
  });
});

// ---------------------------------------------------------------------------
// narrowConflict — the session file is unvalidated JSON
// ---------------------------------------------------------------------------
describe("narrowConflict", () => {
  it("rejects anything that is not a recognized conflict", () => {
    expect(narrowConflict(undefined)).toBeUndefined();
    expect(narrowConflict(null)).toBeUndefined();
    expect(narrowConflict("external-edit")).toBeUndefined();
    expect(narrowConflict({})).toBeUndefined();
    expect(narrowConflict({ kind: "something-else", diskChanged: true })).toBeUndefined();
  });

  it("coerces a missing/non-boolean diskChanged rather than failing open on it", () => {
    // `diskChanged` is what Change 3's save gate keys on, so a corrupted
    // session must never produce a banner that blocks nothing. Coercion, not
    // rejection: the user should still get the choice.
    expect(narrowConflict({ kind: "external-edit", detectedAt: 5 })).toMatchObject({
      kind: "external-edit",
      diskChanged: true,
      detectedAt: 5,
    });
    expect(narrowConflict({ kind: "unsaved-restore", diskChanged: "yes" })).toMatchObject({
      kind: "unsaved-restore",
      diskChanged: false,
    });
  });

  it("substitutes a timestamp when detectedAt is missing or the wrong type", () => {
    const before = Date.now();
    const narrowed = narrowConflict({ kind: "unsaved-restore", diskChanged: true });
    expect(narrowed!.detectedAt).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// tandem_save — Claude must not be told a blocked save succeeded
// ---------------------------------------------------------------------------
describe("tandem_save on a conflicted document (#1238)", () => {
  it("returns an EXTERNAL_CONFLICT error, and still persists the session first", async () => {
    const filePath = path.join(tmpDir, "mcp-save.md");
    await fs.writeFile(filePath, "# Disk body");

    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    makeDirty(doc);
    await fs.writeFile(filePath, "# External rewrite");
    await capturedWatcherCallback(watcherPath)(watcherPath);

    const result = await callTool("tandem_save", { documentId: opened.documentId });

    // `saved: true` here would be a lie Claude has no way to check, and no MCP
    // tool can resolve the conflict — it is a human keep-vs-reload choice.
    expect(result).toMatchObject({ error: true, code: "EXTERNAL_CONFLICT" });
    expect(result.saved).toBeUndefined();
    expect(await fs.readFile(filePath, "utf-8")).toBe("# External rewrite");

    // The session write must happen BEFORE the error return, or the conflict
    // carry is dead code on the path most likely to hit it.
    const session = await loadSession(filePath);
    expect(session?.dirty).toBe(true);
    expect(session?.conflict).toMatchObject({ kind: "external-edit" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/save on a conflicted document (#1238 review finding)
//
// tandem_save (document.ts) already persisted the dirty/conflict session
// carry on a skipped save; the browser's POST /api/save route did not — an
// asymmetry between the two save entry points into the same
// `saveDocumentToDisk`. Mirrors the tandem_save test above via the shared
// `persistSkippedSaveSession` helper both routes now call.
// ---------------------------------------------------------------------------
describe("POST /api/save on a conflicted document (#1238)", () => {
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
    // headers/socket are not decoration: handleSave now calls
    // assertOriginAllowlisted, which reads req.headers.origin. A bare { body }
    // threw a TypeError here rather than 403-ing, which is why this stub had to
    // grow rather than the specs being rewritten -- they are about save
    // behaviour, not about the gate.
    return {
      body,
      headers: { origin: "http://127.0.0.1:5173" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as Request;
  }

  it("leaves the session carrying dirty + conflict after a skipped save", async () => {
    const filePath = path.join(tmpDir, "api-save.md");
    await fs.writeFile(filePath, "# Disk body");

    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const watcherPath = vi.mocked(watchFile).mock.calls[0][0];
    makeDirty(doc);
    await fs.writeFile(filePath, "# External rewrite");
    await capturedWatcherCallback(watcherPath)(watcherPath);

    const res = makeRes();
    await handleSave(makeReq({ documentId: opened.documentId }), res as unknown as Response);

    // The route still reports the underlying skip result as data (unlike the
    // MCP tool, which turns it into an error) — this test is about the
    // session carry, not the HTTP response shape.
    expect(res._status).toBe(0);
    expect((res._body as { data?: { status?: string } })?.data?.status).toBe("skipped");
    expect(await fs.readFile(filePath, "utf-8")).toBe("# External rewrite");

    // Without the fix, this session would NOT carry dirty/conflict — a
    // restart would discard the only copy of the unsaved edits or silently
    // launder away the pending keep-vs-reload choice.
    const session = await loadSession(filePath);
    expect(session?.dirty).toBe(true);
    expect(session?.conflict).toMatchObject({ kind: "external-edit" });
  });

  it("does not write a stray session carry on an ordinary successful save", async () => {
    const filePath = path.join(tmpDir, "api-save-ok.md");
    await fs.writeFile(filePath, "# Disk body");
    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    makeDirty(doc);

    const res = makeRes();
    await handleSave(makeReq({ documentId: opened.documentId }), res as unknown as Response);

    expect(res._status).toBe(0);
    expect((res._body as { data?: { status?: string } })?.data?.status).toBe("saved");
    expect(conflictOf(doc)).toBeUndefined();
  });
});
