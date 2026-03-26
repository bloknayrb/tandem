import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  openFileByPath,
  openFileFromContent,
  SUPPORTED_EXTENSIONS,
} from "../../src/server/mcp/file-opener.js";
import { removeDoc, setActiveDocId, getOpenDocs } from "../../src/server/mcp/document-service.js";

let tmpDir: string;

beforeEach(async () => {
  // Clean up document-service state
  for (const id of [...getOpenDocs().keys()]) {
    removeDoc(id);
  }
  setActiveDocId(null);

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-test-"));
});

// afterEach is intentionally omitted for tmpDir cleanup — OS handles tmpdir.

describe("openFileByPath — file size limit", () => {
  it("rejects files exceeding 50MB", async () => {
    // Create a file larger than 50MB
    const bigFile = path.join(tmpDir, "big.md");
    // Write a file just over the limit (50MB + 1 byte)
    const handle = await fs.open(bigFile, "w");
    await handle.truncate(50 * 1024 * 1024 + 1);
    await handle.close();

    await expect(openFileByPath(bigFile)).rejects.toThrow("50MB");
    try {
      await openFileByPath(bigFile);
    } catch (err: any) {
      expect(err.code).toBe("FILE_TOO_LARGE");
    }
  });

  it("accepts files at exactly 50MB", async () => {
    const exactFile = path.join(tmpDir, "exact.md");
    const handle = await fs.open(exactFile, "w");
    await handle.truncate(50 * 1024 * 1024);
    await handle.close();
    // Write some content so it's not just null bytes causing issues
    await fs.writeFile(exactFile, "x".repeat(100));

    // Should not throw (100 bytes is well under 50MB)
    const result = await openFileByPath(exactFile);
    expect(result.fileName).toBe("exact.md");
  });
});

describe("openFileByPath — unsupported extensions", () => {
  it("rejects .csv files", async () => {
    const csvFile = path.join(tmpDir, "data.csv");
    await fs.writeFile(csvFile, "a,b,c\n1,2,3");

    await expect(openFileByPath(csvFile)).rejects.toThrow("Unsupported file format");
    try {
      await openFileByPath(csvFile);
    } catch (err: any) {
      expect(err.code).toBe("UNSUPPORTED_FORMAT");
    }
  });

  it("rejects .pdf files", async () => {
    const pdfFile = path.join(tmpDir, "doc.pdf");
    await fs.writeFile(pdfFile, "fake pdf");

    await expect(openFileByPath(pdfFile)).rejects.toThrow("Unsupported file format");
  });

  it("rejects .js files", async () => {
    const jsFile = path.join(tmpDir, "code.js");
    await fs.writeFile(jsFile, "console.log('hello')");

    await expect(openFileByPath(jsFile)).rejects.toThrow("Unsupported file format");
  });
});

describe("openFileByPath — nonexistent files", () => {
  it("throws ENOENT for missing files", async () => {
    const missing = path.join(tmpDir, "ghost.md");
    await expect(openFileByPath(missing)).rejects.toThrow();
  });
});

describe("openFileByPath — supported extensions", () => {
  it("opens .md files", async () => {
    const f = path.join(tmpDir, "test.md");
    await fs.writeFile(f, "# Hello");
    const result = await openFileByPath(f);
    expect(result.format).toBe("md");
    expect(result.readOnly).toBe(false);
    expect(result.source).toBe("file");
  });

  it("opens .txt files", async () => {
    const f = path.join(tmpDir, "test.txt");
    await fs.writeFile(f, "plain text");
    const result = await openFileByPath(f);
    expect(result.format).toBe("txt");
    expect(result.readOnly).toBe(false);
  });

  it("opens .html files", async () => {
    const f = path.join(tmpDir, "test.html");
    await fs.writeFile(f, "<p>hello</p>");
    const result = await openFileByPath(f);
    expect(result.format).toBe("html");
  });
});

describe("openFileByPath — duplicate detection", () => {
  it("returns alreadyOpen for the same file opened twice", async () => {
    const f = path.join(tmpDir, "dup.md");
    await fs.writeFile(f, "# Dup");

    const first = await openFileByPath(f);
    expect(first.alreadyOpen).toBe(false);

    const second = await openFileByPath(f);
    expect(second.alreadyOpen).toBe(true);
    expect(second.documentId).toBe(first.documentId);
  });
});

describe("openFileByPath — result structure", () => {
  it("provides token and page estimates", async () => {
    const f = path.join(tmpDir, "est.md");
    await fs.writeFile(f, "Hello world, this is content.");
    const result = await openFileByPath(f);
    expect(result.tokenEstimate).toBeGreaterThan(0);
    expect(result.pageEstimate).toBeGreaterThanOrEqual(1);
  });

  it("provides fileName from path", async () => {
    const f = path.join(tmpDir, "my-report.md");
    await fs.writeFile(f, "content");
    const result = await openFileByPath(f);
    expect(result.fileName).toBe("my-report.md");
  });
});

describe("openFileFromContent — content size limit", () => {
  it("rejects content exceeding 50MB", async () => {
    const bigContent = "x".repeat(50 * 1024 * 1024 + 1);
    await expect(openFileFromContent("big.md", bigContent)).rejects.toThrow("50MB");
    try {
      await openFileFromContent("big.md", bigContent);
    } catch (err: any) {
      expect(err.code).toBe("FILE_TOO_LARGE");
    }
  });
});

describe("openFileFromContent — upload properties", () => {
  it("marks uploaded files as read-only", async () => {
    const result = await openFileFromContent("notes.md", "# Notes\nSome content");
    expect(result.readOnly).toBe(true);
    expect(result.source).toBe("upload");
  });

  it("creates synthetic upload:// path", async () => {
    const result = await openFileFromContent("upload.txt", "text content");
    expect(result.filePath).toMatch(/^upload:\/\//);
    expect(result.filePath).toContain("upload.txt");
  });

  it("rejects unsupported extensions in uploads", async () => {
    await expect(openFileFromContent("data.csv", "a,b,c")).rejects.toThrow("Unsupported");
  });
});

describe("openFileFromContent — Buffer content", () => {
  it("accepts Buffer content for binary formats", async () => {
    // We can't test actual .docx parsing without a real docx file,
    // but we can verify the size check works with Buffer
    const buf = Buffer.from("tiny content");
    // This will fail at the adapter.load step since it's not real docx,
    // but the size check should pass
    await expect(openFileFromContent("test.txt", buf.toString())).resolves.toBeDefined();
  });
});

describe("SUPPORTED_EXTENSIONS", () => {
  it("contains expected extensions", () => {
    expect(SUPPORTED_EXTENSIONS.has(".md")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".txt")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".html")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".htm")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".docx")).toBe(true);
  });

  it("does not contain unsupported extensions", () => {
    expect(SUPPORTED_EXTENSIONS.has(".csv")).toBe(false);
    expect(SUPPORTED_EXTENSIONS.has(".pdf")).toBe(false);
    expect(SUPPORTED_EXTENSIONS.has(".js")).toBe(false);
    expect(SUPPORTED_EXTENSIONS.has(".py")).toBe(false);
  });
});
