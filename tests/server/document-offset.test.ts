import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { extractText, resolveOffset } from "../../src/server/mcp/document.js";
import { validateRange } from "../../src/server/positions.js";
import { getFragment, makeDoc, makeEmptyDoc, makeMarkdownDoc } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

describe("resolveOffset", () => {
  describe('single paragraph doc ("Hello world")', () => {
    beforeEach(() => {
      doc = makeDoc("Hello world");
    });

    it("offset 0 → start of element", () => {
      const result = resolveOffset(getFragment(doc), 0);
      expect(result).toEqual({ elementIndex: 0, textOffset: 0, clampedFromPrefix: false });
    });

    it("offset 5 → middle of text", () => {
      const result = resolveOffset(getFragment(doc), 5);
      expect(result).toEqual({ elementIndex: 0, textOffset: 5, clampedFromPrefix: false });
    });

    it("offset 11 → end of text", () => {
      // "Hello world" has 11 chars, offset 11 is past end of element content
      // but within the element's full length, so it clamps to end
      const result = resolveOffset(getFragment(doc), 11);
      expect(result).toEqual({ elementIndex: 0, textOffset: 11, clampedFromPrefix: false });
    });
  });

  describe('multi-paragraph doc ("Hello\\nWorld")', () => {
    beforeEach(() => {
      doc = makeDoc("Hello\nWorld");
      // extractText: "Hello\nWorld" → H=0 e=1 l=2 l=3 o=4 \n=5 W=6 o=7 r=8 l=9 d=10
    });

    it("offset 0 → first element, start", () => {
      expect(resolveOffset(getFragment(doc), 0)).toEqual({
        elementIndex: 0,
        textOffset: 0,
        clampedFromPrefix: false,
      });
    });

    it('offset 4 → first element, "o"', () => {
      expect(resolveOffset(getFragment(doc), 4)).toEqual({
        elementIndex: 0,
        textOffset: 4,
        clampedFromPrefix: false,
      });
    });

    it("offset 5 (\\n separator) → end of first element", () => {
      // This hits the distinct separator code path (document.ts:163-167)
      expect(resolveOffset(getFragment(doc), 5)).toEqual({
        elementIndex: 0,
        textOffset: 5,
        clampedFromPrefix: false,
      });
    });

    it("offset 6 → start of second element", () => {
      expect(resolveOffset(getFragment(doc), 6)).toEqual({
        elementIndex: 1,
        textOffset: 0,
        clampedFromPrefix: false,
      });
    });

    it("offset 10 → end of second element", () => {
      expect(resolveOffset(getFragment(doc), 10)).toEqual({
        elementIndex: 1,
        textOffset: 4,
        clampedFromPrefix: false,
      });
    });
  });

  describe('three paragraph doc ("A\\nB\\nC")', () => {
    beforeEach(() => {
      doc = makeDoc("A\nB\nC");
      // A=0 \n=1 B=2 \n=3 C=4
    });

    it("offset 0 → element 0", () => {
      expect(resolveOffset(getFragment(doc), 0)).toEqual({
        elementIndex: 0,
        textOffset: 0,
        clampedFromPrefix: false,
      });
    });

    it("offset 1 (\\n) → end of element 0", () => {
      expect(resolveOffset(getFragment(doc), 1)).toEqual({
        elementIndex: 0,
        textOffset: 1,
        clampedFromPrefix: false,
      });
    });

    it("offset 2 → start of element 1", () => {
      expect(resolveOffset(getFragment(doc), 2)).toEqual({
        elementIndex: 1,
        textOffset: 0,
        clampedFromPrefix: false,
      });
    });

    it("offset 3 (\\n) → end of element 1", () => {
      expect(resolveOffset(getFragment(doc), 3)).toEqual({
        elementIndex: 1,
        textOffset: 1,
        clampedFromPrefix: false,
      });
    });

    it("offset 4 → start of element 2", () => {
      expect(resolveOffset(getFragment(doc), 4)).toEqual({
        elementIndex: 2,
        textOffset: 0,
        clampedFromPrefix: false,
      });
    });
  });

  describe('heading prefix handling ("## Title\\nBody")', () => {
    beforeEach(() => {
      doc = makeDoc("## Title\nBody");
      // extractText: "## Title\nBody"
      // ##_=0,1,2 T=3 i=4 t=5 l=6 e=7 \n=8 B=9 o=10 d=11 y=12
    });

    it('offset 0 (inside "## ") → clampedFromPrefix', () => {
      expect(resolveOffset(getFragment(doc), 0)).toEqual({
        elementIndex: 0,
        textOffset: 0,
        clampedFromPrefix: true,
      });
    });

    it('offset 1 (inside "## ") → clampedFromPrefix', () => {
      expect(resolveOffset(getFragment(doc), 1)).toEqual({
        elementIndex: 0,
        textOffset: 0,
        clampedFromPrefix: true,
      });
    });

    it('offset 2 (last char of "## ") → clampedFromPrefix', () => {
      expect(resolveOffset(getFragment(doc), 2)).toEqual({
        elementIndex: 0,
        textOffset: 0,
        clampedFromPrefix: true,
      });
    });

    it('offset 3 (first char "T") → NOT clamped', () => {
      expect(resolveOffset(getFragment(doc), 3)).toEqual({
        elementIndex: 0,
        textOffset: 0,
        clampedFromPrefix: false,
      });
    });

    it('offset 7 ("e" in Title) → textOffset 4', () => {
      expect(resolveOffset(getFragment(doc), 7)).toEqual({
        elementIndex: 0,
        textOffset: 4,
        clampedFromPrefix: false,
      });
    });

    it("offset 8 (\\n separator) → end of heading text", () => {
      expect(resolveOffset(getFragment(doc), 8)).toEqual({
        elementIndex: 0,
        textOffset: 5,
        clampedFromPrefix: false,
      });
    });

    it('offset 9 ("B" of Body) → start of second element', () => {
      expect(resolveOffset(getFragment(doc), 9)).toEqual({
        elementIndex: 1,
        textOffset: 0,
        clampedFromPrefix: false,
      });
    });
  });

  describe("edge cases", () => {
    it("empty document returns null", () => {
      doc = makeEmptyDoc();
      expect(resolveOffset(getFragment(doc), 0)).toBeNull();
    });

    it("offset past document end clamps to last element", () => {
      doc = makeDoc("Hello");
      const result = resolveOffset(getFragment(doc), 100);
      expect(result).toEqual({ elementIndex: 0, textOffset: 5, clampedFromPrefix: false });
    });

    it("offset past end of multi-element doc clamps to last element", () => {
      doc = makeDoc("A\nB");
      const result = resolveOffset(getFragment(doc), 100);
      expect(result).toEqual({ elementIndex: 1, textOffset: 1, clampedFromPrefix: false });
    });
  });
});

describe("blockquote offset consistency (Issue #148)", () => {
  afterEach(() => {
    doc?.destroy();
  });

  it("extractText offsets match validateRange for text after a blockquote", () => {
    doc = makeMarkdownDoc("# Title\n\n> A blockquote line\n\nText after blockquote");
    const text = extractText(doc);

    const target = "Text after blockquote";
    const from = text.indexOf(target);
    expect(from).toBeGreaterThan(-1);
    const to = from + target.length;

    const result = validateRange(doc, from, to, { textSnapshot: target });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.range.from).toBe(from);
      expect(result.range.to).toBe(to);
    }
  });

  it("extractText offsets match validateRange for text after multiple blockquotes", () => {
    doc = makeMarkdownDoc("Intro\n\n> Quote one\n\n> Quote two\n\nAfter quotes");
    const text = extractText(doc);

    const target = "After quotes";
    const from = text.indexOf(target);
    expect(from).toBeGreaterThan(-1);
    const to = from + target.length;

    const result = validateRange(doc, from, to, { textSnapshot: target });
    expect(result.ok).toBe(true);
  });
});
