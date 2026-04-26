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
import {
  collectXmlTexts,
  extractText,
  findXmlTextAtOffset,
  getElementText,
  getElementTextLength,
} from "../../src/server/mcp/document.js";
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

// ---------------------------------------------------------------------------
// Phase B: list content — separator, getElementTextLength, findXmlTextAtOffset, collectXmlTexts
// ---------------------------------------------------------------------------

describe("list content (Phase B)", () => {
  it("extractText includes \\n between list items", () => {
    // loadMarkdown (remark) produces real bulletList > listItem > paragraph > XmlText
    doc = makeMarkdownDoc("- Alpha\n- Beta");
    const text = extractText(doc);
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
    // List items must be separated by \n (Bug C fix)
    expect(text).toMatch(/Alpha\nBeta/);
  });

  it("extractText handles nested lists", () => {
    doc = makeMarkdownDoc("- Outer\n  - Inner1\n  - Inner2\n- Outer2");
    const text = extractText(doc);
    expect(text).toContain("Outer");
    expect(text).toContain("Inner1");
    expect(text).toContain("Inner2");
    expect(text).toContain("Outer2");
  });

  it("getElementTextLength matches getElementText().length for list elements", () => {
    doc = makeMarkdownDoc("- Alpha\n- Beta\n- Gamma");
    const fragment = doc.getXmlFragment("default");
    for (let i = 0; i < fragment.length; i++) {
      const node = fragment.get(i);
      if (node instanceof Y.XmlElement) {
        expect(getElementTextLength(node)).toBe(getElementText(node).length);
      }
    }
  });

  it("findXmlTextAtOffset returns non-null for list item content", () => {
    doc = makeMarkdownDoc("- Alpha\n- Beta");
    const fragment = doc.getXmlFragment("default");
    // Find the bulletList element (first fragment child)
    let bulletList: Y.XmlElement | null = null;
    for (let i = 0; i < fragment.length; i++) {
      const node = fragment.get(i);
      if (node instanceof Y.XmlElement && node.nodeName === "bulletList") {
        bulletList = node;
        break;
      }
    }
    expect(bulletList).not.toBeNull();

    // "Alpha\nBeta" — offset 0 is in "Alpha"
    const foundAlpha = findXmlTextAtOffset(bulletList!, 0);
    expect(foundAlpha).not.toBeNull();
    expect(foundAlpha!.offsetInXmlText).toBe(0);

    // The key invariant: offset 6 ("B" in "Beta") must resolve — offset 5 is the separator
    const foundBeta = findXmlTextAtOffset(bulletList!, 6);
    expect(foundBeta).not.toBeNull();
    expect(foundBeta!.offsetInXmlText).toBe(0); // "B" is start of "Beta" XmlText
  });

  it("collectXmlTexts returns all XmlTexts with correct offsets", () => {
    doc = makeMarkdownDoc("- Alpha\n- Beta");
    const fragment = doc.getXmlFragment("default");
    let bulletList: Y.XmlElement | null = null;
    for (let i = 0; i < fragment.length; i++) {
      const node = fragment.get(i);
      if (node instanceof Y.XmlElement && node.nodeName === "bulletList") {
        bulletList = node;
        break;
      }
    }
    expect(bulletList).not.toBeNull();
    const collected = collectXmlTexts(bulletList!);
    // Must have at least one XmlText per list item
    expect(collected.length).toBeGreaterThanOrEqual(2);
    // Offsets must be monotonically increasing
    for (let i = 1; i < collected.length; i++) {
      expect(collected[i].offsetFromStart).toBeGreaterThan(collected[i - 1].offsetFromStart);
    }
  });

  it("round-trips flat offsets for list items via extractText", () => {
    doc = makeMarkdownDoc("- Alpha\n- Beta\n- Gamma");
    const flat = extractText(doc);
    // "Alpha\nBeta\nGamma" — verify slices
    const alphaIdx = flat.indexOf("Alpha");
    const betaIdx = flat.indexOf("Beta");
    const gammaIdx = flat.indexOf("Gamma");
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
    expect(gammaIdx).toBeGreaterThan(betaIdx);
    // Items are separated by \n
    expect(flat[alphaIdx + 5]).toBe("\n");
    expect(flat[betaIdx + 4]).toBe("\n");
  });

  it("findXmlTextAtOffset returns null on separator boundary", () => {
    doc = makeMarkdownDoc("- Alpha\n- Beta");
    const fragment = doc.getXmlFragment("default");
    let bulletList: Y.XmlElement | null = null;
    for (let i = 0; i < fragment.length; i++) {
      const node = fragment.get(i);
      if (node instanceof Y.XmlElement && node.nodeName === "bulletList") {
        bulletList = node;
        break;
      }
    }
    expect(bulletList).not.toBeNull();

    // "Alpha\nBeta" — offset 5 is the separator between items
    const found = findXmlTextAtOffset(bulletList!, 5);
    expect(found).toBeNull();
  });

  it("findXmlTextAtOffset returns result at end of element text", () => {
    doc = makeMarkdownDoc("- Alpha\n- Beta");
    const fragment = doc.getXmlFragment("default");
    let bulletList: Y.XmlElement | null = null;
    for (let i = 0; i < fragment.length; i++) {
      const node = fragment.get(i);
      if (node instanceof Y.XmlElement && node.nodeName === "bulletList") {
        bulletList = node;
        break;
      }
    }
    expect(bulletList).not.toBeNull();

    // "Alpha" is 5 chars, "Beta" is 4 chars
    // Offset 4 should be last char of "Alpha" → valid
    const foundEnd = findXmlTextAtOffset(bulletList!, 4);
    expect(foundEnd).not.toBeNull();
    expect(foundEnd!.offsetInXmlText).toBe(4);
  });

  it("getElementTextLength matches getElementText().length for lists", () => {
    doc = makeMarkdownDoc("- Alpha\n- Beta\n- Gamma");
    const fragment = doc.getXmlFragment("default");
    let bulletList: Y.XmlElement | null = null;
    for (let i = 0; i < fragment.length; i++) {
      const node = fragment.get(i);
      if (node instanceof Y.XmlElement && node.nodeName === "bulletList") {
        bulletList = node;
        break;
      }
    }
    expect(bulletList).not.toBeNull();

    const textLen = getElementText(bulletList!).length;
    const computedLen = getElementTextLength(bulletList!);
    expect(computedLen).toBe(textLen);
  });
});
