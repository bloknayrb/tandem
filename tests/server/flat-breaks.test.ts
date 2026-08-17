/**
 * `extractTextWithBreaks` — which `"\n"` in the flat projection were structure
 * rather than text (#1486).
 *
 * The flat string spells a block boundary, a hard break and a literal newline
 * identically, and each one serializes differently, so undo cannot restore what
 * was there without being told. These tests pin the classification at the
 * source; `tests/client/structural-snapshot-undo.test.ts` pins what undo does
 * with it.
 *
 * The load-bearing property is not the break list on its own — it is that the
 * list and the text come from ONE traversal. A parallel walker would be a
 * second copy of the separator contract, and a break list whose offsets
 * disagree with the text it describes aims undo at the wrong characters, which
 * is worse than no list. Every case below asserts the offsets against the text
 * rather than against a hand-counted constant, so a drift between them fails.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { captureSnapshot } from "../../src/server/mcp/annotations.js";
import { extractText, extractTextWithBreaks } from "../../src/server/mcp/document-model.js";

/** Every index in `text` holding a "\n". */
function newlineOffsets(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i);
  return out;
}

function fromMarkdown(md: string): Y.Doc {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, md);
  return ydoc;
}

describe("extractTextWithBreaks", () => {
  it("produces the flat projection the coordinate system is defined on", () => {
    // The refactor risk, and it needs a HAND-WRITTEN expectation. `extractText`
    // now delegates here, so asserting the two agree is `x === x` — it passes
    // with the traversal arbitrarily broken, which is exactly the failure it was
    // meant to catch. The string below is derived from the contract instead:
    // heading prefixes are included, every block is joined with a single "\n",
    // and nesting (a list's items) uses the same separator as a top-level gap.
    const ydoc = fromMarkdown("# Title\n\nalpha\n\n- one\n- two\n");
    expect(extractTextWithBreaks(ydoc).text).toBe("# Title\nalpha\none\ntwo");
    // Delegation still worth pinning, now that the value above is independent.
    expect(extractText(ydoc)).toBe("# Title\nalpha\none\ntwo");
  });

  it("reports every break at an offset that actually holds a newline", () => {
    const ydoc = fromMarkdown("# Title\n\nalpha\n\nbravo\n\n- one\n- two\n");
    const { text, breaks } = extractTextWithBreaks(ydoc);
    const newlines = new Set(newlineOffsets(text));
    for (const b of breaks) {
      expect(newlines.has(b.at), `break at ${b.at} should be a newline`).toBe(true);
    }
  });

  it("marks the separator between two paragraphs as a block boundary", () => {
    const { text, breaks } = extractTextWithBreaks(fromMarkdown("alpha\n\nbravo\n"));
    expect(text).toBe("alpha\nbravo");
    expect(breaks).toEqual([{ at: 5, kind: "block" }]);
  });

  it("marks a boundary between UNLIKE blocks opaque, not restorable", () => {
    // The restore rebuilds a boundary by splitting the receiving block, which
    // can only produce two blocks of one type. `validateRange` checks a heading
    // prefix at the range ENDPOINTS only, so a range legally runs from a
    // paragraph through the next heading's "## " and out the far side; accepting
    // it merges the two and PM's join keeps the FIRST type, so the surviving
    // block says nothing about what was consumed. Recording the boundary as
    // `"block"` here would restore the heading as body text.
    const { text, breaks } = extractTextWithBreaks(fromMarkdown("alpha\n\n## bravo\n"));
    expect(text).toBe("alpha\n## bravo");
    expect(breaks).toEqual([{ at: 5, kind: "block-opaque" }]);
  });

  it("marks a heading-to-heading boundary opaque too", () => {
    const { breaks } = extractTextWithBreaks(fromMarkdown("# one\n\n# two\n"));
    // Both sides are headings, so a split WOULD produce two headings — but the
    // flat text carries their "# " prefixes as ordinary characters, and a
    // rebuild would put those characters into the restored block as text.
    expect(breaks.map((b) => b.kind)).toEqual(["block-opaque"]);
  });

  it("marks a hard break as hard, not as a boundary", () => {
    // Two trailing spaces is a markdown hard break.
    const { text, breaks } = extractTextWithBreaks(fromMarkdown("alpha  \nbravo\n"));
    expect(text).toBe("alpha\nbravo");
    expect(breaks).toEqual([{ at: 5, kind: "hard" }]);
    // Same flat text as the paragraph case above, different structure — which
    // is the entire reason this function exists.
  });

  it("leaves a soft wrap unlisted", () => {
    // A soft-wrapped paragraph. Paragraphs are `whitespace: "pre"` since #1448,
    // so the newline survives inside one text node and is literal.
    const { text, breaks } = extractTextWithBreaks(fromMarkdown("alpha\nbravo\n"));
    expect(text).toBe("alpha\nbravo");
    expect(breaks).toEqual([]);
  });

  it("marks list-item separators as boundaries, and as opaque ones", () => {
    // Amended deliberately, not fixed up. An earlier cut of this file asserted
    // `kind === "block"` here, which described the traversal but overstated what
    // the record promises: a separator between two `listItem`s is a boundary the
    // restore cannot rebuild, because splitting produces two paragraphs inside
    // ONE item rather than two items. The offsets are the load-bearing half and
    // they are unchanged — only the restorability claim narrowed.
    const { text, breaks } = extractTextWithBreaks(fromMarkdown("- one\n- two\n"));
    expect(newlineOffsets(text)).toEqual(breaks.map((b) => b.at));
    expect(breaks.every((b) => b.kind === "block-opaque")).toBe(true);
  });

  it("reports no breaks inside a heading", () => {
    // `flattenHeadingText` rewrites a heading's newlines to spaces, so a
    // heading contributes none — and it is length-preserving, so the offsets of
    // everything after it are unaffected. The one boundary it does report is
    // opaque: heading-to-paragraph is not a pair a split can rebuild.
    const { text, breaks } = extractTextWithBreaks(fromMarkdown("# Title\n\nbody\n"));
    expect(text).toBe("# Title\nbody");
    expect(breaks).toEqual([{ at: 7, kind: "block-opaque" }]);
  });

  it("still marks a plain paragraph pair restorable", () => {
    // The negative control for the two above: if `RESTORABLE_BLOCK` gating were
    // over-broad, everything would come back opaque and the decline would be
    // indistinguishable from a feature that never works.
    const { breaks } = extractTextWithBreaks(fromMarkdown("alpha\n\nbravo\n\ncharlie\n"));
    expect(breaks.map((b) => b.kind)).toEqual(["block", "block"]);
  });
});

describe("captureSnapshot records breaks", () => {
  it("rebases offsets to be snapshot-relative", () => {
    const ydoc = fromMarkdown("intro\n\nalpha\n\nbravo\n");
    const full = extractText(ydoc);
    const from = full.indexOf("alpha");
    const snap = captureSnapshot(ydoc, from, from + "alpha\nbravo".length);
    expect(snap.text).toBe("alpha\nbravo");
    // 5, not 11 — an absolute offset here would point undo at the wrong
    // character in every annotation that does not start at the document top.
    expect(snap.breaks).toEqual([{ at: 5, kind: "block" }]);
  });

  it("excludes the boundary AT the range's end", () => {
    // That separator belongs to whatever comes next, not to this range.
    // Including it would make undo append a trailing empty paragraph.
    const ydoc = fromMarkdown("alpha\n\nbravo\n");
    const snap = captureSnapshot(ydoc, 0, 5);
    expect(snap.text).toBe("alpha");
    expect(snap.breaks).toEqual([]);
  });

  it("drops breaks past the truncation cap", () => {
    const body = Array.from({ length: 40 }, (_, i) => `para ${i} text`).join("\n\n");
    const ydoc = fromMarkdown(`${body}\n`);
    const snap = captureSnapshot(ydoc, 0, extractText(ydoc).length);
    expect(snap.truncated).toBe(true);
    // An offset beyond the stored text is not addressable, and left in it would
    // be silently ignored at best and slice the wrong way at worst.
    for (const b of snap.breaks) expect(b.at).toBeLessThan(snap.text.length);
  });

  it("returns an empty list for an ordinary single-block range", () => {
    const ydoc = fromMarkdown("just one paragraph here\n");
    expect(captureSnapshot(ydoc, 0, 8).breaks).toEqual([]);
  });
});
