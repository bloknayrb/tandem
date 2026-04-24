import fsSync from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEmptyDoc } from "../helpers/ydoc-factory.js";

// vi.mock factories are hoisted before module-level code, so outer `const`s
// are not accessible inside them. All paths must be computed inline using
// dynamic import() inside the factory.

vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  // Use a unique subdir under the system temp dir for both sessions and
  // app-data (annotations). Set the env var here so resolveAppDataDir()
  // returns the isolated dir for the lifetime of this test file.
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-lifecycle-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return {
    ...original,
    SESSION_DIR: pathMod.join(appDataDir, "sessions"),
  };
});

// Mock file-watcher so tests can assert watchFile calls without starting real fs.watch.
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
}));

import * as fileSyncRegistryModule from "../../src/server/events/file-sync-registry.js";
import { watchFile } from "../../src/server/file-watcher.js";
import { getOpenDocs, removeDoc, setActiveDocId } from "../../src/server/mcp/document-service.js";
import { openFileByPath } from "../../src/server/mcp/file-opener.js";
import { saveSession } from "../../src/server/session/manager.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";

let tmpDir: string;

beforeEach(async () => {
  // Clear open docs state from prior tests
  for (const id of [...getOpenDocs().keys()]) {
    removeDoc(id);
  }
  setActiveDocId(null);
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-lifecycle-"));
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
// Test 1: Session restore hit
// ---------------------------------------------------------------------------
describe("session restore — hit", () => {
  it("restores from session when source file is unchanged", async () => {
    const filePath = path.join(tmpDir, "restore-hit.md");
    await fs.writeFile(filePath, "# Original content");

    // First open — populates Y.Doc and registers in open-docs
    const first = await openFileByPath(filePath);
    expect(first.restoredFromSession).toBe(false);

    // Save session state so it's available on next open
    const doc = getOrCreateDocument(first.documentId);
    await saveSession(filePath, "md", doc);

    // Close the doc
    removeDoc(first.documentId);
    setActiveDocId(null);

    // Reopen — should restore from session (file unchanged)
    const second = await openFileByPath(filePath);
    expect(second.restoredFromSession).toBe(true);
    expect(second.documentId).toBe(first.documentId);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Session stale mtime
// ---------------------------------------------------------------------------
describe("session restore — stale mtime", () => {
  it("falls back to source file when file has been modified after session save", async () => {
    const filePath = path.join(tmpDir, "restore-stale.md");
    await fs.writeFile(filePath, "# Original content");

    const first = await openFileByPath(filePath);
    const doc = getOrCreateDocument(first.documentId);
    await saveSession(filePath, "md", doc);

    removeDoc(first.documentId);
    setActiveDocId(null);

    // Rewrite the file and explicitly bump mtime so the change is detected regardless
    // of filesystem mtime resolution (Windows coarse-grained on older disks, etc).
    await fs.writeFile(filePath, "# New content after save");
    const futureMtime = new Date(Date.now() + 10_000);
    await fs.utimes(filePath, new Date(), futureMtime);

    const second = await openFileByPath(filePath);
    expect(second.restoredFromSession).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Session empty fragment
// ---------------------------------------------------------------------------
describe("session restore — empty fragment", () => {
  it("falls back to source file when saved session has an empty fragment", async () => {
    const filePath = path.join(tmpDir, "restore-empty.md");
    await fs.writeFile(filePath, "# Has real content");

    // Save a session from an empty Y.Doc — no content in the XmlFragment
    const emptyDoc = makeEmptyDoc();
    await saveSession(filePath, "md", emptyDoc);

    // Open — should detect fragment.length === 0 and fall back to source file
    const result = await openFileByPath(filePath);
    expect(result.restoredFromSession).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Annotation wiring (setFileSyncContext called)
// ---------------------------------------------------------------------------
describe("annotation wiring", () => {
  it("calls setFileSyncContext with the document id on open", async () => {
    const spy = vi.spyOn(fileSyncRegistryModule, "setFileSyncContext");

    const filePath = path.join(tmpDir, "annotation-wire.md");
    await fs.writeFile(filePath, "# Annotation wiring test");

    const result = await openFileByPath(filePath);

    expect(spy).toHaveBeenCalled();
    const firstCallArgs = spy.mock.calls[0];
    expect(firstCallArgs[0]).toBe(result.documentId);
  });
});

// ---------------------------------------------------------------------------
// Test 5: File-watcher wired for .md
// ---------------------------------------------------------------------------
describe("file-watcher — .md", () => {
  it("calls watchFile with the resolved path for a markdown file", async () => {
    const filePath = path.join(tmpDir, "watch-md.md");
    await fs.writeFile(filePath, "# Watch test");

    await openFileByPath(filePath);

    const mockWatchFile = vi.mocked(watchFile);
    expect(mockWatchFile).toHaveBeenCalled();
    // First argument should be the canonically resolved file path
    const calledPath = mockWatchFile.mock.calls[0][0];
    expect(calledPath).toBe(fsSync.realpathSync(filePath));
  });
});

// ---------------------------------------------------------------------------
// Test 6: File-watcher NOT wired for .docx
// ---------------------------------------------------------------------------
describe("file-watcher — .docx skip", () => {
  it("does not call watchFile for a .docx file and loads its content", async () => {
    // Copy a real minimal docx from mammoth's test fixtures (ships with node_modules)
    const sourceDocx = path.resolve("node_modules/mammoth/test/test-data/single-paragraph.docx");
    const filePath = path.join(tmpDir, "watch-docx.docx");
    await fs.copyFile(sourceDocx, filePath);

    const result = await openFileByPath(filePath);

    const mockWatchFile = vi.mocked(watchFile);
    expect(mockWatchFile).not.toHaveBeenCalled();

    // Content assertion — docx goes through the Buffer adapter branch; a
    // non-empty fragment proves that path works end-to-end. If the branch
    // ever accidentally fell through to utf-8 readFile, the docx parser
    // would choke and the fragment would be empty.
    const doc = getOrCreateDocument(result.documentId);
    expect(doc.getXmlFragment("default").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Already-open branch
// ---------------------------------------------------------------------------
describe("already-open branch", () => {
  it("returns alreadyOpen:true on second open without force and does not re-wire watcher", async () => {
    const filePath = path.join(tmpDir, "already-open.md");
    await fs.writeFile(filePath, "# Already open test");

    const first = await openFileByPath(filePath);
    expect(first.alreadyOpen).toBe(false);

    const mockWatchFile = vi.mocked(watchFile);
    expect(mockWatchFile.mock.calls.length).toBe(1);

    // Reopen without force — must hit the handleAlreadyOpen branch
    const second = await openFileByPath(filePath);
    expect(second.alreadyOpen).toBe(true);
    expect(second.documentId).toBe(first.documentId);
    expect(second.forceReloaded).toBe(false);
    expect(second.restoredFromSession).toBe(false);

    // Key invariant: the already-open branch must NOT re-wire the watcher.
    // If it did, every reopen would leak a watcher handle.
    expect(mockWatchFile.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Force-reload branch
// ---------------------------------------------------------------------------
describe("force-reload branch", () => {
  it("returns forceReloaded:true and does not re-wire the file watcher", async () => {
    const filePath = path.join(tmpDir, "force-reload.md");
    await fs.writeFile(filePath, "# First content");

    const first = await openFileByPath(filePath);
    expect(first.forceReloaded).toBe(false);

    const mockWatchFile = vi.mocked(watchFile);
    expect(mockWatchFile.mock.calls.length).toBe(1);

    // Modify the file on disk so the reload has observable content
    await fs.writeFile(filePath, "# Second content");

    const second = await openFileByPath(filePath, { force: true });
    expect(second.forceReloaded).toBe(true);
    expect(second.alreadyOpen).toBe(false);
    expect(second.documentId).toBe(first.documentId);

    // Force-reload intentionally skips wireFileWatcher (comment at file-opener.ts
    // force-reload branch). The original watcher from the first open stays live.
    expect(mockWatchFile.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 9: Unsupported extension
// ---------------------------------------------------------------------------
describe("resolveAndValidatePath — unsupported extension", () => {
  it("throws UNSUPPORTED_FORMAT for a file with an unsupported extension", async () => {
    const filePath = path.join(tmpDir, "bad.xyz");
    await fs.writeFile(filePath, "some content");

    await expect(openFileByPath(filePath)).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });
});

// ---------------------------------------------------------------------------
// Test 10: Oversized file
// ---------------------------------------------------------------------------
describe("resolveAndValidatePath — oversized file", () => {
  it("throws FILE_TOO_LARGE for a file exceeding the 50MB limit", async () => {
    const MAX_FILE_SIZE = 50 * 1024 * 1024;
    const filePath = path.join(tmpDir, "too-big.md");
    // Sparse-file trick: create empty, then truncate to 51MB. NTFS/ext4 both
    // allocate as sparse, so this is O(1) regardless of reported size.
    await fs.writeFile(filePath, "");
    await fs.truncate(filePath, MAX_FILE_SIZE + 1);

    await expect(openFileByPath(filePath)).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });
});
