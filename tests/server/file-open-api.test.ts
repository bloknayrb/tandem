import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { docIdFromPath, extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs, removeDoc } from "../../src/server/mcp/document-service.js";
import {
  openFileByPath,
  openFileFromContent,
  SUPPORTED_EXTENSIONS,
} from "../../src/server/mcp/file-opener.js";
import { sourceFileChanged } from "../../src/server/session/manager.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import {
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_DOCUMENT_META,
} from "../../src/shared/constants.js";
import type { SessionData } from "../../src/shared/types.js";

let tmpDir: string | null = null;

async function makeTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-test-"));
  return tmpDir;
}

afterEach(async () => {
  // Clean up all opened docs (service tracking + provider Y.Doc map)
  for (const id of getOpenDocs().keys()) {
    removeDoc(id);
    removeDocument(id);
  }
  // Clean up temp directory
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("openFileByPath", () => {
  it("opens a .md file and returns correct metadata", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Hello\n\nWorld");

    const result = await openFileByPath(filePath);

    expect(result.fileName).toBe("test.md");
    expect(result.format).toBe("md");
    expect(result.readOnly).toBe(false);
    expect(result.source).toBe("file");
    expect(result.alreadyOpen).toBe(false);
    expect(result.documentId).toBeTruthy();
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it("rejects nonexistent paths", async () => {
    await expect(openFileByPath("/nonexistent/file.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects unsupported extensions", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "data.csv");
    await fs.writeFile(filePath, "a,b,c");

    await expect(openFileByPath(filePath)).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  it("returns alreadyOpen for duplicate opens", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Hello");

    const first = await openFileByPath(filePath);
    const second = await openFileByPath(filePath);

    expect(first.alreadyOpen).toBe(false);
    expect(second.alreadyOpen).toBe(true);
    expect(second.documentId).toBe(first.documentId);
  });

  it("force=true re-reads from disk when file changed", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Original");

    const first = await openFileByPath(filePath);
    expect(first.alreadyOpen).toBe(false);

    // Modify the file on disk
    await fs.writeFile(filePath, "# Updated content\n\nNew paragraph");

    const second = await openFileByPath(filePath, { force: true });

    expect(second.forceReloaded).toBe(true);
    expect(second.alreadyOpen).toBe(false);
    expect(second.documentId).toBe(first.documentId);

    // Verify actual document content reflects the disk change
    const doc = getOrCreateDocument(second.documentId);
    const text = extractText(doc);
    expect(text).toContain("Updated content");
    expect(text).toContain("New paragraph");
    expect(text).not.toContain("Original");
  });

  it("force=true when file deleted from disk throws ENOENT without tearing down", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Hello");

    await openFileByPath(filePath);
    const id = docIdFromPath(filePath);

    // Delete the file on disk
    await fs.unlink(filePath);

    // fs.stat runs before the force-close branch, so ENOENT is thrown
    // without tearing down the in-memory doc
    await expect(openFileByPath(filePath, { force: true })).rejects.toMatchObject({
      code: "ENOENT",
    });

    // Doc should still be tracked — the error occurred before clearAndReload
    expect(getOpenDocs().has(id)).toBe(true);
  });

  it("force=true on non-open doc behaves like normal open", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Hello");

    const result = await openFileByPath(filePath, { force: true });

    expect(result.alreadyOpen).toBe(false);
    expect(result.forceReloaded).toBe(false);
    expect(result.fileName).toBe("test.md");
  });

  it("force=false preserves alreadyOpen behavior", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Hello");

    await openFileByPath(filePath);
    const second = await openFileByPath(filePath, { force: false });

    expect(second.alreadyOpen).toBe(true);
    expect(second.forceReloaded).toBe(false);
  });

  it("default (no options) preserves alreadyOpen behavior", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Hello");

    await openFileByPath(filePath);
    const second = await openFileByPath(filePath);

    expect(second.alreadyOpen).toBe(true);
    expect(second.forceReloaded).toBe(false);
  });

  it("force=true clears and repopulates the same Y.Doc in-place", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Hello");

    const first = await openFileByPath(filePath);
    const docBefore = getOrCreateDocument(first.documentId);

    await fs.writeFile(filePath, "# Changed");
    await openFileByPath(filePath, { force: true });
    const docAfter = getOrCreateDocument(first.documentId);

    // Same Y.Doc instance — cleared and repopulated in-place
    expect(docAfter).toBe(docBefore);
    // Content reflects the updated file
    const text = extractText(docAfter);
    expect(text).toContain("Changed");
  });

  it("force=true twice in succession does not crash", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Hello");

    await openFileByPath(filePath);

    const second = await openFileByPath(filePath, { force: true });
    expect(second.forceReloaded).toBe(true);

    const third = await openFileByPath(filePath, { force: true });
    expect(third.forceReloaded).toBe(true);
    expect(third.documentId).toBe(second.documentId);
  });

  it("force=true succeeds even when deleteSession throws", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Original");

    await openFileByPath(filePath);

    // Mock deleteSession to throw — teardown should still complete
    const sessionManager = await import("../../src/server/session/manager.js");
    const spy = vi
      .spyOn(sessionManager, "deleteSession")
      .mockRejectedValueOnce(new Error("EPERM: permission denied"));

    await fs.writeFile(filePath, "# After error");
    const result = await openFileByPath(filePath, { force: true });

    expect(result.forceReloaded).toBe(true);
    const doc = getOrCreateDocument(result.documentId);
    const text = extractText(doc);
    expect(text).toContain("After error");

    spy.mockRestore();
  });

  it("force=true clears Y_MAP_ANNOTATIONS", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Hello");

    const first = await openFileByPath(filePath);
    const doc = getOrCreateDocument(first.documentId);

    // Inject a fake annotation
    const annotations = doc.getMap(Y_MAP_ANNOTATIONS);
    annotations.set("fake-annotation-1", { text: "test" });
    expect(annotations.size).toBe(1);

    // Force-reload should clear it
    await openFileByPath(filePath, { force: true });
    expect(annotations.size).toBe(0);
  });

  it("force=true clears Y_MAP_AWARENESS", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Hello");

    const first = await openFileByPath(filePath);
    const doc = getOrCreateDocument(first.documentId);

    // Inject fake awareness data
    const awareness = doc.getMap(Y_MAP_AWARENESS);
    awareness.set("claude-status", { typing: true });
    expect(awareness.size).toBe(1);

    // Force-reload should clear it
    await openFileByPath(filePath, { force: true });
    expect(awareness.size).toBe(0);
  });

  it("force=true works for .txt files", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.txt");
    await fs.writeFile(filePath, "Original text");

    const first = await openFileByPath(filePath);
    await fs.writeFile(filePath, "Updated text");
    await openFileByPath(filePath, { force: true });

    const doc = getOrCreateDocument(first.documentId);
    const text = extractText(doc);
    expect(text).toContain("Updated text");
    expect(text).not.toContain("Original");
  });

  it("force=true preserves correct metadata after reload", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, "# Hello");

    const first = await openFileByPath(filePath);
    await fs.writeFile(filePath, "# Changed");
    await openFileByPath(filePath, { force: true });

    const doc = getOrCreateDocument(first.documentId);
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    expect(meta.get("readOnly")).toBe(false);
    expect(meta.get("format")).toBe("md");
    expect(meta.get("fileName")).toBe("test.md");
    expect(meta.get("documentId")).toBe(first.documentId);
  });
});

describe("openFileFromContent", () => {
  it("creates doc from text content", async () => {
    const result = await openFileFromContent("notes.md", "# Test\n\nContent here");

    expect(result.fileName).toBe("notes.md");
    expect(result.format).toBe("md");
    expect(result.source).toBe("upload");
    expect(result.readOnly).toBe(true);
    expect(result.filePath).toMatch(/^upload:\/\//);
  });

  it("detects format from filename extension", async () => {
    const result = await openFileFromContent("readme.txt", "plain text");

    expect(result.format).toBe("txt");
    expect(result.source).toBe("upload");
  });

  it("rejects unsupported extensions", async () => {
    await expect(openFileFromContent("data.csv", "a,b,c")).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  it("marks upload docs as read-only", async () => {
    const result = await openFileFromContent("test.md", "# Hello");
    expect(result.readOnly).toBe(true);
  });
});

describe("session guards for upload paths", () => {
  it("sourceFileChanged returns false for upload:// paths", async () => {
    const session: SessionData = {
      filePath: "upload://abc-123/test.md",
      format: "md",
      ydocState: "",
      sourceFileMtime: 0,
      lastAccessed: Date.now(),
    };

    const changed = await sourceFileChanged(session);
    expect(changed).toBe(false);
  });
});

describe("SUPPORTED_EXTENSIONS", () => {
  it("includes expected formats", () => {
    expect(SUPPORTED_EXTENSIONS.has(".md")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".txt")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".docx")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".html")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".htm")).toBe(true);
  });

  it("excludes unsupported formats", () => {
    expect(SUPPORTED_EXTENSIONS.has(".csv")).toBe(false);
    expect(SUPPORTED_EXTENSIONS.has(".pdf")).toBe(false);
  });
});
