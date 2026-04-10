import { describe, it, expect, afterEach } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../src/server/file-io/markdown.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

/** Load markdown, save it, return the output */
function roundTrip(input: string): string {
  doc = new Y.Doc();
  loadMarkdown(doc, input);
  return saveMarkdown(doc);
}

/**
 * Normalize whitespace for comparison — remark may adjust trailing newlines.
 * We trim both sides so tests focus on content, not trailing whitespace.
 */
function normalize(s: string): string {
  return s.trim();
}

describe("markdown round-trip", () => {
  it("headings and paragraphs", () => {
    const input = "# Title\n\nSome text.\n\n## Section\n\nMore text.";
    expect(normalize(roundTrip(input))).toBe(normalize(input));
  });

  it("heading levels 1-6", () => {
    const input = "# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6";
    const output = normalize(roundTrip(input));
    expect(output).toContain("# H1");
    expect(output).toContain("## H2");
    expect(output).toContain("###### H6");
  });

  it("blank lines between paragraphs", () => {
    const input = "First paragraph.\n\nSecond paragraph.";
    const output = normalize(roundTrip(input));
    expect(output).toContain("First paragraph.");
    expect(output).toContain("Second paragraph.");
  });

  it("inline formatting: bold, italic, strikethrough, code", () => {
    const input = "This is **bold** and *italic* and ~~strike~~ and `code`.";
    const output = normalize(roundTrip(input));
    expect(output).toContain("**bold**");
    expect(output).toContain("*italic*");
    expect(output).toContain("~~strike~~");
    expect(output).toContain("`code`");
  });

  it("links", () => {
    const input = 'Visit [Example](https://example.com "A site") for more.';
    const output = normalize(roundTrip(input));
    expect(output).toContain("[Example]");
    expect(output).toContain("https://example.com");
  });

  it("bullet lists", () => {
    const input = "- Item one\n- Item two\n- Item three";
    const output = normalize(roundTrip(input));
    expect(output).toContain("- Item one");
    expect(output).toContain("- Item two");
    expect(output).toContain("- Item three");
  });

  it("ordered lists", () => {
    const input = "1. First\n2. Second\n3. Third";
    const output = normalize(roundTrip(input));
    expect(output).toContain("1. First");
    expect(output).toContain("2. Second");
    expect(output).toContain("3. Third");
  });

  it("nested lists (2 levels)", () => {
    const input = "- Outer\n  - Inner one\n  - Inner two";
    const output = normalize(roundTrip(input));
    expect(output).toContain("- Outer");
    expect(output).toContain("Inner one");
    expect(output).toContain("Inner two");
  });

  it("code block with language", () => {
    const input = "```javascript\nconst x = 1;\nconsole.log(x);\n```";
    const output = normalize(roundTrip(input));
    expect(output).toContain("```javascript");
    expect(output).toContain("const x = 1;");
    expect(output).toContain("console.log(x);");
    expect(output).toContain("```");
  });

  it("code block without language", () => {
    const input = "```\nplain code\n```";
    const output = normalize(roundTrip(input));
    expect(output).toContain("plain code");
  });

  it("blockquote", () => {
    const input = "> This is a quote.\n>\n> Second paragraph in quote.";
    const output = normalize(roundTrip(input));
    expect(output).toContain("> This is a quote.");
    expect(output).toContain("> Second paragraph in quote.");
  });

  it("horizontal rule", () => {
    const input = "Above\n\n---\n\nBelow";
    const output = normalize(roundTrip(input));
    expect(output).toContain("Above");
    expect(output).toContain("---");
    expect(output).toContain("Below");
  });

  it("comprehensive mixed document", () => {
    const input = [
      "# Document Title",
      "",
      "An introductory paragraph with **bold** and *italic* text.",
      "",
      "## Section One",
      "",
      "- First item",
      "- Second item with `code`",
      "- Third item",
      "",
      "### Subsection",
      "",
      "> A blockquote with some *emphasis*.",
      "",
      "```typescript",
      "function hello(): void {",
      '  console.log("hi");',
      "}",
      "```",
      "",
      "---",
      "",
      "1. Ordered one",
      "2. Ordered two",
      "",
      "Final paragraph.",
    ].join("\n");

    const output = normalize(roundTrip(input));
    expect(output).toContain("# Document Title");
    expect(output).toContain("**bold**");
    expect(output).toContain("*italic*");
    expect(output).toContain("- First item");
    expect(output).toContain("`code`");
    expect(output).toContain("blockquote");
    expect(output).toContain("```typescript");
    expect(output).toContain("function hello()");
    expect(output).toContain("---");
    expect(output).toContain("1. Ordered one");
    expect(output).toContain("Final paragraph.");
  });

  it("empty document", () => {
    const output = roundTrip("");
    expect(normalize(output)).toBe("");
  });

  it("document with only headings", () => {
    const input = "# H1\n\n## H2\n\n### H3";
    const output = normalize(roundTrip(input));
    expect(output).toContain("# H1");
    expect(output).toContain("## H2");
    expect(output).toContain("### H3");
  });

  it("unicode: emoji and CJK characters", () => {
    const input = "Hello 🎉\n\n你好世界\n\n## 标题";
    const output = normalize(roundTrip(input));
    expect(output).toContain("🎉");
    expect(output).toContain("你好世界");
    expect(output).toContain("## 标题");
  });

  it("image preserves alt text (inline images degrade to text)", () => {
    // remark parses inline images inside a paragraph, so they degrade to alt text
    // Block-level images are handled via the image Y.XmlElement
    const input = '![Alt text](https://example.com/image.png "Title")';
    const output = normalize(roundTrip(input));
    expect(output).toContain("Alt text");
  });

  it("list in blockquote", () => {
    const input = "> - Item one\n> - Item two";
    const output = normalize(roundTrip(input));
    expect(output).toContain("> -");
    expect(output).toContain("Item one");
    expect(output).toContain("Item two");
  });
});
