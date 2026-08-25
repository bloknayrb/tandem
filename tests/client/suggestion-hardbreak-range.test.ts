/**
 * Annotation ranges across hard breaks (#1450, #1459).
 *
 * The user-visible symptom was document corruption through the primary review
 * action: `applySuggestion` does `deleteRange({from, to})` then inserts at
 * `from`, so a `to` that lands short leaves the tail of the original behind and
 * the accepted text is pasted in front of it —
 *
 *     I had to go find it myself.self.
 *
 * `self.` being the last 5 characters of a paragraph that held exactly 5 hard
 * breaks. Cause: `findXmlTextInParallel` advanced its accumulator only for
 * `Y.XmlText` children, and a hard break is a SIBLING `Y.XmlElement` that
 * occupies one ProseMirror position. Both endpoints drifted, so a mid-paragraph
 * accept also ate text ahead of the range.
 *
 * These tests build a REAL Y.Doc through `loadMarkdown` and a REAL ProseMirror
 * node through the production schema. That matters more than usual: the bug IS
 * the correspondence between the two representations, so the existing
 * mock-PM-node coordinate tests structurally cannot see it — a mock written
 * from the same misunderstanding as the code agrees with the code.
 *
 * SCOPE. These assert the RANGE and what a plain-text replacement over it
 * produces. They deliberately do NOT assert what the shipping accept path
 * inserts: `insertContentAt` HTML-parses its string argument, a separate defect
 * (#1477) covered by `suggestion-literal-insert.test.ts` against a live editor.
 * Conflating the two would let a fix for one hide a regression in the other.
 */

import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { annotationToPmRange } from "../../src/client/positions";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { anchoredRange } from "../../src/server/positions";
import type { Annotation } from "../../src/shared/types";
import { off } from "../helpers/positions";
import { productionSchema, yDocToPmNode } from "./editor-roundtrip-harness.js";

type PMNode = ReturnType<typeof yDocToPmNode>;

/** Build the Y.Doc + PM node pair the client actually holds for a document. */
function docPair(markdown: string) {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, markdown);
  return { ydoc, pmDoc: yDocToPmNode(ydoc, productionSchema()) };
}

/** An annotation anchored the way the server anchors one, over [from, to). */
function anchor(ydoc: Y.Doc, from: number, to: number): Annotation {
  const range = anchoredRange(ydoc, off(from), off(to));
  if (!range) throw new Error(`anchoredRange returned null for ${from}..${to}`);
  return {
    id: "a1",
    type: "comment",
    author: "claude",
    status: "pending",
    text: "suggestion",
    suggestedText: "REPLACED",
    createdAt: 0,
    ...range,
  } as unknown as Annotation;
}

/**
 * Render a node's content structurally, so a `hardBreak` is DISTINGUISHABLE
 * from a literal newline character.
 *
 * `textBetween(..., "\n", "\n")` — the obvious choice — renders both as "\n"
 * and therefore cannot see the one distinction this whole file is about. A test
 * using it passes just as happily when every hard break has been flattened into
 * a newline, which is a real thing the accept path does.
 */
function structure(node: PMNode): string {
  const parts: string[] = [];
  node.forEach((child) => {
    if (child.isText) {
      parts.push(JSON.stringify(child.text));
    } else if (child.isTextblock || child.childCount > 0) {
      parts.push(`${child.type.name}(${structure(child)})`);
    } else {
      parts.push(`<${child.type.name}>`);
    }
  });
  return parts.join("+");
}

/** Resolve, asserting the CRDT path ran — see the note in the first test. */
function resolveRel(ann: Annotation, pmDoc: PMNode, ydoc: Y.Doc) {
  const r = annotationToPmRange(ann, pmDoc, ydoc);
  expect(r, "range did not resolve at all").not.toBeNull();
  // Without this, every assertion below is satisfiable by the flat fallback —
  // which never had the bug. Deleting the entire relRange branch would leave
  // the suite green, and the tests would be covering the wrong code.
  expect(r!.method, "resolved via the flat fallback, not the CRDT path").toBe("rel");
  return r!;
}

/** What the range covers, structurally. */
function covered(pmDoc: PMNode, from: number, to: number): string {
  return structure(pmDoc.slice(from, to).content as unknown as PMNode);
}

// A paragraph with hard breaks, written the way markdown spells them.
const THREE_BREAKS = "alpha\\\nbravo\\\ncharlie\\\ndelta\n";
const PLAIN = "alpha bravo charlie delta\n";
// Flat text of THREE_BREAKS' paragraph — one flat char per break, matching the
// server's getElementText() convention.
const THREE_FLAT = "alpha\nbravo\ncharlie\ndelta";

describe("#1450: a suggestion over a paragraph with hard breaks", () => {
  it("the break-free case works today (positive control)", () => {
    // Without this, a green suite below could mean the harness never resolved
    // anything at all.
    const { ydoc, pmDoc } = docPair(PLAIN);
    const text = "alpha bravo charlie delta";
    const r = resolveRel(anchor(ydoc, 0, text.length), pmDoc, ydoc);
    expect(covered(pmDoc, r.from, r.to)).toBe(JSON.stringify(text));
  });

  it("covers the WHOLE paragraph, hard breaks included, leaving no tail", () => {
    const { ydoc, pmDoc } = docPair(THREE_BREAKS);
    const r = resolveRel(anchor(ydoc, 0, THREE_FLAT.length), pmDoc, ydoc);

    // Before the fix this stopped after "de" — short by 3, the number of hard
    // breaks — so accepting left "lta" behind. Asserted structurally so a
    // hardBreak cannot masquerade as a newline character.
    expect(covered(pmDoc, r.from, r.to)).toBe(
      '"alpha"+<hardBreak>+"bravo"+<hardBreak>+"charlie"+<hardBreak>+"delta"',
    );
  });

  it("the drift was one position per break, not a constant", () => {
    // Checking more than one count is what distinguishes a per-embed drift from
    // an off-by-one; the issue's evidence rested on exactly that.
    for (const breaks of [1, 2, 5]) {
      const words = Array.from({ length: breaks + 1 }, (_, i) => `w${i}`);
      const { ydoc, pmDoc } = docPair(`${words.join("\\\n")}\n`);
      const flat = words.join("\n");
      const r = resolveRel(anchor(ydoc, 0, flat.length), pmDoc, ydoc);

      const expected = words.map((w) => JSON.stringify(w)).join("+<hardBreak>+");
      expect(covered(pmDoc, r.from, r.to), `${breaks} hard breaks`).toBe(expected);
    }
  });

  it("a range STARTING after a hard break is not shifted either", () => {
    // The `from` endpoint drifts by the same mechanism, and a wrong `from`
    // corrupts differently: before the fix this returned "o\ncharl" — shifted
    // back two at BOTH ends — so the accept ate text ahead of the range as well
    // as leaving some behind.
    const { ydoc, pmDoc } = docPair(THREE_BREAKS);
    const from = THREE_FLAT.indexOf("charlie");
    const r = resolveRel(anchor(ydoc, from, from + "charlie".length), pmDoc, ydoc);
    expect(covered(pmDoc, r.from, r.to)).toBe('"charlie"');
  });
});

describe("#1450: nested blocks take a different code path", () => {
  // A break inside a list item or blockquote reaches findXmlTextInParallel's
  // RECURSIVE branch rather than the textblock branch that was fixed. The
  // accumulator is per-textblock, so the fix should hold — but that is a claim
  // about a different branch, and it deserves its own case.
  it("a hard break inside a list item resolves correctly", () => {
    const { ydoc, pmDoc } = docPair("- alpha\\\n  bravo\n- second\n");
    const r = resolveRel(anchor(ydoc, 0, "alpha\nbravo".length), pmDoc, ydoc);
    expect(covered(pmDoc, r.from, r.to)).toContain('"alpha"+<hardBreak>+"bravo"');
  });

  it("a hard break inside a blockquote resolves correctly", () => {
    const { ydoc, pmDoc } = docPair("> alpha\\\n> bravo\n");
    const r = resolveRel(anchor(ydoc, 0, "alpha\nbravo".length), pmDoc, ydoc);
    expect(covered(pmDoc, r.from, r.to)).toContain('"alpha"+<hardBreak>+"bravo"');
  });
});

describe("#1450: replacing the resolved range", () => {
  /**
   * Replay the DELETE half of `applySuggestion` and a plain-text insertion.
   *
   * Honest about what this models: `.deleteRange()` does map to `tr.delete`,
   * but `.insertContentAt()` does NOT simply map to `tr.insertText` — it
   * HTML-parses the string first. So this asserts what a correct replacement
   * over a correct range produces, which is what #1450 is about, and the final
   * describe block covers the insertion defect separately.
   */
  function replaceRange(markdown: string, flatFrom: number, flatTo: number, text: string): string {
    const { ydoc, pmDoc } = docPair(markdown);
    const r = resolveRel(anchor(ydoc, flatFrom, flatTo), pmDoc, ydoc);
    const state = EditorState.create({ doc: pmDoc });
    const tr = state.tr.delete(r.from, r.to);
    tr.insertText(text, r.from);
    return structure(state.apply(tr).doc);
  }

  it("replacing a whole break-bearing paragraph leaves NO residue", () => {
    expect(replaceRange(THREE_BREAKS, 0, THREE_FLAT.length, "REPLACED")).toBe(
      'paragraph("REPLACED")',
    );
  });

  it("the issue's own five-break shape comes back clean", () => {
    const words = ["one", "two", "three", "four", "five", "six"];
    const flat = words.join("\n");
    expect(replaceRange(`${words.join("\\\n")}\n`, 0, flat.length, "CLEAN")).toBe(
      'paragraph("CLEAN")',
    );
  });

  it("a mid-paragraph replacement keeps the surrounding breaks intact", () => {
    const from = THREE_FLAT.indexOf("charlie");
    // Structural, so this would fail if the surrounding hard breaks had been
    // flattened to newline characters — which a text-level assertion misses.
    expect(replaceRange(THREE_BREAKS, from, from + 7, "CHARLIE")).toBe(
      'paragraph("alpha"+<hardBreak>+"bravo"+<hardBreak>+"CHARLIE"+<hardBreak>+"delta")',
    );
  });
});

// The insert half of the same action (#1477) is covered by
// `suggestion-literal-insert.test.ts`, against a LIVE Tiptap editor.
//
// This file previously pinned that defect here using `createNodeFromContent`
// directly. That was the wrong instrument and two of its assertions were simply
// false of the shipping path: in isolation the helper collapses "one\ntwo" to
// "one two" and decodes "&amp;", but a real editor — whose paragraph carries
// `whitespace: "pre"` (#1461) — does neither. Worse, those assertions would have
// stayed green after #1477 was fixed, so the known-defect convention they
// claimed to follow could never have fired. Removed rather than corrected in
// place: a probe that cannot observe the product does not become trustworthy by
// having its expected values patched.

describe("#1450: the schema assumption the fix rests on", () => {
  it("hardBreak is the only inline non-text node in the production schema", () => {
    // The fix counts every non-text inline child as one position, which is
    // right for any inline leaf. `textblockFlatLength` counts ONLY hardBreak
    // and the server charges a separator plus nested length for a non-leaf, so
    // a second shape would put three conventions in play. The runtime warn in
    // `findXmlTextInParallel` is the other half of this guard.
    const schema = productionSchema();
    const inlineLeaves = Object.values(schema.nodes)
      .filter((t) => t.isInline && !t.isText)
      .map((t) => t.name)
      .sort();
    expect(inlineLeaves).toEqual(["hardBreak"]);
  });
});
