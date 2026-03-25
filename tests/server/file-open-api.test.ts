import { describe, it, expect, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  openFileByPath,
  openFileFromContent,
  SUPPORTED_EXTENSIONS,
} from "../../src/server/mcp/file-opener.js";
import { getOpenDocs, removeDoc } from "../../src/server/mcp/document-service.js";
import { sourceFileChanged } from "../../src/server/session/manager.js";
import type { SessionData } from "../../src/shared/types.js";

let tmpDir: string | null = null;

async function makeTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-test-"));
  return tmpDir;
}

afterEach(async () => {
  // Clean up all opened docs
  for (const id of getOpenDocs().keys()) {
    removeDoc(id);
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
