import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { extractText, resolveOffset } from "../../src/server/mcp/document.js";
import {
  getElementTextLength,
  getOrCreateXmlText,
  mergeInlineTail,
  replaceFlatRangeInElement,
} from "../../src/server/mcp/document-model.js";
import { makeDoc } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

/**
 * Replicate tandem_edit logic for testing. MUST mirror the real branches in
 * `mcp/document.ts` (the multi-Y.XmlText helpers), not the pre-#1206 first-XmlText
 * path — otherwise these tests validate a stale copy instead of the fix.
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
      replaceFlatRangeInElement(
        startNode,
        startPos.textOffset,
        getElementTextLength(startNode),
        "",
      );

      const deleteCount = endPos.elementIndex - startPos.elementIndex - 1;
      for (let i = 0; i < deleteCount; i++) {
        fragment.delete(startPos.elementIndex + 1, 1);
      }

      const endNode = fragment.get(startPos.elementIndex + 1) as Y.XmlElement;
      replaceFlatRangeInElement(endNode, 0, endPos.textOffset, "");

      if (newText.length > 0) {
        const joinAt = startPos.textOffset;
        replaceFlatRangeInElement(startNode, joinAt, joinAt, newText);
      }
      mergeInlineTail(startNode, endNode);

      fragment.delete(startPos.elementIndex + 1, 1);
    });
  } else {
    doc.transact(() => {
      const node = fragment.get(startPos.elementIndex) as Y.XmlElement;
      replaceFlatRangeInElement(node, startPos.textOffset, endPos.textOffset, newText);
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

describe("replacement text inline formatting (#1206)", () => {
  // Regression guard: the multi-XmlText edit primitive must insert replacement
  // text INHERITING the formatting open at the insertion point (like typing),
  // matching the pre-#1206 bare `textNode.insert(offset, newText)`. A stray `{}`
  // attributes arg terminates inheritance and silently strips the run's bold/italic.
  function boldWordDoc(word: string): Y.Doc {
    const d = new Y.Doc();
    const fragment = d.getXmlFragment("default");
    d.transact(() => {
      const p = new Y.XmlElement("paragraph");
      fragment.insert(0, [p]);
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, word);
      t.format(0, word.length, { bold: true });
    });
    return d;
  }

  it("replacing text inside a bold run keeps the replacement bold", () => {
    doc = boldWordDoc("quick"); // fully bold
    const err = applyEdit(doc, 1, 4, "low"); // "q[uic]k" → "q[low]k"
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("qlowk");
    const ops = ((doc.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText).toDelta();
    // The whole run stays bold — the replacement did not terminate formatting.
    expect(ops.every((d: any) => d.attributes?.bold === true)).toBe(true);
    expect(ops.map((d: any) => d.insert).join("")).toBe("qlowk");
  });

  it("inserting inside a bold run makes the inserted text bold", () => {
    doc = boldWordDoc("quick");
    const err = applyEdit(doc, 2, 2, "XX"); // insert mid-run
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("quXXick");
    const ops = ((doc.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText).toDelta();
    expect(ops.every((d: any) => d.attributes?.bold === true)).toBe(true);
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
    // offset 6 = start of "line", offset 17 = start of "bold" (11 + 6)
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

  it("correctly deletes from formatted start element (Bug A regression)", () => {
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    doc.transact(() => {
      const p1 = new Y.XmlElement("paragraph");
      fragment.insert(0, [p1]);
      const t1 = new Y.XmlText();
      p1.insert(0, [t1]);
      t1.insert(0, "Hello world");
      t1.format(0, 5, { bold: true });

      const p2 = new Y.XmlElement("paragraph");
      fragment.insert(1, [p2]);
      const t2 = new Y.XmlText();
      p2.insert(0, [t2]);
      t2.insert(0, "Second");
    });

    // "Hello world\nSecond" — delete from offset 3 to 14 ("ond")
    // startText = "Hello world" with bold on "Hello", startLen should be 11
    // With toString().length it would be 24 (<bold>Hello</bold> world) → over-delete
    const err = applyEdit(doc, 3, 15, "X");
    expect(err).toBeNull();

    const resultEl = fragment.get(0) as Y.XmlElement;
    const resultText = resultEl.get(0) as Y.XmlText;
    const delta = resultText.toDelta();

    expect(extractText(doc)).toBe("HelXond");
    const boldSeg = delta.find((d: any) => d.attributes?.bold === true);
    expect(boldSeg).toBeDefined();
    expect((boldSeg!.insert as string).startsWith("Hel")).toBe(true);
  });

  it("preserves hardBreak embed in cross-element merge", () => {
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
      t2.insert(0, "before");
      const br = new Y.XmlElement("hardBreak");
      t2.insertEmbed(6, br);
      t2.insert(7, "after");
    });

    // "AAA\nbefore[hardBreak]after" — delete from 3 to 4 (just the newline)
    const err = applyEdit(doc, 3, 4, "");
    expect(err).toBeNull();

    const resultEl = fragment.get(0) as Y.XmlElement;
    const resultText = resultEl.get(0) as Y.XmlText;
    const delta = resultText.toDelta();

    const embedSeg = delta.find((d: any) => typeof d.insert !== "string");
    expect(embedSeg).toBeDefined();
    const allText = delta
      .filter((d: any) => typeof d.insert === "string")
      .map((d: any) => d.insert)
      .join("");
    expect(allText).toContain("before");
    expect(allText).toContain("after");
  });

  it("plain text after bold stays plain via ?? {} inheritance prevention", () => {
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    doc.transact(() => {
      const p1 = new Y.XmlElement("paragraph");
      fragment.insert(0, [p1]);
      const t1 = new Y.XmlText();
      p1.insert(0, [t1]);
      t1.insert(0, "bold start");
      t1.format(0, 10, { bold: true });

      const p2 = new Y.XmlElement("paragraph");
      fragment.insert(1, [p2]);
      const t2 = new Y.XmlText();
      p2.insert(0, [t2]);
      t2.insert(0, "plain text");
    });

    // "bold start\nplain text" — delete from 5 to 11 (end of "start" + newline)
    const err = applyEdit(doc, 5, 11, "");
    expect(err).toBeNull();

    const resultEl = fragment.get(0) as Y.XmlElement;
    const resultText = resultEl.get(0) as Y.XmlText;
    const delta = resultText.toDelta();

    const plainSeg = delta.find((d: any) => d.insert === "plain text");
    expect(plainSeg).toBeDefined();
    expect(plainSeg!.attributes?.bold).toBeUndefined();
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

// ---------------------------------------------------------------------------
// #1206 — edits on paragraphs that contain sibling hardBreaks. Before the fix
// these corrupted the doc (first-XmlText-only path threw mid-transaction on a
// multi-XmlText paragraph, which Y.js does not roll back).
// ---------------------------------------------------------------------------

/** Build a doc whose single paragraph is [XmlText, hardBreak, XmlText] (sibling form). */
function makeBrokenParagraphDoc(before: string, after: string): Y.Doc {
  const d = new Y.Doc();
  const frag = d.getXmlFragment("default");
  const para = new Y.XmlElement("paragraph");
  const t1 = new Y.XmlText();
  const br = new Y.XmlElement("hardBreak");
  const t2 = new Y.XmlText();
  frag.insert(0, [para]);
  para.insert(0, [t1, br, t2]);
  t1.insert(0, before);
  t2.insert(0, after);
  return d;
}

/** Two paragraphs, each carrying a sibling hardBreak. */
function makeTwoBrokenParagraphsDoc(): Y.Doc {
  const d = new Y.Doc();
  const frag = d.getXmlFragment("default");
  for (const [a, b] of [
    ["one", "two"],
    ["three", "four"],
  ]) {
    const para = new Y.XmlElement("paragraph");
    const t1 = new Y.XmlText();
    const br = new Y.XmlElement("hardBreak");
    const t2 = new Y.XmlText();
    frag.insert(frag.length, [para]);
    para.insert(0, [t1, br, t2]);
    t1.insert(0, a);
    t2.insert(0, b);
  }
  return d;
}

describe("edits across sibling hardBreaks (#1206 corruption guard)", () => {
  it("edit fully after the break replaces the correct XmlText", () => {
    doc = makeBrokenParagraphDoc("before", "after"); // "before\nafter"
    // Replace "after" (offsets 7..12) with "AFTER".
    const err = applyEdit(doc, 7, 12, "AFTER");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("before\nAFTER");
  });

  it("edit fully before the break replaces the correct XmlText", () => {
    doc = makeBrokenParagraphDoc("before", "after");
    const err = applyEdit(doc, 0, 6, "BEFORE");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("BEFORE\nafter");
  });

  it("edit spanning the break deletes it and joins the two runs", () => {
    doc = makeBrokenParagraphDoc("before", "after"); // "before\nafter"
    // Replace "re\naf" (offsets 4..9) with "X" → "befoXter".
    const err = applyEdit(doc, 4, 9, "X");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("befoXter");
  });

  it("empty-newText delete spanning the break removes it", () => {
    doc = makeBrokenParagraphDoc("before", "after");
    const err = applyEdit(doc, 6, 7, ""); // delete just the "\n"
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("beforeafter");
  });

  it("insertion exactly at the break boundary does not throw or corrupt", () => {
    doc = makeBrokenParagraphDoc("before", "after");
    const err = applyEdit(doc, 7, 7, "X"); // insert at start of "after"
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("before\nXafter");
  });

  it("insertion exactly AT a break's flat offset appends before the break (fallback path)", () => {
    // offset 6 lands ON the break (findXmlTextAtOffset returns null), exercising
    // insertPlainTextAtOffset's "text child ending at offset" fallback.
    doc = makeBrokenParagraphDoc("before", "after"); // "before\nafter", break at flat 6
    const err = applyEdit(doc, 6, 6, "X");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("beforeX\nafter");
  });

  it("edit spanning MULTIPLE breaks in one paragraph deletes them all (back-to-front)", () => {
    // paragraph [t"a", br, t"b", br, t"c"] → flat "a\nb\nc" (a=0,\n=1,b=2,\n=3,c=4).
    // Exercises the back-to-front span deletion that removes 2+ break siblings in
    // one range without index invalidation.
    doc = new Y.Doc();
    const frag = doc.getXmlFragment("default");
    const para = new Y.XmlElement("paragraph");
    const [t1, t2, t3] = [new Y.XmlText(), new Y.XmlText(), new Y.XmlText()];
    frag.insert(0, [para]);
    para.insert(0, [t1, new Y.XmlElement("hardBreak"), t2, new Y.XmlElement("hardBreak"), t3]);
    t1.insert(0, "a");
    t2.insert(0, "b");
    t3.insert(0, "c");
    expect(extractText(doc)).toBe("a\nb\nc");
    const err = applyEdit(doc, 1, 4, "X"); // delete "\nb\n" across BOTH breaks
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("aXc");
  });

  it("edit deleting the first of two breaks keeps the second", () => {
    doc = new Y.Doc();
    const frag = doc.getXmlFragment("default");
    const para = new Y.XmlElement("paragraph");
    const [t1, t2, t3] = [new Y.XmlText(), new Y.XmlText(), new Y.XmlText()];
    frag.insert(0, [para]);
    para.insert(0, [t1, new Y.XmlElement("hardBreak"), t2, new Y.XmlElement("hardBreak"), t3]);
    t1.insert(0, "a");
    t2.insert(0, "b");
    t3.insert(0, "c");
    const err = applyEdit(doc, 0, 3, ""); // delete "a\nb" → leading break + "c" survive
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("\nc");
  });

  it("cross-element edit where both paragraphs contain breaks keeps surviving breaks", () => {
    doc = makeTwoBrokenParagraphsDoc(); // "one\ntwo" + "\n" + "three\nfour"
    expect(extractText(doc)).toBe("one\ntwo\nthree\nfour");
    // Replace from inside para 1's second run ("tw|o") to inside para 2's first
    // run ("thr|ee"): offsets 6..11 → "o\ntwo\nthr" ... compute precisely:
    // flat: o(0)n(1)e(2) \n(3) t(4)w(5)o(6) \n(7=block sep) t(8)h(9)r(10)e(11)e(12) \n(13) f o u r
    // Replace [6, 12) "o\nthre" with "X" → "one\ntwX" + "e\nfour" join → "one\ntwXe\nfour"
    const err = applyEdit(doc, 6, 12, "X");
    expect(err).toBeNull();
    expect(extractText(doc)).toBe("one\ntwXe\nfour");
    // The break inside the merged tail (before "four") survives.
    expect(extractText(doc).endsWith("e\nfour")).toBe(true);
  });
});
