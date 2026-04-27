import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  extractText,
  getOrCreateXmlText,
  mergeXmlTextDelta,
  resolveOffset,
} from "../../src/server/mcp/document.js";
import { makeDoc } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

/**
 * Replicate tandem_edit logic for testing.
 * Returns null on success, or an error string on failure.
 */
function applyEdit(doc: Y.Doc, from: number, to: number, newText: string): string | null {
  if (from > to) return `Invalid range: from (${from}) must be <= to (${to}).`;

  const fragment = doc.getXmlFragment("default");
  const startPos = resolveOffset(fragment, from);
  const endPos = resolveOffset(fragment, to);

  if (!startPos || !endPos) return `Cannot resolve offset range [${from}, ${to}].`;

  if (startPos.clampedFromPrefix || endPos.clampedFromPrefix) {
    return "Edit range overlaps with heading markup.";
  }

  if (startPos.elementIndex !== endPos.elementIndex) {
    doc.transact(() => {
      const startNode = fragment.get(startPos.elementIndex) as Y.XmlElement;
      const startText = getOrCreateXmlText(startNode);
      const startLen = startText.length;
      if (startPos.textOffset < startLen) {
        startText.delete(startPos.textOffset, startLen - startPos.textOffset);
      }

      const deleteCount = endPos.elementIndex - startPos.elementIndex - 1;
      for (let i = 0; i < deleteCount; i++) {
        fragment.delete(startPos.elementIndex + 1, 1);
      }

      const endNode = fragment.get(startPos.elementIndex + 1) as Y.XmlElement;
      const endText = getOrCreateXmlText(endNode);
      if (endPos.textOffset > 0) {
        endText.delete(0, endPos.textOffset);
      }
      mergeXmlTextDelta(startText, endText, startPos.textOffset);
      fragment.delete(startPos.elementIndex + 1, 1);

      startText.insert(startPos.textOffset, newText);
    });
  } else {
    doc.transact(() => {
      const node = fragment.get(startPos.elementIndex) as Y.XmlElement;
      const textNode = getOrCreateXmlText(node);
      const deleteLen = endPos.textOffset - startPos.textOffset;
      if (deleteLen > 0) {
        textNode.delete(startPos.textOffset, deleteLen);
      }
      if (newText.length > 0) {
        textNode.insert(startPos.textOffset, newText);
      }
    });
  }

  return null;
}

describe("same-element edits", () => {
  it("replaces text in the middle of a paragraph", () => {
    doc = makeDoc("Hello world");
    const err = applyEdit(doc, 6, 11, "there");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("Hello there");
  });

  it("inserts at beginning (from === to)", () => {
    doc = makeDoc("Hello world");
    const err = applyEdit(doc, 0, 0, "Hey ");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("Hey Hello world");
  });

  it("inserts at end", () => {
    doc = makeDoc("Hello world");
    const err = applyEdit(doc, 11, 11, "!");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("Hello world!");
  });

  it("deletes text (empty newText)", () => {
    doc = makeDoc("Hello world");
    const err = applyEdit(doc, 0, 6, "");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("world");
  });

  it("replaces entire paragraph content", () => {
    doc = makeDoc("Hello world");
    const err = applyEdit(doc, 0, 11, "Goodbye");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("Goodbye");
  });
});

describe("cross-element edits", () => {
  it("spanning two paragraphs merges them", () => {
    doc = makeDoc("First line\nSecond line");
    // "First line\nSecond line"
    // Delete from "line" in first to "Second " → merge
    const err = applyEdit(doc, 6, 18, "");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("First line");
  });

  it("spanning two paragraphs with replacement text", () => {
    doc = makeDoc("First line\nSecond line");
    // Replace from offset 5 (" line") through offset 17 ("Second ") with " and second "
    // "First" + " and second " + "line"
    const err = applyEdit(doc, 5, 18, " and second ");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("First and second line");
  });

  it("spanning three elements deletes middle entirely", () => {
    doc = makeDoc("First\nMiddle\nThird");
    // "First\nMiddle\nThird" → F=0..4, \n=5, M=6..11, \n=12, T=13..17
    // Delete from end of First (5) to start of Third (13)
    const err = applyEdit(doc, 5, 13, " and ");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("First and Third");
  });

  it("endPos.textOffset === 0 (selection ends at start of element)", () => {
    doc = makeDoc("First\nSecond");
    // Delete from offset 3 to offset 6 (start of "Second")
    // endPos for offset 6 → elementIndex 1, textOffset 0
    const err = applyEdit(doc, 3, 6, "");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("FirSecond");
  });
});

describe("heading prefix rejection", () => {
  it("rejects edit starting inside heading prefix", () => {
    doc = makeDoc("## Heading");
    const err = applyEdit(doc, 0, 5, "X");
    expect(err).toContain("heading markup");
  });

  it("rejects edit ending inside heading prefix", () => {
    doc = makeDoc("Some text\n## Heading");
    // offset 10 = \n, offset 11 = start of "## " prefix
    const err = applyEdit(doc, 8, 11, "X");
    expect(err).toContain("heading markup");
  });

  it("allows edit starting at first text char of heading", () => {
    doc = makeDoc("## Heading");
    // "## Heading" → prefix is 3 chars, offset 3 = first char "H"
    const err = applyEdit(doc, 3, 10, "Title");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("## Title");
  });

  it("rejects edit at prefixLen - 1", () => {
    doc = makeDoc("## Heading");
    // offset 2 is still inside "## " prefix
    const err = applyEdit(doc, 2, 5, "X");
    expect(err).toContain("heading markup");
  });
});

describe("validation", () => {
  it("from > to returns error", () => {
    doc = makeDoc("Hello");
    const err = applyEdit(doc, 5, 2, "X");
    expect(err).toContain("Invalid range");
  });

  it("from === to with non-empty newText is a valid insert", () => {
    doc = makeDoc("Hello");
    const err = applyEdit(doc, 3, 3, "XYZ");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("HelXYZlo");
  });
});

describe("cross-element edits with formatting", () => {
  it("preserves bold formatting in merged text", () => {
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    doc.transact(() => {
      const p1 = new Y.XmlElement("paragraph");
      fragment.insert(0, [p1]);
      const t1 = new Y.XmlText();
      p1.insert(0, [t1]);
      t1.insert(0, "First line");

      const p2 = new Y.XmlElement("paragraph");
      fragment.insert(1, [p2]);
      const t2 = new Y.XmlText();
      p2.insert(0, [t2]);
      t2.insert(0, "plain bold end");
      t2.format(6, 4, { bold: true });
    });

    // "First line\nplain bold end"
    // offset 6 = start of "line", offset 17 = after "plain " (11+6)
    const err = applyEdit(doc, 6, 17, " ");
    expect(err).toBeNull();

    const resultEl = fragment.get(0) as Y.XmlElement;
    const resultText = resultEl.get(0) as Y.XmlText;
    const delta = resultText.toDelta();

    const boldSeg = delta.find((d: any) => d.attributes?.bold === true);
    expect(boldSeg).toBeDefined();
    expect(boldSeg!.insert).toBe("bold");
  });

  it("handles multi-segment delta with mixed formatting", () => {
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    doc.transact(() => {
      const p1 = new Y.XmlElement("paragraph");
      fragment.insert(0, [p1]);
      const t1 = new Y.XmlText();
      p1.insert(0, [t1]);
      t1.insert(0, "AAA");

      const p2 = new Y.XmlElement("paragraph");
      fragment.insert(1, [p2]);
      const t2 = new Y.XmlText();
      p2.insert(0, [t2]);
      t2.insert(0, "normalitalicbold");
      t2.format(6, 6, { italic: true });
      t2.format(12, 4, { bold: true });
    });

    // "AAA\nnormalitalicbold" — delete from 3 to 10 ("normal" = 4..9)
    const err = applyEdit(doc, 3, 10, "");
    expect(err).toBeNull();

    const resultEl = fragment.get(0) as Y.XmlElement;
    const resultText = resultEl.get(0) as Y.XmlText;
    const delta = resultText.toDelta();

    const italicSeg = delta.find((d: any) => d.attributes?.italic === true);
    expect(italicSeg).toBeDefined();
    expect(italicSeg!.insert).toBe("italic");

    const boldSeg = delta.find((d: any) => d.attributes?.bold === true);
    expect(boldSeg).toBeDefined();
    expect(boldSeg!.insert).toBe("bold");
  });
});

describe("getOrCreateXmlText container guard", () => {
  const containerTypes = [
    "blockquote",
    "bulletList",
    "orderedList",
    "table",
    "tableRow",
    "listItem",
    "tableCell",
    "tableHeader",
  ];

  for (const nodeType of containerTypes) {
    it(`throws on container node: ${nodeType}`, () => {
      const testDoc = new Y.Doc();
      const frag = testDoc.getXmlFragment("default");
      const el = new Y.XmlElement(nodeType);
      frag.insert(0, [el]);
      expect(() => getOrCreateXmlText(el)).toThrow("Cannot create XmlText");
      testDoc.destroy();
    });
  }

  const textblockTypes = ["paragraph", "heading", "codeBlock"];
  for (const nodeType of textblockTypes) {
    it(`succeeds on textblock node: ${nodeType}`, () => {
      const testDoc = new Y.Doc();
      const frag = testDoc.getXmlFragment("default");
      const el = new Y.XmlElement(nodeType);
      frag.insert(0, [el]);
      const text = getOrCreateXmlText(el);
      expect(text).toBeInstanceOf(Y.XmlText);
      testDoc.destroy();
    });
  }
});
