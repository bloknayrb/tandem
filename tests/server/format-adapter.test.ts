import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// Mock the docx body parser so the #696 / ADR-036 test below can exercise the
// comments-extraction failure path without supplying a real .docx fixture.
vi.mock("../../src/server/file-io/docx.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadDocx: vi.fn().mockResolvedValue("<p>Body</p>"),
    htmlToYDoc: vi.fn(),
  };
});

import { getAdapter } from "../../src/server/file-io/index.js";
import { extractText } from "../../src/server/mcp/document-model.js";

describe("FormatAdapter registry (ADR-036)", () => {
  it("returns markdown adapter for 'md' — save is defined", () => {
    const adapter = getAdapter("md");
    expect(adapter.save).toBeDefined();
  });

  it("returns plaintext adapter for 'txt' — save is defined", () => {
    const adapter = getAdapter("txt");
    expect(adapter.save).toBeDefined();
  });

  it("returns docx adapter for 'docx' — save is omitted (read-only)", () => {
    const adapter = getAdapter("docx");
    expect(adapter.save).toBeUndefined();
  });

  it("falls back to plaintext for unknown formats — save is defined", () => {
    const adapter = getAdapter("xyz");
    expect(adapter.save).toBeDefined();
  });
});

describe("PlaintextAdapter", () => {
  it("round-trips through load/save", async () => {
    const adapter = getAdapter("txt");
    const doc = new Y.Doc();
    const result = await adapter.load(doc, "Hello\nWorld");
    expect(result.issues).toEqual([]);
    expect(adapter.save).toBeDefined();
    const output = adapter.save?.(doc);
    expect(output).toBe("Hello\nWorld");
  });
});

describe("MarkdownAdapter", () => {
  it("round-trips basic markdown", async () => {
    const adapter = getAdapter("md");
    const doc = new Y.Doc();
    const result = await adapter.load(doc, "# Title\n\nA paragraph.");
    expect(result.issues).toEqual([]);
    const output = adapter.save?.(doc);
    expect(output).toContain("# Title");
    expect(output).toContain("A paragraph.");
  });

  it("preserves heading structure", async () => {
    const adapter = getAdapter("md");
    const doc = new Y.Doc();
    await adapter.load(doc, "## Sub\n\nText");
    const text = extractText(doc);
    expect(text).toBe("## Sub\nText");
  });

  it("preserves GFM tables through the adapter path", async () => {
    const adapter = getAdapter("md");
    const doc = new Y.Doc();
    await adapter.load(
      doc,
      ["| Name | Score |", "| :--- | ---: |", "| Ada | **99** |", "| Empty |  |"].join("\n"),
    );

    const output = adapter.save?.(doc);
    expect(output).toContain("| Name  |  Score |");
    expect(output).toContain("| :---- | -----: |");
    expect(output).toContain("| Ada   | **99** |");
    expect(output).toContain("| Empty |        |");
  });
});

describe("DocxAdapter (#696, ADR-036)", () => {
  it("returns kind: 'comments-failed' issue when extractDocxComments rejects", async () => {
    const adapter = getAdapter("docx");
    const doc = new Y.Doc();
    // A non-zip buffer rejects in mammoth's JSZip parse — exercises the
    // issues path without mocking.
    const result = await adapter.load(doc, Buffer.from("not-a-docx"));
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
    expect(result.issues[0].kind).toBe("comments-failed");
  });

  it("save is omitted — adapter cannot write .docx back to disk", () => {
    const adapter = getAdapter("docx");
    expect(adapter.save).toBeUndefined();
  });
});
