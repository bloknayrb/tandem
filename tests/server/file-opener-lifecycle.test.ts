import fsSync from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import * as queueModule from "../../src/server/events/queue.js";
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

    // Rewrite the file after saving session — this bumps mtime past the session timestamp
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(filePath, "# New content after save");

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
    const spy = vi.spyOn(queueModule, "setFileSyncContext");

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
  it("does not call watchFile for a .docx file", async () => {
    // Copy a real minimal docx from mammoth's test fixtures (ships with node_modules)
    const sourceDocx = path.resolve("node_modules/mammoth/test/test-data/single-paragraph.docx");
    const filePath = path.join(tmpDir, "watch-docx.docx");
    await fs.copyFile(sourceDocx, filePath);

    await openFileByPath(filePath);

    const mockWatchFile = vi.mocked(watchFile);
    expect(mockWatchFile).not.toHaveBeenCalled();
  });
});
