import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { getAdapter } from "../../src/server/file-io/index.js";
import { extractText } from "../../src/server/mcp/document-model.js";

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
});
