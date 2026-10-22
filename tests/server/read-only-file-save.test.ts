/**
 * Ask before overwriting a file the OS marks read-only (#2273).
 *
 * Before this, the tmp+rename save replaced a `chmod 444` document silently on
 * POSIX — on every 60 s autosave. Now the save probes the file, refuses with
 * `READ_ONLY_FILE`, and raises a prompt whose state lives in server memory
 * (`documents/read-only-file.ts`), mirrored to `Y_MAP_READ_ONLY_FILE` for the
 * banner. These specs drive the real save path against a real 0444 file.
 *
 * Root passes `access(W_OK)` on any file, and dev containers often run as
 * root, so `makeReadOnly` also stubs the probe for that one path when uid is
 * 0. CI runs as a normal user and exercises the real permission check.
 */

import fsSync from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock(import("../../src/server/platform"), async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-read-only-file-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});

vi.mock(import("../../src/server/file-watcher"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
}));

import type { Request, Response } from "express";
import { resetForTesting as resetDirtyState } from "../../src/server/documents/dirty.js";
import { openFromDisk } from "../../src/server/documents/open.js";
import { resetReadOnlyFileStateForTests } from "../../src/server/documents/read-only-file.js";
import { reloadDocumentFromMarkdown } from "../../src/server/documents/reload-family.js";
import { registerDocumentTools } from "../../src/server/mcp/document.js";
import {
  autoSaveAllToDisk,
  closeDocumentById,
  saveDocumentToDisk,
} from "../../src/server/mcp/document-service.js";
import { handleResolveReadOnlyFile } from "../../src/server/mcp/routes/read-only-file.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
} from "../../src/server/notifications.js";
import { loadSession } from "../../src/server/session/manager.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  TAURI_HOSTNAME,
  Y_MAP_DOCUMENT_META,
  Y_MAP_READ_ONLY_FILE,
} from "../../src/shared/constants.js";
import { withBrowser } from "../../src/shared/origins.js";
import type { ReadOnlyFileState } from "../../src/shared/types.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";
import { clearOpenDocs } from "../helpers/doc-service.js";
import { makeRes } from "../helpers/route-recorder.js";

const POSIX = process.platform !== "win32";
const IS_ROOT = process.getuid?.() === 0;

/** Paths the root-only probe stub reports as read-only. */
const stubbedReadOnly = new Set<string>();
const realAccess = fs.access.bind(fs);

async function makeReadOnly(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o444);
  if (IS_ROOT) stubbedReadOnly.add(filePath);
}

async function makeWritable(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o644);
  stubbedReadOnly.delete(filePath);
}

function makeDirty(doc: Y.Doc, text = "local unsaved edit"): void {
  const fragment = doc.getXmlFragment("default");
  withBrowser(doc, () => {
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    p.insert(0, [t]);
    fragment.insert(fragment.length, [p]);
    t.insert(0, text);
  });
}

function promptOf(doc: Y.Doc): ReadOnlyFileState | undefined {
  return doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_READ_ONLY_FILE) as ReadOnlyFileState | undefined;
}

async function resolve(body: Record<string, unknown>) {
  const res = makeRes();
  await handleResolveReadOnlyFile(
    {
      body,
      headers: { origin: `http://${TAURI_HOSTNAME}` },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as Request,
    res as unknown as Response,
  );
  return res;
}

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;
const toolHandlers = new Map<string, ToolHandler>();
async function callTool(name: string, args: Record<string, unknown>) {
  if (toolHandlers.size === 0) {
    const capture = (n: string, ...rest: unknown[]) => {
      toolHandlers.set(n, rest[rest.length - 1] as ToolHandler);
    };
    registerDocumentTools({ tool: capture, registerTool: capture } as never);
  }
  const result = await toolHandlers.get(name)!(args);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

let tmpDir: string;

/** A dirty, open, read-only `.md` whose first autosave has been refused. */
async function refusedDoc(name = "locked.md") {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, "# Locked\n\nOriginal body.\n");
  const opened = await openFromDisk(filePath);
  const doc = getOrCreateDocument(opened.documentId);
  await makeReadOnly(filePath);
  makeDirty(doc);
  await autoSaveAllToDisk();
  return { id: opened.documentId, doc, filePath };
}

beforeEach(async () => {
  clearOpenDocs();
  resetDirtyState();
  resetNotifications();
  resetReadOnlyFileStateForTests();
  stubbedReadOnly.clear();
  vi.spyOn(fs, "access").mockImplementation(async (p, mode) => {
    if (stubbedReadOnly.has(String(p))) {
      throw Object.assign(new Error("EACCES (test stub)"), { code: "EACCES" });
    }
    return realAccess(p, mode);
  });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-read-only-file-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  // chmod back so the temp dir can be removed on every platform.
  for (const entry of await fs.readdir(tmpDir).catch(() => [])) {
    await fs.chmod(path.join(tmpDir, entry), 0o644).catch(() => {});
  }
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  await teardownFileAppDataDir();
});

describe.skipIf(!POSIX)("a read-only file is never overwritten without asking (#2273)", () => {
  it("autosave leaves the bytes untouched and raises the prompt once", async () => {
    const { doc, filePath } = await refusedDoc();

    expect(await fs.readFile(filePath, "utf-8")).toBe("# Locked\n\nOriginal body.\n");
    const first = promptOf(doc);
    expect(first).toMatchObject({ declined: false, canOverwrite: true });
    expect(getBuffer().filter((n) => n.type === "read-only-file")).toHaveLength(1);

    // A second tick neither re-stamps the episode nor touches the file.
    await autoSaveAllToDisk();
    expect(promptOf(doc)?.detectedAt).toBe(first?.detectedAt);
    expect(await fs.readFile(filePath, "utf-8")).toBe("# Locked\n\nOriginal body.\n");
  });

  it("an explicit save is refused with READ_ONLY_FILE too", async () => {
    const { id, filePath } = await refusedDoc();
    const result = await saveDocumentToDisk(id, "manual");
    expect(result).toMatchObject({ status: "skipped", skipCode: "READ_ONLY_FILE" });
    expect(await fs.readFile(filePath, "utf-8")).toBe("# Locked\n\nOriginal body.\n");
  });

  it("a refusal consumes no pre-overwrite backup", async () => {
    const { filePath } = await refusedDoc();
    const backups = path.join(process.env.TANDEM_APP_DATA_DIR!, "doc-backups");
    const entries = await fs.readdir(backups).catch(() => [] as string[]);
    for (const entry of entries) {
      const source = await fs
        .readFile(path.join(backups, entry, "source.txt"), "utf-8")
        .catch(() => "");
      expect(source.trim()).not.toBe(filePath);
    }
  });

  it("Overwrite saves the edits and the file stays read-only", async () => {
    const { id, doc, filePath } = await refusedDoc();
    const res = await resolve({
      documentId: id,
      choice: "overwrite",
      detectedAt: promptOf(doc)!.detectedAt,
    });

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ data: { outcome: "approved", save: { status: "saved" } } });
    expect(await fs.readFile(filePath, "utf-8")).toContain("local unsaved edit");
    expect(fsSync.statSync(filePath).mode & 0o777).toBe(0o444);
    expect(promptOf(doc)).toBeUndefined();

    // The approval lasts while the document stays open at this path.
    makeDirty(doc, "second edit");
    await autoSaveAllToDisk();
    expect(await fs.readFile(filePath, "utf-8")).toContain("second edit");
    expect(promptOf(doc)).toBeUndefined();
  });

  it("Not now silences autosave; an explicit save asks again", async () => {
    const { id, doc } = await refusedDoc();
    const first = promptOf(doc)!;
    const res = await resolve({ documentId: id, choice: "dismiss", detectedAt: first.detectedAt });
    expect(res._body).toMatchObject({ data: { outcome: "declined" } });
    expect(promptOf(doc)).toMatchObject({ declined: true, detectedAt: first.detectedAt });

    await autoSaveAllToDisk();
    expect(promptOf(doc)).toMatchObject({ declined: true, detectedAt: first.detectedAt });

    await saveDocumentToDisk(id, "manual");
    const again = promptOf(doc)!;
    expect(again.declined).toBe(false);
    expect(again.detectedAt).toBeGreaterThan(first.detectedAt);
  });

  it("an answer naming another episode, or none, changes nothing", async () => {
    const { id, doc, filePath } = await refusedDoc();
    const live = promptOf(doc)!.detectedAt;
    const stale = await resolve({ documentId: id, choice: "overwrite", detectedAt: live - 1 });
    expect(stale._body).toMatchObject({ data: { outcome: "stale" } });
    expect(await fs.readFile(filePath, "utf-8")).toBe("# Locked\n\nOriginal body.\n");

    // Nothing can be pre-approved before a prompt exists.
    const otherPath = path.join(tmpDir, "other.md");
    await fs.writeFile(otherPath, "Other.\n");
    const other = await openFromDisk(otherPath);
    const pre = await resolve({ documentId: other.documentId, choice: "overwrite", detectedAt: 0 });
    expect(pre._body).toMatchObject({ data: { outcome: "stale" } });
    await makeReadOnly(otherPath);
    makeDirty(getOrCreateDocument(other.documentId));
    await autoSaveAllToDisk();
    expect(await fs.readFile(otherPath, "utf-8")).toBe("Other.\n");
  });

  it("the Y.Map mirror is not trusted: a forged episode approves nothing", async () => {
    const { id, doc, filePath } = await refusedDoc();
    const forged = 42;
    doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_READ_ONLY_FILE, {
      detectedAt: forged,
      declined: false,
      canOverwrite: true,
    });
    const res = await resolve({ documentId: id, choice: "overwrite", detectedAt: forged });
    expect(res._body).toMatchObject({ data: { outcome: "stale" } });
    expect(await fs.readFile(filePath, "utf-8")).toBe("# Locked\n\nOriginal body.\n");
  });

  it("made writable outside Tandem: the next save lands, and re-protecting asks again", async () => {
    const { id, doc, filePath } = await refusedDoc();
    await resolve({ documentId: id, choice: "overwrite", detectedAt: promptOf(doc)!.detectedAt });

    await makeWritable(filePath);
    makeDirty(doc, "after unlock");
    await autoSaveAllToDisk();
    expect(await fs.readFile(filePath, "utf-8")).toContain("after unlock");

    // The writable probe dropped the approval.
    await makeReadOnly(filePath);
    makeDirty(doc, "after relock");
    await autoSaveAllToDisk();
    expect(await fs.readFile(filePath, "utf-8")).not.toContain("after relock");
    expect(promptOf(doc)).toMatchObject({ declined: false });
  });

  it("closing a refused document keeps its session, so the edits survive", async () => {
    const { id, filePath } = await refusedDoc();
    await closeDocumentById(id);
    const session = await loadSession(filePath);
    expect(session).not.toBeNull();
    expect(session?.dirty).toBe(true);
  });

  it("after Not now, tandem_save does not re-show the banner", async () => {
    const { id, doc } = await refusedDoc();
    const first = promptOf(doc)!;
    await resolve({ documentId: id, choice: "dismiss", detectedAt: first.detectedAt });
    await callTool("tandem_save", { documentId: id });
    expect(promptOf(doc)).toMatchObject({ declined: true, detectedAt: first.detectedAt });
  });

  it("a live prompt whose mirror was deleted is mirrored again on the next refusal", async () => {
    const { doc } = await refusedDoc();
    const live = promptOf(doc)!.detectedAt;
    doc.getMap(Y_MAP_DOCUMENT_META).delete(Y_MAP_READ_ONLY_FILE);
    await autoSaveAllToDisk();
    expect(promptOf(doc)).toMatchObject({ detectedAt: live, declined: false });
  });

  it("close keeps the session even when no episode is remembered (after a restart)", async () => {
    const { id, filePath } = await refusedDoc();
    resetReadOnlyFileStateForTests(); // what a restart leaves behind
    await closeDocumentById(id);
    expect((await loadSession(filePath))?.dirty).toBe(true);
  });

  it("a source-view commit stops at the refusal instead of retrying it", async () => {
    const { id, doc, filePath } = await refusedDoc();
    const first = promptOf(doc)!.detectedAt;
    await reloadDocumentFromMarkdown(id, "# Locked\n\nRewritten in source view.\n");
    expect(await fs.readFile(filePath, "utf-8")).toBe("# Locked\n\nOriginal body.\n");
    const after = promptOf(doc);
    expect(after).toMatchObject({ declined: false });
    expect(after!.detectedAt).toBeGreaterThan(first);
  });

  it("tandem_save reports READ_ONLY_FILE and offers Claude no override", async () => {
    const { id } = await refusedDoc();
    const payload = (await callTool("tandem_save", { documentId: id })).data as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({ saved: false, reason: "READ_ONLY_FILE" });
    expect(String(payload.message)).toMatch(/Overwrite in the editor's banner/);
    expect(String(payload.message)).toMatch(/Do not close the document/);
  });
});

describe("POST /api/read-only-file/resolve — request shape", () => {
  it("requires documentId, a choice and detectedAt", async () => {
    expect((await resolve({ choice: "overwrite", detectedAt: 1 }))._status).toBe(400);
    expect((await resolve({ documentId: "x", choice: "nope", detectedAt: 1 }))._status).toBe(400);
    expect((await resolve({ documentId: "x", choice: "dismiss" }))._status).toBe(400);
    const unknown = await resolve({ documentId: "not-open", choice: "dismiss", detectedAt: 1 });
    expect(unknown._status).toBe(400);
    expect(unknown._body).toMatchObject({ error: "NO_DOCUMENT" });
  });

  it("refuses a request from an origin outside the allowlist", async () => {
    const res = makeRes();
    await handleResolveReadOnlyFile(
      {
        body: { documentId: "x", choice: "dismiss", detectedAt: 1 },
        headers: { origin: "https://evil.example" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as Request,
      res as unknown as Response,
    );
    expect(res._status).toBe(403);
  });
});

describe.skipIf(!POSIX)("Windows never offers Overwrite (#2273 security review)", () => {
  it("mirrors canOverwrite: false and refuses an overwrite answer", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const { id, doc, filePath } = await refusedDoc();
      expect(promptOf(doc)).toMatchObject({ canOverwrite: false });
      const res = await resolve({
        documentId: id,
        choice: "overwrite",
        detectedAt: promptOf(doc)!.detectedAt,
      });
      expect(res._status).toBe(400);
      expect(res._body).toMatchObject({ error: "UNSUPPORTED" });
      expect(await fs.readFile(filePath, "utf-8")).toBe("# Locked\n\nOriginal body.\n");
    } finally {
      platform.mockRestore();
    }
  });
});
