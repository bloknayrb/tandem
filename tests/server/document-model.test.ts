/**
 * Tests for document-model.ts getElementText() fix (Phase A of #260).
 *
 * Phase A replaces Y.XmlText.toString() with toDelta() iteration so that
 * inline formatting marks (bold, italic, etc.) are stripped from flat text
 * and hardBreak embeds emit \n to maintain XmlText index alignment.
 */

import type { Root } from "mdast";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { mdastToYDoc } from "../../src/server/file-io/mdast-ydoc.js";
import { extractText, getElementText } from "../../src/server/mcp/document.js";
import { validateRange } from "../../src/server/positions.js";
import { toFlatOffset } from "../../src/shared/positions/index.js";
import { getFragment, makeMarkdownDoc } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

function makeMdast(children: any[]): Root {
  return { type: "root", children };
}

function loadTree(tree: Root): Y.Doc {
  doc = new Y.Doc();
  mdastToYDoc(doc, tree);
  return doc;
}

// ---------------------------------------------------------------------------
// getElementText — bold/italic inline marks must not leak as HTML tags
// ---------------------------------------------------------------------------

describe("getElementText — inline mark stripping (Bug B fix)", () => {
  it("bold text returns clean string without <bold> tags", () => {
    loadTree(
      makeMdast([
        {
          type: "paragraph",
          children: [{ type: "strong", children: [{ type: "text", value: "bold text" }] }],
        },
      ]),
    );
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(getElementText(el)).toBe("bold text");
    expect(getElementText(el)).not.toContain("<bold>");
  });

  it("italic text returns clean string without <italic> tags", () => {
    loadTree(
      makeMdast([
        {
          type: "paragraph",
          children: [{ type: "emphasis", children: [{ type: "text", value: "italic text" }] }],
        },
      ]),
    );
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(getElementText(el)).toBe("italic text");
    expect(getElementText(el)).not.toContain("<italic>");
  });

  it("mixed plain and bold text returns concatenated clean string", () => {
    loadTree(
      makeMdast([
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Some " },
            { type: "strong", children: [{ type: "text", value: "bold" }] },
            { type: "text", value: " text." },
          ],
        },
      ]),
    );
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(getElementText(el)).toBe("Some bold text.");
  });

  it("heading with italic text returns clean heading content", () => {
    loadTree(
      makeMdast([
        {
          type: "heading",
          depth: 2,
          children: [
            { type: "text", value: "Hello " },
            { type: "emphasis", children: [{ type: "text", value: "World" }] },
          ],
        },
      ]),
    );
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(getElementText(el)).toBe("Hello World");
    expect(getElementText(el)).not.toContain("<italic>");
  });
});

// ---------------------------------------------------------------------------
// extractText — bold text via remark round-trip
// ---------------------------------------------------------------------------

describe("extractText — bold formatting via loadMarkdown", () => {
  it("plain bold paragraph returns clean flat text", () => {
    doc = makeMarkdownDoc("Some **bold text** here.");
    const flat = extractText(doc);
    expect(flat).toBe("Some bold text here.");
    expect(flat).not.toContain("<bold>");
  });

  it("offsets into bold text match validateRange", () => {
    doc = makeMarkdownDoc("Some **bold text** here.");
    const flat = extractText(doc);
    const target = "bold text";
    const from = flat.indexOf(target);
    expect(from).toBeGreaterThan(-1);
    const to = from + target.length;

    const result = validateRange(doc, toFlatOffset(from), toFlatOffset(to), {
      textSnapshot: target,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(flat.slice(result.range.from, result.range.to)).toBe(target);
    }
  });

  it("heading with bold content has correct heading prefix + clean text", () => {
    doc = makeMarkdownDoc("## **Bold Heading**\n\nParagraph");
    const flat = extractText(doc);
    // Heading level 2 prefix is "## " (3 chars)
    expect(flat.startsWith("## Bold Heading")).toBe(true);
    expect(flat).not.toContain("<bold>");
  });
});

// ---------------------------------------------------------------------------
// getElementText — hardBreak embeds emit \n for XmlText index alignment
// ---------------------------------------------------------------------------

describe("getElementText — hardBreak embed emits \\n", () => {
  it("paragraph with hardBreak emits \\n at break position", () => {
    // Build mdast directly: type:"break" becomes insertEmbed(hardBreak) in Y.XmlText
    loadTree(
      makeMdast([
        {
          type: "paragraph",
          children: [
            { type: "text", value: "line one" },
            { type: "break" },
            { type: "text", value: "line two" },
          ],
        },
      ]),
    );
    const el = getFragment(doc).get(0) as Y.XmlElement;
    const text = getElementText(el);
    // The \n placeholder keeps flat offset aligned with xmlText.length
    expect(text).toBe("line one\nline two");
  });

  it("offset of text after hardBreak aligns with validateRange", () => {
    // Build via mdast so we get a real hardBreak embed in Y.XmlText
    loadTree(
      makeMdast([
        {
          type: "paragraph",
          children: [
            { type: "text", value: "before" },
            { type: "break" },
            { type: "text", value: "after" },
          ],
        },
      ]),
    );

    const flat = extractText(doc);
    // "before\nafter" — extractText emits the paragraph's getElementText as-is
    expect(flat).toBe("before\nafter");

    const target = "after";
    const from = flat.indexOf(target);
    expect(from).toBeGreaterThan(-1);
    const to = from + target.length;

    // The key alignment property: offset must resolve correctly via validateRange
    const result = validateRange(doc, toFlatOffset(from), toFlatOffset(to), {
      textSnapshot: target,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(flat.slice(result.range.from, result.range.to)).toBe(target);
    }
  });
});
