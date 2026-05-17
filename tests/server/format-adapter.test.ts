import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// Mock the docx body parser so the #696 / ADR-036 / PR #707 review test below
// can exercise the comments-extraction failure path without supplying a real
// .docx fixture.
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

describe("PlaintextAdapter — two-phase parse/apply", () => {
  it("parse returns { format: 'other' }; apply round-trips through save", async () => {
    const adapter = getAdapter("txt");
    const doc = new Y.Doc();
    const prepared = await adapter.parse("Hello\nWorld");
    expect(prepared.format).toBe("other");
    expect(prepared.issues).toEqual([]);
    const applyIssues = adapter.apply(doc, prepared);
    expect(applyIssues).toEqual([]);
    const output = adapter.save?.(doc);
    expect(output).toBe("Hello\nWorld");
  });
});

describe("MarkdownAdapter — two-phase parse/apply", () => {
  it("round-trips basic markdown via parse + apply", async () => {
    const adapter = getAdapter("md");
    const doc = new Y.Doc();
    const prepared = await adapter.parse("# Title\n\nA paragraph.");
    expect(prepared.format).toBe("md");
    expect(prepared.issues).toEqual([]);
    expect(adapter.apply(doc, prepared)).toEqual([]);
    const output = adapter.save?.(doc);
    expect(output).toContain("# Title");
    expect(output).toContain("A paragraph.");
  });

  it("preserves heading structure", async () => {
    const adapter = getAdapter("md");
    const doc = new Y.Doc();
    adapter.apply(doc, await adapter.parse("## Sub\n\nText"));
    const text = extractText(doc);
    expect(text).toBe("## Sub\nText");
  });

  it("preserves GFM tables through the adapter path", async () => {
    const adapter = getAdapter("md");
    const doc = new Y.Doc();
    const prepared = await adapter.parse(
      ["| Name | Score |", "| :--- | ---: |", "| Ada | **99** |", "| Empty |  |"].join("\n"),
    );
    adapter.apply(doc, prepared);

    const output = adapter.save?.(doc);
    expect(output).toContain("| Name  |  Score |");
    expect(output).toContain("| :---- | -----: |");
    expect(output).toContain("| Ada   | **99** |");
    expect(output).toContain("| Empty |        |");
  });

  it("apply runs inside an externally-provided transact (single-transact invariant)", async () => {
    const adapter = getAdapter("md");
    const doc = new Y.Doc();
    const prepared = await adapter.parse("# Heading");

    let transactCount = 0;
    doc.on("afterTransaction", () => {
      transactCount += 1;
    });

    // biome-ignore lint/suspicious/noExplicitAny: Y.Doc.transact second arg.
    (doc as any).transact(() => {
      adapter.apply(doc, prepared);
    }, "test");

    // Apply must NOT open its own transact — the populate should be one
    // atomic update (load-bearing for #609 large-doc client freeze).
    expect(transactCount).toBe(1);
  });
});

describe("DocxAdapter — two-phase parse/apply (#696, ADR-036, PR #707 review)", () => {
  it("parse returns kind: 'comments-failed' issue when extractDocxComments rejects", async () => {
    const adapter = getAdapter("docx");
    // A non-zip buffer rejects in mammoth's JSZip parse — exercises the
    // issues path without mocking the comment-extractor itself.
    const prepared = await adapter.parse(Buffer.from("not-a-docx"));
    expect(prepared.format).toBe("docx");
    expect(prepared.issues.length).toBeGreaterThanOrEqual(1);
    expect(prepared.issues[0].kind).toBe("comments-failed");
  });

  it("apply returns kind: 'inject-failed' when injectCommentsAsAnnotations throws", async () => {
    // Mock just the inject to throw; parse runs for real (and yields a
    // comments-failed because the buffer isn't a real docx — that's fine,
    // we override `comments` below).
    const adapter = getAdapter("docx");
    const doc = new Y.Doc();
    const prepared = {
      format: "docx" as const,
      html: "<p>x</p>",
      comments: [
        {
          id: "c1",
          author: "A",
          text: "x",
          range: { start: 0, end: 1 },
        },
      ],
      issues: [],
    };

    const docxCommentsMod = await import("../../src/server/file-io/docx-comments.js");
    const spy = vi.spyOn(docxCommentsMod, "injectCommentsAsAnnotations").mockImplementation(() => {
      throw new Error("inject failure (test)");
    });

    try {
      const applyIssues = adapter.apply(doc, prepared);
      expect(applyIssues.length).toBeGreaterThanOrEqual(1);
      expect(applyIssues[0].kind).toBe("inject-failed");
    } finally {
      spy.mockRestore();
    }
  });

  it("save is omitted — adapter cannot write .docx back to disk", () => {
    const adapter = getAdapter("docx");
    expect(adapter.save).toBeUndefined();
  });
});
