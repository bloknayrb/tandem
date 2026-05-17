import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getAdapter } from "../../src/server/file-io/index.js";
import { extractText } from "../../src/server/mcp/document-model.js";

// Mock the comments module so we can force injectCommentsAsAnnotations
// to throw on the adapter path. The production path in file-opener.ts
// has its own try/catch + snapshot/rollback; the adapter path now needs
// the same surface per PR #701 review.
vi.mock("../../src/server/file-io/docx-comments.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    extractDocxComments: vi.fn(async () => [
      { id: "c1", author: "A", text: "x", range: { start: 0, end: 1 } },
    ]),
    injectCommentsAsAnnotations: vi.fn(() => {
      throw new Error("inject failure (test)");
    }),
  };
});

// Same for docx body loader — we need htmlToYDoc to succeed deterministically.
vi.mock("../../src/server/file-io/docx.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadDocx: vi.fn(async () => "<p>body</p>"),
    htmlToYDoc: actual.htmlToYDoc,
  };
});

vi.mock("../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pushNotification: vi.fn(),
  };
});

describe("FormatAdapter registry", () => {
  it("returns markdown adapter for 'md'", () => {
    const adapter = getAdapter("md");
    expect(adapter.canSave).toBe(true);
  });

  it("returns plaintext adapter for 'txt'", () => {
    const adapter = getAdapter("txt");
    expect(adapter.canSave).toBe(true);
  });

  it("returns docx adapter for 'docx'", () => {
    const adapter = getAdapter("docx");
    expect(adapter.canSave).toBe(false);
    expect(adapter.save(new Y.Doc())).toBeNull();
  });

  it("falls back to plaintext for unknown formats", () => {
    const adapter = getAdapter("xyz");
    expect(adapter.canSave).toBe(true);
  });
});

describe("PlaintextAdapter", () => {
  it("round-trips through load/save", () => {
    const adapter = getAdapter("txt");
    const doc = new Y.Doc();
    adapter.load(doc, "Hello\nWorld");
    const output = adapter.save(doc);
    expect(output).toBe("Hello\nWorld");
  });
});

describe("MarkdownAdapter", () => {
  it("round-trips basic markdown", () => {
    const adapter = getAdapter("md");
    const doc = new Y.Doc();
    adapter.load(doc, "# Title\n\nA paragraph.");
    const output = adapter.save(doc);
    expect(output).toContain("# Title");
    expect(output).toContain("A paragraph.");
  });

  it("preserves heading structure", () => {
    const adapter = getAdapter("md");
    const doc = new Y.Doc();
    adapter.load(doc, "## Sub\n\nText");
    const text = extractText(doc);
    expect(text).toBe("## Sub\nText");
  });

  it("preserves GFM tables through the adapter path", () => {
    const adapter = getAdapter("md");
    const doc = new Y.Doc();
    adapter.load(
      doc,
      ["| Name | Score |", "| :--- | ---: |", "| Ada | **99** |", "| Empty |  |"].join("\n"),
    );

    const output = adapter.save(doc);
    expect(output).toContain("| Name  |  Score |");
    expect(output).toContain("| :---- | -----: |");
    expect(output).toContain("| Ada   | **99** |");
    expect(output).toContain("| Empty |        |");
  });
});

describe("DocxAdapter inject-failure surface (PR #701)", () => {
  it("does NOT throw when injectCommentsAsAnnotations fails; fires notification instead", async () => {
    const { pushNotification } = await import("../../src/server/notifications.js");
    const adapter = getAdapter("docx");
    const doc = new Y.Doc();

    await expect(
      adapter.load(doc, Buffer.from("any") as unknown as string),
    ).resolves.toBeUndefined();

    expect(pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "annotation-error",
        severity: "warning",
        dedupKey: "docx-inject:format-adapter",
        message: expect.stringContaining("Word comments"),
      }),
    );
  });
});
