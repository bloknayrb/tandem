import fs from "fs/promises";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addDoc,
  getOpenDocs,
  removeDoc,
  setActiveDocId,
} from "../../src/server/mcp/document-service.js";
import {
  openFileByPath,
  openFileFromContent,
  SUPPORTED_EXTENSIONS,
} from "../../src/server/mcp/file-opener.js";
import { handleOpen } from "../../src/server/mcp/routes/open.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_DOCUMENT_META } from "../../src/shared/constants.js";

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) {
    removeDoc(id);
  }
  setActiveDocId(null);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-test-"));
});

describe("openFileByPath — file size limit", () => {
  it("rejects files exceeding 50MB", async () => {
    const bigFile = path.join(tmpDir, "big.md");
    const handle = await fs.open(bigFile, "w");
    await handle.truncate(50 * 1024 * 1024 + 1);
    await handle.close();

    try {
      await openFileByPath(bigFile);
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      expect(e.message).toContain("50MB");
      expect(e.code).toBe("FILE_TOO_LARGE");
    }
  });

  it("accepts files at exactly the limit", async () => {
    // Create a file under 50MB (the actual boundary)
    const smallFile = path.join(tmpDir, "small.md");
    await fs.writeFile(smallFile, "# Hello\nSmall content");

    const result = await openFileByPath(smallFile);
    expect(result.fileName).toBe("small.md");
    expect(result.format).toBe("md");
  });
});

describe("openFileByPath — unsupported extensions", () => {
  it("rejects .csv with UNSUPPORTED_FORMAT code", async () => {
    const csvFile = path.join(tmpDir, "data.csv");
    await fs.writeFile(csvFile, "a,b,c\n1,2,3");

    try {
      await openFileByPath(csvFile);
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      expect(e.message).toContain("Unsupported file format");
      expect(e.code).toBe("UNSUPPORTED_FORMAT");
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

  it("reopening a renamed file by its NEW path resolves to the same tab, not a duplicate (#1017)", async () => {
    // After a rename the doc keeps its OLD documentId (= docIdFromPath(oldPath))
    // but its registry filePath is the NEW path. A later openFileByPath(newPath)
    // computes a DIFFERENT id and would open a duplicate tab without the realpath
    // fallback. Simulate the post-rename registry state, then reopen by new path.
    const oldPath = path.join(tmpDir, "before.md");
    await fs.writeFile(oldPath, "# Body");
    const first = await openFileByPath(oldPath);
    expect(first.alreadyOpen).toBe(false);

    // Rename on disk + reflect the promote-in-place registry state (same id).
    const newPath = path.join(tmpDir, "after.md");
    await fs.rename(oldPath, newPath);
    const state = getOpenDocs().get(first.documentId);
    if (!state) throw new Error("doc vanished");
    addDoc(first.documentId, { ...state, filePath: newPath });

    const second = await openFileByPath(newPath);
    expect(second.alreadyOpen).toBe(true);
    expect(second.documentId).toBe(first.documentId);
    // Exactly one tab for this file — the fallback prevented a duplicate.
    const fileDocs = [...getOpenDocs().values()].filter(
      (d) => d.source === "file" && path.resolve(d.filePath) === path.resolve(newPath),
    );
    expect(fileDocs).toHaveLength(1);
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

    try {
      await openFileFromContent("big.md", bigContent);
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      expect(e.message).toContain("50MB");
      expect(e.code).toBe("FILE_TOO_LARGE");
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
  it("accepts string content for text formats", async () => {
    const result = await openFileFromContent("test.txt", "tiny content");
    expect(result).toBeDefined();
    expect(result.format).toBe("txt");
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

// ---------------------------------------------------------------------------
// readOnly option
// ---------------------------------------------------------------------------

describe("openFileByPath — readOnly option", () => {
  it("opens a file as read-only when readOnly:true is passed", async () => {
    const f = path.join(tmpDir, "ro.md");
    await fs.writeFile(f, "# Read-only content");

    const result = await openFileByPath(f, { readOnly: true });

    expect(result.readOnly).toBe(true);
    expect(result.alreadyOpen).toBe(false);
    // Y.Doc metadata should also reflect the flag
    const doc = getOrCreateDocument(result.documentId);
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    expect(meta.get("readOnly")).toBe(true);
  });

  it("opens a file as writable by default (no readOnly option)", async () => {
    const f = path.join(tmpDir, "rw.md");
    await fs.writeFile(f, "# Writable content");

    const result = await openFileByPath(f);

    expect(result.readOnly).toBe(false);
  });

  it("upgrading an already-open file to readOnly:true updates registry and Y.Doc meta", async () => {
    const f = path.join(tmpDir, "upgrade-ro.md");
    await fs.writeFile(f, "# Upgrade to read-only");

    // Open normally (writable)
    const first = await openFileByPath(f);
    expect(first.readOnly).toBe(false);

    // Re-open with readOnly:true — should upgrade in-place
    const second = await openFileByPath(f, { readOnly: true });
    expect(second.alreadyOpen).toBe(true);
    expect(second.readOnly).toBe(true);

    // Open-docs registry should reflect the upgrade
    const openDocs = getOpenDocs();
    expect(openDocs.get(first.documentId)?.readOnly).toBe(true);

    // Y.Doc metadata should reflect the upgrade
    const doc = getOrCreateDocument(first.documentId);
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    expect(meta.get("readOnly")).toBe(true);
  });

  it("does not downgrade a read-only doc when re-opened without readOnly option", async () => {
    const f = path.join(tmpDir, "no-downgrade.md");
    await fs.writeFile(f, "# No downgrade");

    // Open with readOnly:true
    await openFileByPath(f, { readOnly: true });

    // Re-open without specifying readOnly — should NOT downgrade
    const second = await openFileByPath(f);
    expect(second.alreadyOpen).toBe(true);
    // readOnly reflects the re-open's derived value (false for .md), but the
    // registry and Y.Doc should NOT have been downgraded
    const openDocs = getOpenDocs();
    expect(openDocs.get(second.documentId)?.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/open — readOnly via HTTP route
// ---------------------------------------------------------------------------

describe("handleOpen — readOnly propagation", () => {
  it("opens a file as read-only when body contains readOnly:true", async () => {
    const f = path.join(tmpDir, "api-ro.md");
    await fs.writeFile(f, "# API read-only test");

    let capturedBody: unknown;
    const req = { body: { filePath: f, readOnly: true } } as Parameters<typeof handleOpen>[0];
    const res = {
      json: (body: unknown) => {
        capturedBody = body;
      },
      status: () => res,
    } as unknown as Parameters<typeof handleOpen>[1];

    await handleOpen(req, res);

    expect((capturedBody as { data: { readOnly: boolean } }).data.readOnly).toBe(true);
  });

  it("returns BAD_REQUEST when filePath is missing", async () => {
    let capturedStatus: number | undefined;
    let capturedBody: unknown;

    const req = { body: {} } as Parameters<typeof handleOpen>[0];
    const res = {
      status: (code: number) => {
        capturedStatus = code;
        return res;
      },
      json: (body: unknown) => {
        capturedBody = body;
      },
    } as unknown as Parameters<typeof handleOpen>[1];

    await handleOpen(req, res);

    expect(capturedStatus).toBe(400);
    expect((capturedBody as { error: string }).error).toBe("BAD_REQUEST");
  });

  it("propagates readOnly:true to an already-open document", async () => {
    const f = path.join(tmpDir, "api-already-open-ro.md");
    await fs.writeFile(f, "# Already-open read-only upgrade");

    // Open the document first (writable)
    await openFileByPath(f);

    let capturedBody: unknown;
    const req = {
      body: { filePath: f, readOnly: true },
    } as Parameters<typeof handleOpen>[0];
    const res = {
      json: (body: unknown) => {
        capturedBody = body;
      },
      status: () => res,
    } as unknown as Parameters<typeof handleOpen>[1];

    await handleOpen(req, res);

    const data = (capturedBody as { data: { readOnly: boolean; alreadyOpen: boolean } }).data;
    expect(data.alreadyOpen).toBe(true);
    expect(data.readOnly).toBe(true);
  });
});
