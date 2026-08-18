/**
 * Do a server-side flat offset and a client-side flat offset name the same
 * character — when the journey between them goes through a Yjs anchor?
 *
 * This is the guard for the #1450/#1459 class. Those were Y-vs-PM coordinate
 * drift found only after months of green tests, because every test that could
 * have caught them mocked one side of the correspondence and therefore encoded
 * the same wrong model on both sides.
 *
 * WHY IT MATTERS NOW. `flatOffsetToRelPos` walks the **Y** tree; every offset
 * fed to it today is produced by the **server**, from `extractText`. #1471 will
 * mint anchors on the client from offsets produced by `pmSelectionToFlat`,
 * which walks the **PM** tree. Nothing in the codebase crosses that seam today,
 * so nothing pins it. If the two conventions disagree anywhere, a client-minted
 * anchor lands on the wrong character — which is strictly worse than the drift
 * #1471 exists to fix, because it is confidently wrong rather than stale.
 *
 * SCOPE. Sibling to `flat-offset-container-boundary.test.ts`, which covers the
 * FLAT fallback path (`flatOffsetToPmPos`) and was written for #1485 — an offset
 * landing on a container separator resolving inside the wrong child. This file
 * covers the CRDT path: mint an anchor from a flat offset, resolve it back, and
 * ask whether it landed on the character that offset names. The #1485 question
 * has its own test here too, because the flat fix did not touch this path. The two files share a corpus shape by
 * intent, not by import — a corpus one of them can silently shrink is a corpus
 * that stops covering the other.
 *
 * The exact-set style (pinning the exceptions rather than skipping them) is
 * copied from that sibling deliberately: an exception that is silently skipped
 * is an exception nobody re-examines.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { relRangeToPmPositions } from "../../src/client/positions";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { extractText } from "../../src/server/mcp/document-model";
import { flatOffsetToRelPos } from "../../src/server/positions";
import { toFlatOffset } from "../../src/shared/positions/types";
import { productionSchema, yDocToPmNode } from "./editor-roundtrip-harness.js";

function docPair(markdown: string) {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, markdown);
  return { ydoc, pmDoc: yDocToPmNode(ydoc, productionSchema()) };
}

/**
 * Mint the anchor pair the way `anchoredRange` does — `from` sticks right
 * (assoc 0), `to` sticks left (assoc -1). Hard-coded here rather than calling
 * `anchoredRange` so the test pins the CONVENTION; if someone changes the assoc
 * pair, this file should fail rather than silently follow.
 */
function anchorPair(ydoc: Y.Doc, from: number, to: number) {
  const fromRel = flatOffsetToRelPos(ydoc, toFlatOffset(from), 0);
  const toRel = flatOffsetToRelPos(ydoc, toFlatOffset(to), -1);
  return fromRel && toRel ? { fromRel, toRel } : null;
}

/**
 * Shapes chosen to reach the places the two coordinate systems could disagree:
 * heading prefixes (server-only characters), hardBreak (1 flat char, 0 text
 * chars), nested containers (separator accounting), tables (deep nesting), and
 * a soft-wrapped paragraph carrying a literal newline (#1448's `whitespace: "pre"`,
 * where BOTH sides must count the `\n` as one ordinary character).
 */
const SHAPES: Record<string, string> = {
  "single paragraph": "only\n",
  "two paragraphs": "alpha\n\nbravo\n",
  heading: "# Title\n\nbody\n",
  "heading last": "body\n\n### Deep\n",
  "hard breaks": "alpha\\\nbravo\\\ncharlie\n",
  list: "- one\n- two\n",
  "nested list": "- one\n  - inner\n- two\n",
  blockquote: "> quoted\n\npara\n",
  "blockquote, two paragraphs": "> one\n>\n> two\n\nafter\n",
  table: "| a | b |\n|---|---|\n| cell | two |\n",
  "code block": "para\n\n```\ncode\nmore\n```\n",
  "soft wrapped": "wrapped line one\nstill the same paragraph\n\nafter\n",
  // Added after review: shapes where the Y walk and the PM projection have
  // the most room to disagree about child counts or offsets.
  "inline marks": "plain **bold** and *em* and `code` and [link](http://x.y)\n",
  "mark spanning to block end": "lead **bold to the end**\n\nnext\n",
  "empty list item": "- one\n-\n- three\n",
  "table cell with hard break": "| a | b |\n|---|---|\n| one\\\ntwo | three |\n",
  "blockquote wrapping a list": "> - one\n> - two\n\nafter\n",
  "heading after list": "- one\n- two\n\n## Then\n\nbody\n",
  "list after heading": "## Head\n\n- one\n- two\n",
};

/**
 * Offsets a mint cannot anchor, derived from the markdown rather than the code.
 *
 * INDEPENDENT ORACLE, and deliberately so. These offsets exist only in
 * `extractText`'s rendering — no Y.XmlText contains them — so they are the one
 * place a mint legitimately cannot anchor. Deriving them from the markdown
 * syntax rather than from "wherever the mint returned null" is what keeps the
 * tests below from being circular: two independent derivations are asserted
 * equal, so a mint that started refusing somewhere new fails rather than
 * quietly redefining its own exception set.
 *
 * Safe for this corpus because no fixture has a paragraph or code line
 * beginning with a literal `#` — and the equality assertion is what would catch
 * it if one were added.
 */
function unanchorableOffsets(flat: string, assoc: 0 | -1): number[] {
  const out: number[] = [];
  // An empty block (an empty list item, say) renders as a Y element with no
  // Y.XmlText child at all, so the separators around it name positions no
  // stored character backs. In the flat text that is a pair of adjacent
  // separators — derivable here without asking the code under test.
  //
  // THE TWO ASSOCS REFUSE IN DIFFERENT PLACES, which is why this takes one.
  // Each retries in its own direction and so fails toward the empty element:
  // assoc 0 refuses on the leading separator (its +1 retry lands in the void),
  // assoc -1 on the trailing one (its -1 retry lands in the same void). They
  // are mirror images, not a shared set — and since `anchorFlatRange` is
  // all-or-nothing across both endpoints, a range touching EITHER offset
  // degrades to flat.
  for (let i = 0; i + 1 < flat.length; i++) {
    if (flat[i] === "\n" && flat[i + 1] === "\n") out.push(assoc === 0 ? i : i + 1);
  }
  // Heading prefixes exist only in `extractText`’s rendering — no Y.XmlText
  // contains them — so neither assoc can anchor there.
  let at = 0;
  for (const segment of flat.split("\n")) {
    const prefix = /^#{1,6} /.exec(segment);
    if (prefix) for (let i = 0; i < prefix[0].length; i++) out.push(at + i);
    at += segment.length + 1; // + the separator that split consumed
  }
  return out.sort((a, b) => a - b);
}

/**
 * A flat offset is "addressable" when the character at it is one a Y.XmlText
 * actually contains. Two kinds are excluded:
 *
 * - **`\n`** — `extractText` emits one for a block separator AND for a
 *   hardBreak, neither of which is a stored character. Their behaviour is
 *   pinned by its own test below, because "the anchor shifted" and "the anchor
 *   is on the wrong character" are different failures that must not share an
 *   assertion. (The soft-wrap `\n` IS stored, and is likewise pinned separately
 *   — this exclusion is what blinds the main property to it.)
 * - **unanchorable offsets** — heading prefixes and empty blocks; see
 *   `unanchorableOffsets`.
 */
function addressableOffsets(flat: string): number[] {
  const prefixes = new Set([...unanchorableOffsets(flat, 0), ...unanchorableOffsets(flat, -1)]);
  const out: number[] = [];
  for (let i = 0; i < flat.length; i++) if (flat[i] !== "\n" && !prefixes.has(i)) out.push(i);
  return out;
}

describe("server flat offsets and client PM positions name the same character", () => {
  it("every addressable offset mints an anchor that resolves onto its own character", () => {
    // THE LOAD-BEARING ASSERTION of this file, and the stop condition for
    // #1471's client-side mint.
    //
    // For each real text character: mint the one-character range [i, i+1) the
    // way the server does, resolve it through the CLIENT's reader against the
    // PM doc, and require that the text between the resolved positions is that
    // same character.
    //
    // Note this deliberately compares against `extractText` — the SERVER's
    // rendering of the document — while resolving through `relRangeToPmPositions`
    // and reading with `pmDoc.textBetween` — the CLIENT's. That is the whole
    // point: if the two disagree about what character offset `i` is, this fails.
    const mismatches: string[] = [];
    let checked = 0;

    for (const [name, markdown] of Object.entries(SHAPES)) {
      const { ydoc, pmDoc } = docPair(markdown);
      const flat = extractText(ydoc);

      for (const i of addressableOffsets(flat)) {
        checked++;
        const relRange = anchorPair(ydoc, i, i + 1);
        if (!relRange) {
          mismatches.push(
            `${name}[${i}]: expected an anchor for ${JSON.stringify(flat[i])}, got null`,
          );
          continue;
        }
        const resolved = relRangeToPmPositions(ydoc, pmDoc, relRange);
        if (!resolved) {
          mismatches.push(`${name}[${i}]: anchor for ${JSON.stringify(flat[i])} did not resolve`);
          continue;
        }
        const got = pmDoc.textBetween(resolved.from, resolved.to);
        if (got !== flat[i]) {
          mismatches.push(
            `${name}[${i}]: server says ${JSON.stringify(flat[i])}, client resolved ${JSON.stringify(got)}`,
          );
        }
      }
    }

    // Anti-vacuum. An empty `mismatches` is also what a corpus that stopped
    // producing offsets looks like — a shape this repo has shipped twice — so
    // the property carries a positive anchor as well as the zero check. The
    // bound is a floor well under today's count, not a pin on the corpus.
    expect(checked, "offsets actually compared").toBeGreaterThan(100);
    expect(mismatches, "flat-offset correspondence").toEqual([]);
  });

  it("counts a soft-wrap newline as one ordinary character on both sides", () => {
    // #1448 gave paragraphs `whitespace: "pre"`, so a literal `\n` lives INSIDE
    // a PM text node and inside a Y.XmlText. It is the one `\n` in the flat
    // string that is neither a block separator nor a hardBreak, and both sides
    // must charge it exactly one character.
    //
    // Called out separately because `addressableOffsets` skips every `\n`, so
    // the property above cannot see this one — the exclusion that keeps that
    // property honest is also what blinds it here.
    const { ydoc, pmDoc } = docPair(SHAPES["soft wrapped"]);
    const flat = extractText(ydoc);

    const nl = flat.indexOf("\n");
    expect(nl, "the fixture must contain a soft-wrap newline").toBeGreaterThan(0);
    expect(flat.slice(nl - 1, nl + 2), "and it must sit between two text characters").toBe("e\ns");

    // The characters either side of it must still resolve to themselves, which
    // is what proves neither side lost or gained a position across it.
    for (const at of [nl - 1, nl + 1]) {
      const relRange = anchorPair(ydoc, at, at + 1);
      expect(relRange, `anchor at ${at}`).not.toBeNull();
      const resolved = relRangeToPmPositions(ydoc, pmDoc, relRange!);
      expect(resolved, `resolution at ${at}`).not.toBeNull();
      expect(pmDoc.textBetween(resolved!.from, resolved!.to)).toBe(flat[at]);
    }
  });

  it("refuses to mint at exactly the unanchorable offsets, and nowhere else", () => {
    // The null set is a CONTRACT, not an accident: #1471's client mint degrades
    // to flat offsets exactly here, and its failure-mode table is written
    // against this set.
    //
    // Asserted against `unanchorableOffsets` rather than against a recorded
    // snapshot, so the test states WHY each null is there. A snapshot would
    // accept a new null anywhere in the corpus as long as someone ran `-u`.
    //
    // Note the set is this small: block separators and the end-of-document
    // offset all mint successfully, because `flatOffsetToRelPos` applies an
    // assoc-directed ±1 retry when `findXmlTextAtOffset` comes back empty.
    for (const [name, markdown] of Object.entries(SHAPES)) {
      const { ydoc } = docPair(markdown);
      const flat = extractText(ydoc);

      const refused: number[] = [];
      for (let i = 0; i <= flat.length; i++) {
        if (flatOffsetToRelPos(ydoc, toFlatOffset(i), 0) === null) refused.push(i);
      }

      expect(refused, `${name}: offsets where assoc 0 refused`).toEqual(
        unanchorableOffsets(flat, 0),
      );

      // Both assocs, separately, because they genuinely DISAGREE around an empty
      // block (see `unanchorableOffsets`). Checking only assoc 0 — the obvious
      // thing to write — would have hidden that, since only `anchorPair`, which
      // needs both endpoints, would ever have noticed, and then only coarsely.
      const refusedLeft: number[] = [];
      for (let i = 0; i <= flat.length; i++) {
        if (flatOffsetToRelPos(ydoc, toFlatOffset(i), -1) === null) refusedLeft.push(i);
      }
      expect(refusedLeft, `${name}: offsets where assoc -1 refused`).toEqual(
        unanchorableOffsets(flat, -1),
      );
    }
  });

  it("keeps a range ending on a block boundary inside the block it covers", () => {
    // ADDED AFTER REVIEW, and it covers the gap that mattered most: until this
    // existed, every range minted in this file was a single character with both
    // endpoints inside one block, so the CRDT path was never resolved at a
    // block boundary at all. That is exactly the #1485 class — an offset landing
    // on a separator resolving into the WRONG child — and it is the ordinary
    // case in production, since annotating a whole paragraph mints a `to` on
    // precisely such a boundary.
    //
    // ASSERTED STRUCTURALLY, NOT BY TEXT, and that is the point. ProseMirror’s
    // `textBetween` contributes nothing across a block boundary unless given a
    // separator, so a `to` that drifted from "end of block N" to "start of
    // block N+1" stringifies identically either way. A text-only assertion here
    // would pass on the bug it exists to catch — the `a-mock-cannot-see-a-
    // correspondence-bug` shape. So the check is on the resolved POSITION: the
    // end of the range must share a parent textblock with the last character
    // the range covers, whose own resolution the property above already proved.
    const problems: string[] = [];
    let spans = 0;

    for (const [name, markdown] of Object.entries(SHAPES)) {
      const { ydoc, pmDoc } = docPair(markdown);
      const flat = extractText(ydoc);
      const addressable = new Set(addressableOffsets(flat));

      // Every maximal run between separators. Its end offset IS a boundary.
      let at = 0;
      for (const segment of flat.split("\n")) {
        const start = at;
        const end = at + segment.length;
        at = end + 1;
        if (!addressable.has(start) || !addressable.has(end - 1)) continue;

        const relRange = anchorPair(ydoc, start, end);
        if (!relRange) {
          problems.push(`${name}[${start},${end}): whole-segment range did not mint`);
          continue;
        }
        const span = relRangeToPmPositions(ydoc, pmDoc, relRange);
        const lastChar = relRangeToPmPositions(ydoc, pmDoc, anchorPair(ydoc, end - 1, end)!);
        if (!span || !lastChar) {
          problems.push(`${name}[${start},${end}): did not resolve`);
          continue;
        }
        spans++;

        if (pmDoc.resolve(span.to).parent !== pmDoc.resolve(lastChar.to).parent) {
          problems.push(
            `${name}[${start},${end}): range end left the block holding its last character`,
          );
        }
        // Text too, but with the separator arguments supplied, so a hardBreak or
        // an internal block gap renders the way the flat string does.
        const got = pmDoc.textBetween(span.from, span.to, "\n", "\n");
        if (got !== segment) {
          problems.push(
            `${name}[${start},${end}): expected ${JSON.stringify(segment)}, got ${JSON.stringify(got)}`,
          );
        }
      }
    }

    expect(spans, "whole-segment ranges actually compared").toBeGreaterThan(20);
    expect(problems, "block-boundary range resolution").toEqual([]);
  });

  it("shifts rather than refuses at a hardBreak, per assoc", () => {
    // THE TRAP THIS TEST EXISTS FOR. `findXmlTextAtOffset` finds nothing at a
    // hardBreak, so it would be reasonable to expect a null — and to write the
    // client mint's failure-mode table on that assumption. It is wrong:
    // `flatOffsetToRelPos` retries ±1 in the direction of the assoc and mints
    // anyway. A `from` endpoint (assoc 0) therefore lands one character to the
    // RIGHT of where it was asked for.
    //
    // That is a one-character under-coverage, visually benign, and permanent —
    // nothing downstream reconciles the flat range against the anchor. It is
    // recorded here as the contract so nobody "fixes" a correct anchor into a
    // null, or writes code expecting a null that never arrives.
    const { ydoc, pmDoc } = docPair(SHAPES["hard breaks"]);
    const flat = extractText(ydoc);

    const br = flat.indexOf("\n");
    expect(
      flat.slice(br - 1, br + 2),
      "the fixture must have a hardBreak between two letters",
    ).toBe("a\nb");

    const shifted = flatOffsetToRelPos(ydoc, toFlatOffset(br), 0);
    expect(shifted, "assoc 0 at a hardBreak mints rather than refusing").not.toBeNull();

    const at = relRangeToPmPositions(ydoc, pmDoc, {
      fromRel: shifted!,
      toRel: flatOffsetToRelPos(ydoc, toFlatOffset(br + 1), -1)!,
    });
    // Both endpoints resolve to the same place. The `from` needed the retry and
    // shifted right onto "b"; the `to` needed no retry at all — offset br+1 is
    // already the start of "bravo" — so they meet on one position. Worth stating
    // precisely, because "the `to` snapped back to the end of alpha" describes
    // the same point and is the wrong mechanism.
    expect(at, "the shifted anchor still resolves").not.toBeNull();
    expect(
      pmDoc.textBetween(at!.from, at!.to),
      "so the hardBreak itself is covered by nothing",
    ).toBe("");
  });
});
