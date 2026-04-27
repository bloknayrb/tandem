import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyTextEdit,
  extractText,
  getOrCreateXmlText,
  resolveOffset,
} from "../../src/server/mcp/document.js";
import { validateDocStructure } from "../../src/server/mcp/document-model.js";
import { makeDoc } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

/**
 * Test wrapper around `applyTextEdit` — mirrors the validation surface of
 * tandem_edit but returns the error message instead of an MCP response.
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

  applyTextEdit(doc, fragment, startPos, endPos, newText);
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

  it("drops endText entirely when endPos.textOffset === endText.length", () => {
    // Cross-element edit where the end of the range lies at the end of endText.
    // The merge loop should produce nothing from endText; only newText should
    // land in startText. Locks in the boundary in any future delta-walk variant.
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");

    const p1 = new Y.XmlElement("paragraph");
    fragment.insert(0, [p1]);
    const t1 = new Y.XmlText();
    p1.insert(0, [t1]);
    t1.insert(0, "alpha");

    const p2 = new Y.XmlElement("paragraph");
    fragment.insert(1, [p2]);
    const t2 = new Y.XmlText();
    p2.insert(0, [t2]);
    t2.insert(0, "beta");

    // text: "alpha\nbeta" — replace "ha\nbeta" (offsets 3..10) with "X"
    const err = applyEdit(doc, 3, 10, "X");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("alpX");
    expect(fragment.length).toBe(1);
  });

  it("rejects oversized embeds at the merge boundary", () => {
    // Build a Y.XmlElement embed with > 1024 nested AbstractType children.
    // applyTextEdit must reject the merge before mutating the doc.
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");

    const p1 = new Y.XmlElement("paragraph");
    fragment.insert(0, [p1]);
    const t1 = new Y.XmlText();
    p1.insert(0, [t1]);
    t1.insert(0, "abc");

    const p2 = new Y.XmlElement("paragraph");
    fragment.insert(1, [p2]);
    const t2 = new Y.XmlText();
    p2.insert(0, [t2]);

    // Build a Y.XmlElement with 1100 children — over the 1024 cap.
    const oversized = new Y.XmlElement("hardBreak");
    for (let i = 0; i < 1100; i++) {
      oversized.insert(i, [new Y.XmlElement("hardBreak")]);
    }
    t2.insert(0, "y");
    t2.insertEmbed(0, oversized);
    // p2 = <oversized><br>y, length 2

    // Edit [3, 4) — pulls everything from p2 into p1. The oversized embed
    // would be at the start of remaining; cap should kick in.
    const before = extractText(doc);
    expect(() => applyEdit(doc, 3, 4, "X")).toThrow(/clone-size cap/);
    // Doc state unchanged because the throw happens pre-mutation.
    expect(extractText(doc)).toBe(before);
  });

  it("preserves a hardBreak embed at the merge boundary", () => {
    // Cross-element edit that pulls part of p2 (including a hardBreak embed)
    // into p1. Verifies the AbstractType.clone() detach path on the embed.
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");

    const p1 = new Y.XmlElement("paragraph");
    fragment.insert(0, [p1]);
    const t1 = new Y.XmlText();
    p1.insert(0, [t1]);
    t1.insert(0, "abc");

    const p2 = new Y.XmlElement("paragraph");
    fragment.insert(1, [p2]);
    const t2 = new Y.XmlText();
    p2.insert(0, [t2]);
    t2.insert(0, "x");
    t2.insertEmbed(1, new Y.XmlElement("hardBreak"));
    t2.insert(2, "y");
    // p2 = "x<br>y", XmlText length 3

    // Flat offsets: 0..2='abc', 3=sep, 4='x', 5=embed, 6='y'
    // Edit [2, 5) → drops "c", sep, "x"; keeps the embed onward.
    const err = applyEdit(doc, 2, 5, "Z");
    expect(err).toBeNull();

    expect(fragment.length).toBe(1);
    const merged = fragment.get(0) as Y.XmlElement;
    const mergedText = merged.get(0) as Y.XmlText;
    const delta = mergedText.toDelta();

    // Expected: "abZ" + hardBreak + "y"
    expect(delta.length).toBe(3);
    expect(delta[0].insert).toBe("abZ");
    expect(delta[1].insert).toBeInstanceOf(Y.XmlElement);
    expect((delta[1].insert as Y.XmlElement).nodeName).toBe("hardBreak");
    expect(delta[2].insert).toBe("y");
  });
});

describe("getOrCreateXmlText container guard", () => {
  it("throws on container element types", () => {
    const containers = [
      "bulletList",
      "orderedList",
      "blockquote",
      "table",
      "tableRow",
      "tableCell",
      "tableHeader",
      "listItem",
      // Embed-type names — these live inside XmlText, not as fragment children,
      // so they cannot reach the guard via tandem_edit. Listed here so the test
      // documents the full set of non-textblock node names rejected.
      "image",
      "horizontalRule",
      "hardBreak",
    ];
    for (const name of containers) {
      const d = new Y.Doc();
      const fragment = d.getXmlFragment("content");
      const el = new Y.XmlElement(name);
      fragment.insert(0, [el]);

      expect(() => getOrCreateXmlText(el), `should throw for ${name}`).toThrow(
        /Cannot create XmlText/,
      );
      d.destroy();
    }
  });

  it("allows paragraph elements", () => {
    const d = new Y.Doc();
    const fragment = d.getXmlFragment("content");
    const para = new Y.XmlElement("paragraph");
    fragment.insert(0, [para]);

    expect(() => getOrCreateXmlText(para)).not.toThrow();
    d.destroy();
  });

  it("allows heading elements", () => {
    const d = new Y.Doc();
    const fragment = d.getXmlFragment("content");
    const heading = new Y.XmlElement("heading");
    heading.setAttribute("level", 2 as any);
    fragment.insert(0, [heading]);

    expect(() => getOrCreateXmlText(heading)).not.toThrow();
    d.destroy();
  });

  it("allows codeBlock elements", () => {
    const d = new Y.Doc();
    const fragment = d.getXmlFragment("content");
    const codeBlock = new Y.XmlElement("codeBlock");
    fragment.insert(0, [codeBlock]);

    expect(() => getOrCreateXmlText(codeBlock)).not.toThrow();
    d.destroy();
  });
});

describe("validateDocStructure", () => {
  it("returns no violations for a well-formed doc", () => {
    const d = makeDoc("Hello\nWorld");
    expect(validateDocStructure(d)).toEqual([]);
    d.destroy();
  });

  it("flags a fragment-child container that holds an XmlText", () => {
    const d = new Y.Doc();
    const fragment = d.getXmlFragment("default");
    const bad = new Y.XmlElement("bulletList");
    fragment.insert(0, [bad]);
    bad.insert(0, [new Y.XmlText("phantom")]);

    const violations = validateDocStructure(d);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toMatch(/bulletList.*XmlText/);
    d.destroy();
  });

  it("accepts containers whose children are XmlElements", () => {
    const d = new Y.Doc();
    const fragment = d.getXmlFragment("default");
    const list = new Y.XmlElement("bulletList");
    fragment.insert(0, [list]);
    const item = new Y.XmlElement("listItem");
    list.insert(0, [item]);
    const para = new Y.XmlElement("paragraph");
    item.insert(0, [para]);
    para.insert(0, [new Y.XmlText("hi")]);

    expect(validateDocStructure(d)).toEqual([]);
    d.destroy();
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
