/**
 * Flat offsets at a container's internal block boundary (#1485).
 *
 * `resolveWithinNode` charged the FLAT_SEPARATOR between two block children at
 * the TOP of the next iteration. So an offset landing exactly on that separator
 * — the end of child N — failed child N's `>` test, then passed child N+1's with
 * a NEGATIVE remaining offset, and the recursion resolved inside the wrong
 * child. The returned position sat one past child N's close token.
 *
 * Through the accept path that is destructive, not merely off-by-one: the range
 * spans a structural boundary, so `deleteRange` takes the boundary with it. A
 * suggestion on the first cell of a table row DELETED the second cell; a
 * suggestion on the first item of a list ate into the second item.
 *
 * The same shape existed one level up in `flatOffsetToPmPos`, whose boundary
 * return was `childStart + child.content.size`. That is a text position only
 * when the child is a TEXTBLOCK — for a container it lands between the last
 * inner block's close token and the container's own.
 *
 * SCOPE. This is the FLAT fallback path. #1450/#1459 fixed the same class of
 * drift in the CRDT (`relRange`) path, and an annotation carrying a live
 * `relRange` never reaches this code — which is exactly why it survived: the
 * common case is resolved by the other branch.
 */

import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { flatOffsetToPmPos, pmPosToFlatOffset } from "../../src/client/positions";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { extractText } from "../../src/server/mcp/document-model";
import type { FlatOffset } from "../../src/shared/positions/types";
import { toPmPos } from "../../src/shared/positions/types";
import { productionSchema, yDocToPmNode } from "./editor-roundtrip-harness.js";

type PMNode = ReturnType<typeof yDocToPmNode>;

function docPair(markdown: string) {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, markdown);
  return { ydoc, pmDoc: yDocToPmNode(ydoc, productionSchema()) };
}

/** Structural render — a node boundary must be visible, not flattened to text. */
function structure(node: PMNode): string {
  const parts: string[] = [];
  node.forEach((child) => {
    if (child.isText) parts.push(JSON.stringify(child.text));
    else if (child.isTextblock || child.childCount > 0)
      parts.push(`${child.type.name}(${structure(child)})`);
    else parts.push(`<${child.type.name}>`);
  });
  return parts.join("+");
}

const TABLE = "| a | b |\n|---|---|\n| cell | two |\n";
const LIST = "- one\n- two\n";

/**
 * The corpus both property tests run over.
 *
 * Deliberately wider than the shapes the bug was reported against. #1485 was
 * filed as a table bug; the list case only surfaced because the property ran
 * over a shape nobody suspected, and the end-of-document case only surfaced
 * because a later shape ended in something other than a paragraph. The cost of
 * an extra entry here is a few milliseconds.
 *
 * Shapes chosen to reach specific branches:
 *  - `blockquote, two paragraphs` / `table cell, two paragraphs` — the only
 *    ones that exercise a MULTI-CHILD container's fallthrough, which is what
 *    the fix's own comment is written about.
 *  - `heading` — the boundary branch passes a prefix-EXCLUDED length.
 *  - `hard breaks` — one flat char, zero text-node chars.
 *  - `horizontal rule` / `empty list item` — where the descent stops before
 *    reaching a textblock; pinned so a future change notices if that moves.
 */
const SHAPES: Record<string, string> = {
  table: TABLE,
  list: LIST,
  "list then paragraph": "- one\n- two\n\nafter\n",
  blockquote: "> quoted\n\npara\n",
  "two paragraphs": "alpha\n\nbravo\n",
  "nested list": "- one\n  - inner\n- two\n",
  "blockquote, two paragraphs": "> one\n>\n> two\n\nafter\n",
  heading: "# Title\n\nbody\n",
  "heading last": "body\n\n### Deep\n",
  "code block": "para\n\n```\ncode\nmore\n```\n",
  "hard breaks": "alpha\\\nbravo\\\ncharlie\n",
  "ends with a container": "intro\n\n- one\n- two\n",
  "ends with a table": "intro\n\n| a | b |\n|---|---|\n| c | d |\n",
  "single paragraph": "only\n",
  "empty list item": "- one\n-\n\nafter\n",
  "horizontal rule": "a\n\n---\n\nb\n",
};

/**
 * Offsets that do NOT resolve inside a textblock, with the reason, pinned as an
 * exact set.
 *
 * Both were PRE-EXISTING and unchanged by #1485 — each was checked against the
 * old code — and one has since been retired by #1664 (below), which is the
 * mechanism described here doing its job.
 *
 * They are listed rather than excluded from the corpus because an
 * exception that is silently skipped is an exception nobody re-examines: if a
 * later change fixes one, or introduces a fourth, this set fails and says so.
 *
 * - `empty list item` — REMOVED by #1664, which is this pin working as
 *   designed. The entry read "a `listItem` with no children at all. There is no
 *   textblock inside it to land in, so no better answer exists." The premise
 *   stopped holding: a zero-child `listItem` was not merely unaddressable, it
 *   was schema-invalid, and the client answered that by deleting it out of the
 *   shared Y.Doc and cascading to the fragment root. `ensureBlockChild`
 *   (`src/server/file-io/mdast-ydoc.ts`) now gives such an item one empty
 *   paragraph at load, so offset 4 has a textblock to land in and the exception
 *   is gone rather than widened.
 * - `horizontal rule` — an `hr` contributes zero flat characters but sits
 *   between two block separators, so one flat offset belongs to it and has no
 *   text position anywhere. Resolving it to the end of the previous block or
 *   the start of the next is a judgment call that belongs with the flat-text
 *   convention, not with this fix. Still live.
 */
const KNOWN_NON_TEXTBLOCK: Record<string, number[]> = {
  "horizontal rule": [2],
};

/**
 * Offsets where `flat -> pm -> flat` is not the identity, pinned the same way.
 *
 * Also pre-existing. A heading's `"# "` prefix occupies flat offsets with no
 * ProseMirror counterpart — `flatOffsetToPmPos` clamps them to the start of the
 * heading's text, so they all map to the same position and come back as the
 * first post-prefix offset. The `horizontal rule` entry is the same zero-width
 * block as above.
 */
const KNOWN_NON_ROUNDTRIP: Record<string, number[]> = {
  heading: [0, 1],
  // "body\n### Deep" — the "### " prefix sits at flat offsets 5-8.
  "heading last": [5, 6, 7, 8],
  "horizontal rule": [2],
};

describe("#1485: an offset on a container's internal block boundary", () => {
  it("resolves to the END of the block it belongs to, not into the next one", () => {
    // The direct assertion. In the table above the flat text is
    // "a\nb\ncell\ntwo"; offset 8 is the end of "cell". Before the fix this
    // returned a position inside the SECOND cell.
    //
    // Keep this ALONGSIDE the round-trip property below rather than trusting
    // that property alone. A third defect in the same function returned the
    // cell's own inner boundary — between the paragraph's close token and the
    // cell's — and `pmPosToFlatOffset` maps that back to 8, so the round trip
    // was perfectly green while the position was still structural. Only naming
    // the expected parent node caught it.
    const { pmDoc } = docPair(TABLE);
    const at = flatOffsetToPmPos(pmDoc, 8 as FlatOffset);

    // Resolving there must land inside the first cell's paragraph, at its end.
    const $at = pmDoc.resolve(at);
    expect($at.parent.type.name, "parent node").toBe("paragraph");
    expect($at.parent.textContent, "which paragraph").toBe("cell");
    expect($at.parentOffset, "at the end of it").toBe(4);
  });

  it("resolves to a TEXTBLOCK for every offset in every shape", () => {
    // The invariant the whole fix establishes, and the one assertion the
    // round-trip property below is structurally incapable of making.
    //
    // `flat -> pm -> flat` is the identity even for a structural position, so
    // the round trip is GREEN over the entire family of bugs this file is
    // about. Measured: with the fix reverted, the blockquote shape below
    // round-trips perfectly while resolving offset 6 to the blockquote's own
    // inner end. This loop is what catches that, and it is what caught the
    // end-of-document case (`doc.content.size`, parent = the doc node) that
    // survived the first two rounds of this fix in EVERY shape, container or
    // not.
    for (const [name, markdown] of Object.entries(SHAPES)) {
      const { ydoc, pmDoc } = docPair(markdown);
      const flat = extractText(ydoc);
      const structural: number[] = [];
      for (let i = 0; i <= flat.length; i++) {
        const pos = flatOffsetToPmPos(pmDoc, i as FlatOffset);
        if (!pmDoc.resolve(pos).parent.isTextblock) structural.push(i);
      }
      // Asserted as an exact SET, not as "none": the two documented exceptions
      // have no textblock answer to give, and pinning them means a fourth one
      // appearing is a failure rather than a silently widened skip list.
      expect(structural, `${name}: offsets not inside a textblock`).toEqual(
        KNOWN_NON_TEXTBLOCK[name] ?? [],
      );
    }
  });

  it("every flat offset survives a round trip, for each container shape", () => {
    // The general property, and the one that caught the list case: a boundary
    // offset that resolved into the wrong child came back as a DIFFERENT flat
    // offset. Checking only the shapes we thought were affected would have
    // missed lists entirely — the issue was filed as a table bug.
    //
    // Kept DESPITE being weaker than the invariant above: it is the assertion
    // that catches a wrong-child resolution, which the textblock check cannot
    // see (the wrong child is still a textblock).
    for (const [name, markdown] of Object.entries(SHAPES)) {
      const { ydoc, pmDoc } = docPair(markdown);
      const flat = extractText(ydoc);
      const drifted: number[] = [];
      for (let i = 0; i <= flat.length; i++) {
        const pm = flatOffsetToPmPos(pmDoc, i as FlatOffset);
        if (pmPosToFlatOffset(pmDoc, pm) !== i) drifted.push(i);
      }
      expect(drifted, `${name}: offsets that do not round-trip`).toEqual(
        KNOWN_NON_ROUNDTRIP[name] ?? [],
      );
    }
  });
});

describe("#1485: replacing the resolved range does not eat a sibling", () => {
  /**
   * Delete a flat-resolved range and insert over it. Asserted STRUCTURALLY: a
   * text-level assertion cannot see a cell or list item disappearing, which is
   * the entire damage here.
   *
   * NOT a replay of the accept path, and the difference matters: `applySuggestion`
   * uses Tiptap's `deleteRange` + `insertContentAt`, and those two diverge from
   * `tr.delete` + `tr.insertText` precisely AT structural positions — an
   * `insertContentAt` at `doc.content.size` appends a stray sibling paragraph
   * where `insertText` quietly lands in the last block. So this models the range
   * arithmetic, not the accept. The end-to-end behaviour of the accept path is
   * pinned against a live editor in `suggestion-literal-insert.test.ts`.
   */
  function replace(markdown: string, from: number, to: number, text: string): string {
    const { pmDoc } = docPair(markdown);
    const pmFrom = flatOffsetToPmPos(pmDoc, from as FlatOffset);
    const pmTo = flatOffsetToPmPos(pmDoc, to as FlatOffset);
    const state = EditorState.create({ doc: pmDoc });
    const tr = state.tr.delete(pmFrom, pmTo);
    tr.insertText(text, toPmPos(pmFrom));
    return structure(state.apply(tr).doc);
  }

  it("a suggestion on the first table cell leaves the second cell alone", () => {
    // Before the fix the row came back with ONE cell holding two paragraphs —
    // the second cell was gone and unrecoverable.
    const after = replace(TABLE, 4, 8, "REPLACED");
    expect(after).toContain('paragraph("REPLACED")');
    expect(after, "the second cell must survive").toContain('paragraph("two")');
    expect(after.match(/tableCell/g)?.length, "cell count").toBe(2);
  });

  it("a suggestion on the first list item leaves the second item alone", () => {
    // Filed as a table bug; the round-trip property above surfaced this one.
    const after = replace(LIST, 0, 3, "REPLACED");
    expect(after).toContain('paragraph("REPLACED")');
    expect(after, "the second item must survive").toContain('paragraph("two")');
    expect(after.match(/listItem/g)?.length, "item count").toBe(2);
  });

  it("a range ending at the END OF THE DOCUMENT stays inside the last block", () => {
    // `flatOffsetToPmPos(doc, flat.length)` returned `doc.content.size` — the
    // position after the last block CLOSES — in every shape, container or not.
    // `tr.delete` survives that (ProseMirror re-fits the slice) but an insert
    // does not: the accept path's `insertContentAt` appends a stray sibling
    // paragraph instead of extending the last block.
    const { ydoc, pmDoc } = docPair("intro\n\n- one\n- two\n");
    const flat = extractText(ydoc);
    const end = flatOffsetToPmPos(pmDoc, flat.length as FlatOffset);
    const $end = pmDoc.resolve(end);
    expect($end.parent.type.name).toBe("paragraph");
    expect($end.parent.textContent).toBe("two");
    expect($end.parentOffset, "at the end of the last block's text").toBe(3);
  });
});

describe("#1485: the fallthrough's descent", () => {
  it("terminates on a deeply nested container", () => {
    // The fix made the fallthrough recursive. It descends one level per step in
    // a finite tree, so it cannot loop — but "cannot loop" is a claim, and this
    // is what makes it a checked one. Fails as a stack overflow, not a wrong
    // value, so an assertion on the result would not be the point.
    const deep = `${"> ".repeat(200)}x\n\nafter\n`;
    const { ydoc, pmDoc } = docPair(deep);
    const flat = extractText(ydoc);
    for (let i = 0; i <= flat.length; i++) {
      expect(() => flatOffsetToPmPos(pmDoc, i as FlatOffset)).not.toThrow();
    }
  });

  it("lands in the right block for a MULTI-CHILD container", () => {
    // The shape the fix's own comment is written about — a container whose
    // fallthrough has more than one child to choose between. Every other test
    // here uses single-child cells and items, which reach the fallthrough
    // trivially. Markdown can express this one as a blockquote holding two
    // paragraphs; a table cell holding two cannot be written in markdown at all.
    const { ydoc, pmDoc } = docPair("> one\n>\n> two\n\nafter\n");
    const flat = extractText(ydoc);
    // Flat text is "one\n\ntwo\nafter"; offset 8 is the end of "two", the last
    // block INSIDE the blockquote — the fallthrough's multi-child case.
    const endOfQuote = flat.indexOf("two") + 3;
    const $at = pmDoc.resolve(flatOffsetToPmPos(pmDoc, endOfQuote as FlatOffset));
    expect($at.parent.type.name).toBe("paragraph");
    expect($at.parent.textContent).toBe("two");
    expect($at.parentOffset).toBe(3);
  });
});
