/**
 * Tests for normalizeHardBreaks (#1206).
 *
 * The importers store a hard break as a `hardBreak` embed inside a Y.XmlText;
 * y-prosemirror can't render that (it stringifies to the literal
 * <hardbreak></hardbreak>). normalizeHardBreaks rewrites the embed into a
 * standalone sibling hardBreak element — the shape user-typed Shift+Enter
 * produces — WITHOUT changing flat text or flat length.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { normalizeHardBreaks } from "../../src/server/file-io/hardbreak-normalize.js";
import { getElementText, getElementTextLength } from "../../src/server/mcp/document-model.js";

type Seg = { text: string; marks?: Record<string, object> } | { break: true };

/**
 * Build a textblock element (attached to a fresh doc) whose single Y.XmlText child
 * holds the given segments — hard breaks inserted as EMBEDS, exactly as the
 * importers produce them before normalization runs.
 */
function makeEmbedParagraph(segs: Seg[], nodeName = "paragraph"): { doc: Y.Doc; el: Y.XmlElement } {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment("default");
  const el = new Y.XmlElement(nodeName);
  const xt = new Y.XmlText();
  frag.insert(0, [el]); // attach element
  el.insert(0, [xt]); // attach XmlText before populating (ordering gotcha)
  for (const seg of segs) {
    if ("break" in seg) {
      xt.insertEmbed(xt.length, new Y.XmlElement("hardBreak"));
    } else {
      xt.insert(xt.length, seg.text, seg.marks ?? {});
    }
  }
  return { doc, el };
}

/** The direct-child shape of a textblock: "text:<plain value>" or the node name. */
function childShape(el: Y.XmlElement): string[] {
  const shape: string[] = [];
  for (let i = 0; i < el.length; i++) {
    const c = el.get(i);
    if (c instanceof Y.XmlText) {
      // Plain text only (marks stripped) — toString() would render <bold> tags.
      let plain = "";
      for (const op of c.toDelta()) if (typeof op.insert === "string") plain += op.insert;
      shape.push(`text:${plain}`);
    } else if (c instanceof Y.XmlElement) {
      shape.push(c.nodeName);
    }
  }
  return shape;
}

function noEmbeds(el: Y.XmlElement): boolean {
  for (let i = 0; i < el.length; i++) {
    const c = el.get(i);
    if (c instanceof Y.XmlText) {
      for (const op of c.toDelta()) if (typeof op.insert !== "string") return false;
    } else if (c instanceof Y.XmlElement && !noEmbeds(c)) {
      return false;
    }
  }
  return true;
}

describe("normalizeHardBreaks — flat invariance + sibling shape", () => {
  it("mid-paragraph break splits into text/hardBreak/text, flat text unchanged", () => {
    const { el } = makeEmbedParagraph([{ text: "before" }, { break: true }, { text: "after" }]);
    const textBefore = getElementText(el);
    const lenBefore = getElementTextLength(el);

    normalizeHardBreaks([el]);

    expect(childShape(el)).toEqual(["text:before", "hardBreak", "text:after"]);
    expect(noEmbeds(el)).toBe(true);
    expect(getElementText(el)).toBe(textBefore);
    expect(getElementText(el)).toBe("before\nafter");
    expect(getElementTextLength(el)).toBe(lenBefore);
  });

  it("leading break keeps an empty leading Y.XmlText (flat length invariant)", () => {
    const { el } = makeEmbedParagraph([{ break: true }, { text: "after" }]);
    const lenBefore = getElementTextLength(el); // "\nafter" → 6

    normalizeHardBreaks([el]);

    expect(childShape(el)).toEqual(["text:", "hardBreak", "text:after"]);
    expect(getElementTextLength(el)).toBe(lenBefore);
    expect(getElementTextLength(el)).toBe(6);
    expect(getElementText(el)).toBe("\nafter");
  });

  it("trailing break keeps an empty trailing Y.XmlText", () => {
    const { el } = makeEmbedParagraph([{ text: "before" }, { break: true }]);
    const lenBefore = getElementTextLength(el);
    normalizeHardBreaks([el]);
    expect(childShape(el)).toEqual(["text:before", "hardBreak", "text:"]);
    expect(getElementTextLength(el)).toBe(lenBefore);
    expect(getElementText(el)).toBe("before\n");
  });

  it("consecutive breaks split with an empty text between them", () => {
    const { el } = makeEmbedParagraph([
      { text: "a" },
      { break: true },
      { break: true },
      { text: "b" },
    ]);
    const textBefore = getElementText(el);
    const lenBefore = getElementTextLength(el);
    normalizeHardBreaks([el]);
    expect(childShape(el)).toEqual(["text:a", "hardBreak", "text:", "hardBreak", "text:b"]);
    expect(getElementText(el)).toBe(textBefore);
    expect(getElementText(el)).toBe("a\n\nb");
    expect(getElementTextLength(el)).toBe(lenBefore);
  });

  it("preserves marks on the surrounding runs (incl. break inside one mark)", () => {
    const { el } = makeEmbedParagraph([
      { text: "x", marks: { bold: {} } },
      { break: true },
      { text: "y", marks: { italic: {} } },
    ]);
    normalizeHardBreaks([el]);
    expect(childShape(el)).toEqual(["text:x", "hardBreak", "text:y"]);
    const d0 = (el.get(0) as Y.XmlText).toDelta();
    const d2 = (el.get(2) as Y.XmlText).toDelta();
    expect(d0[0].attributes?.bold).toEqual({});
    expect(d2[0].attributes?.italic).toEqual({});

    // <br> inside bold: both runs keep bold.
    const both = makeEmbedParagraph([
      { text: "x", marks: { bold: {} } },
      { break: true },
      { text: "y", marks: { bold: {} } },
    ]);
    normalizeHardBreaks([both.el]);
    expect((both.el.get(0) as Y.XmlText).toDelta()[0].attributes?.bold).toEqual({});
    expect((both.el.get(2) as Y.XmlText).toDelta()[0].attributes?.bold).toEqual({});
  });

  it("document order is preserved for multiple breaks", () => {
    const { el } = makeEmbedParagraph([
      { text: "1" },
      { break: true },
      { text: "2" },
      { break: true },
      { text: "3" },
    ]);
    normalizeHardBreaks([el]);
    expect(childShape(el)).toEqual(["text:1", "hardBreak", "text:2", "hardBreak", "text:3"]);
    expect(getElementText(el)).toBe("1\n2\n3");
  });

  it("recurses into nested containers (blockquote / listItem / tableCell)", () => {
    for (const container of ["blockquote", "listItem", "tableCell"]) {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment("default");
      const outer = new Y.XmlElement(container);
      const para = new Y.XmlElement("paragraph");
      const xt = new Y.XmlText();
      frag.insert(0, [outer]);
      outer.insert(0, [para]);
      para.insert(0, [xt]);
      xt.insert(0, "a");
      xt.insertEmbed(xt.length, new Y.XmlElement("hardBreak"));
      xt.insert(xt.length, "b");

      const textBefore = getElementText(para);
      const lenBefore = getElementTextLength(para);

      normalizeHardBreaks([outer]);

      expect(childShape(para)).toEqual(["text:a", "hardBreak", "text:b"]);
      expect(noEmbeds(outer)).toBe(true);
      // Offset-invariance guard also holds inside a container.
      expect(getElementText(para)).toBe(textBefore);
      expect(getElementTextLength(para)).toBe(lenBefore);
    }
  });

  it("is idempotent — already-sibling and no-break paragraphs are unchanged", () => {
    const { el } = makeEmbedParagraph([{ text: "before" }, { break: true }, { text: "after" }]);
    normalizeHardBreaks([el]);
    const once = childShape(el);
    normalizeHardBreaks([el]); // second pass: no embeds remain → no-op
    expect(childShape(el)).toEqual(once);

    const plain = makeEmbedParagraph([{ text: "just text" }]);
    normalizeHardBreaks([plain.el]);
    expect(childShape(plain.el)).toEqual(["text:just text"]);
  });
});
