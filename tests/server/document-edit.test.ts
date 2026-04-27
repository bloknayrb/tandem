import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  extractText,
  getOrCreateXmlText,
  mergeXmlText,
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
      mergeXmlText(startText, endText, startPos.textOffset);
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

describe("formatted cross-element edits (regression #425)", () => {
  it("preserves bold formatting when merging across paragraphs", () => {
    // Build a doc with two paragraphs where the second has bold text:
    //   "First paragraph"  (plain)
    //   "Bold second"      (bold)
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");

    const p1 = new Y.XmlElement("paragraph");
    fragment.insert(0, [p1]);
    const t1 = new Y.XmlText();
    p1.insert(0, [t1]);
    t1.insert(0, "First paragraph");

    const p2 = new Y.XmlElement("paragraph");
    fragment.insert(1, [p2]);
    const t2 = new Y.XmlText();
    p2.insert(0, [t2]);
    t2.insert(0, "Bold second");
    t2.format(0, 11, { bold: true });

    // Verify setup: "First paragraph\nBold second"
    expect(extractText(doc)).toBe("First paragraph\nBold second");

    // Cross-element edit: replace " paragraph\nBold " with " and "
    // offsets: "First" = 0..4, " paragraph" = 5..14, \n = 15, "Bold " = 16..20, "second" = 21..26
    const err = applyEdit(doc, 5, 21, " and ");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("First and second");

    // The surviving "second" text should retain bold formatting
    const merged = fragment.get(0) as Y.XmlElement;
    const mergedText = merged.get(0) as Y.XmlText;
    const delta = mergedText.toDelta();

    // Delta should be: [{insert: "First and "}, {insert: "second", attributes: {bold: true}}]
    expect(delta.length).toBe(2);
    expect(delta[0].insert).toBe("First and ");
    expect(delta[0].attributes).toBeUndefined();
    expect(delta[1].insert).toBe("second");
    expect(delta[1].attributes).toEqual({ bold: true });
  });

  it("preserves hardBreak embed when merging across paragraphs", () => {
    // p1: "First"
    // p2: "Line one<hardBreak>after" — surviving suffix "<hardBreak>after"
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");

    const p1 = new Y.XmlElement("paragraph");
    fragment.insert(0, [p1]);
    const t1 = new Y.XmlText();
    p1.insert(0, [t1]);
    t1.insert(0, "First");

    const p2 = new Y.XmlElement("paragraph");
    fragment.insert(1, [p2]);
    const t2 = new Y.XmlText();
    p2.insert(0, [t2]);
    t2.insert(0, "Line one");
    t2.insertEmbed(t2.length, new Y.XmlElement("hardBreak"));
    t2.insert(t2.length, "after");

    // Embed counts as 1 in canonical index space; extractText emits \n for embeds.
    // Top-level fragment join is also \n. Both contribute to the flat offset.
    expect(t2.length).toBe(8 + 1 + 5); // "Line one" + embed + "after" = 14
    expect(extractText(doc)).toBe("First\nLine one\nafter");

    // Replace "rst\nLine on" (offsets 2..13) with " " — the cut leaves "e<hardBreak>after"
    // in the surviving suffix of p2.
    const err = applyEdit(doc, 2, 13, " ");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("Fi e\nafter");

    const merged = fragment.get(0) as Y.XmlElement;
    const mergedText = merged.get(0) as Y.XmlText;
    const delta = mergedText.toDelta();

    // Expected delta: [{insert: "Fi "}, {insert: "e"}, {insert: <hardBreak>}, {insert: "after"}]
    // Adjacent string segments may or may not be merged depending on currentAttributes
    // boundaries, so assert structurally rather than counting segments.
    const stringInserts = delta
      .filter((d: { insert: unknown }) => typeof d.insert === "string")
      .map((d: { insert: string }) => d.insert)
      .join("");
    expect(stringInserts).toBe("Fi eafter");

    const embeds = delta.filter((d: { insert: unknown }) => d.insert instanceof Y.XmlElement);
    expect(embeds.length).toBe(1);
    expect((embeds[0].insert as Y.XmlElement).nodeName).toBe("hardBreak");

    // The cloned embed must be a fresh instance — endText was deleted.
    // Confirm fragment is now a single paragraph.
    expect(fragment.length).toBe(1);
  });

  it("preserves combined marks (bold + italic) when merging across paragraphs", () => {
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");

    const p1 = new Y.XmlElement("paragraph");
    fragment.insert(0, [p1]);
    const t1 = new Y.XmlText();
    p1.insert(0, [t1]);
    t1.insert(0, "Plain start");

    const p2 = new Y.XmlElement("paragraph");
    fragment.insert(1, [p2]);
    const t2 = new Y.XmlText();
    p2.insert(0, [t2]);
    t2.insert(0, "fancy tail");
    // Apply both bold and italic to the entire string
    t2.format(0, 10, { bold: true, italic: true });

    expect(extractText(doc)).toBe("Plain start\nfancy tail");

    // Replace "n start\nfancy " (offsets 4..18) with " " — surviving suffix "tail" with both marks
    const err = applyEdit(doc, 4, 18, " ");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("Plai tail");

    const merged = fragment.get(0) as Y.XmlElement;
    const mergedText = merged.get(0) as Y.XmlText;
    const delta = mergedText.toDelta();

    // Find the "tail" segment and verify it carries BOTH marks
    const tailSeg = delta.find(
      (d: { insert: unknown }) => typeof d.insert === "string" && d.insert.includes("tail"),
    );
    expect(tailSeg).toBeDefined();
    expect(tailSeg?.attributes).toEqual({ bold: true, italic: true });
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
