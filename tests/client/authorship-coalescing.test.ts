// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it } from "vitest";
import { ySyncPluginKey, yUndoPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  _resetAuthorshipWarnLatch,
  AUTHORSHIP_ORIGIN_META,
  AuthorshipExtension,
  buildAuthorshipDecorations,
} from "../../src/client/editor/extensions/authorship";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { Y_MAP_AUTHORSHIP } from "../../src/shared/constants";
import type { AuthorshipRange } from "../../src/shared/types";

/**
 * Consecutive same-author stamps coalesce into one entry.
 *
 * WHY. `Y.Map('authorship')` gained one entry per doc-changing transaction and
 * was never compacted — and since anchored entries stopped being reaped (#1480,
 * because nothing restores a Y.Map entry on undo) it had no removal path left at
 * all. The effect was visible in the DOM, not merely in the map:
 * `tests/e2e/authorship-attribution.spec.ts` types 24 characters and used to get
 * 24 entries, 24 inline decorations and 24 one-character `<span>`s, which is how
 * a `.last()` assertion there ended up matching a single letter.
 *
 * EVERY FIXTURE HERE USES A BOUND EDITOR. Without the `Collaboration`
 * extension `ydoc.getXmlFragment("default")` is empty, every mint declines, and
 * coalescing — which requires both entries anchored — can never fire. Each test
 * below would then pass while proving nothing, which is the exact state the
 * authorship suite was already in for months (`authorship-anchor.test.ts:19-33`).
 *
 * AND EVERY KEYSTROKE IS ITS OWN DISPATCH. `insertContent("hello")` is one
 * transaction and therefore one stamp *already*, so a fixture built that way
 * passes identically with coalescing reverted.
 */

const live: Editor[] = [];

function boundEditor(markdown: string) {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, markdown);
  const editor = new Editor({
    extensions: [
      ...buildSchemaExtensions(),
      Collaboration.configure({ document: ydoc }),
      AuthorshipExtension.configure({ ydoc }),
    ],
  });
  live.push(editor);
  const entries = () => [...ydoc.getMap(Y_MAP_AUTHORSHIP).values()] as AuthorshipRange[];
  return { ydoc, editor, entries };
}

/** Type each character as a SEPARATE transaction, the way a person does. */
function typeChars(editor: Editor, text: string, at: number, author?: "user" | "claude"): number {
  let pos = at;
  for (const char of text) {
    const tr = editor.state.tr.insertText(char, pos);
    editor.view.dispatch(author ? tr.setMeta(AUTHORSHIP_ORIGIN_META, author) : tr);
    pos += 1;
  }
  return pos;
}

/** Text each inline authorship decoration covers, keyed by author. */
function decoratedTextByAuthor(ydoc: Y.Doc, editor: Editor): Record<string, string[]> {
  const doc = editor.state.doc;
  const set = buildAuthorshipDecorations(doc, ydoc.getMap(Y_MAP_AUTHORSHIP), ydoc, true);
  const out: Record<string, string[]> = {};
  for (const decoration of set.find()) {
    const author = (decoration as { type?: { attrs?: Record<string, string> } }).type?.attrs?.[
      "data-tandem-author"
    ];
    if (!author) continue;
    (out[author] ??= []).push(doc.textBetween(decoration.from, decoration.to));
  }
  for (const key of Object.keys(out)) out[key].sort();
  return out;
}

/** Highest number of inline authorship decorations over any one character. */
function maxCoverage(ydoc: Y.Doc, editor: Editor): number {
  const doc = editor.state.doc;
  const set = buildAuthorshipDecorations(doc, ydoc.getMap(Y_MAP_AUTHORSHIP), ydoc, true);
  const counts = new Array<number>(doc.content.size).fill(0);
  for (const decoration of set.find()) {
    const author = (decoration as { type?: { attrs?: Record<string, string> } }).type?.attrs?.[
      "data-tandem-author"
    ];
    if (!author) continue;
    for (let at = decoration.from; at < decoration.to; at++) counts[at]++;
  }
  return Math.max(0, ...counts);
}

function undoManager(editor: Editor): Y.UndoManager {
  const manager = (
    yUndoPluginKey.getState(editor.state) as { undoManager?: Y.UndoManager } | undefined
  )?.undoManager;
  if (!manager) throw new Error("no UndoManager — the Collaboration binding is not live");
  return manager;
}

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
  _resetAuthorshipWarnLatch();
});

describe("consecutive same-author stamps coalesce", () => {
  it("TEST 0 — the binding is real and a single stamp anchors", () => {
    // ANTI-VACUUM. If this fails, every test below is measuring the unanchored
    // path, where coalescing can never fire and everything passes trivially.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    expect(ydoc.getXmlFragment("default").length).toBeGreaterThan(0);
    typeChars(editor, "X", editor.state.doc.content.size - 1);
    expect(entries()).toHaveLength(1);
    expect(entries()[0].relRange, "the stamp must be anchored").toBeDefined();
  });

  it("typing eight characters produces ONE entry covering all eight", () => {
    // THE HEADLINE. Eight separate dispatches, one entry.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    typeChars(editor, "abcdefgh", editor.state.doc.content.size - 1);

    expect(entries(), "eight keystrokes, one entry").toHaveLength(1);
    // Asserted through the real render path, not from the stored range: a merge
    // that gets `range` right and `relRange` wrong paints perfectly wrongly, and
    // this suite has produced that mistake before.
    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["abcdefgh"] });
    expect(maxCoverage(ydoc, editor)).toBe(1);
  });

  it("the merged entry keeps the FIRST stamp's id and timestamp", () => {
    // A coalesce is not a re-authoring. The id matters because the server's
    // `claude-block-{i}` family logic and the split's derived `{id}#n` ids are
    // both keyed on identity; the timestamp then reads as the start of the run.
    const { editor, entries } = boundEditor("seed\n");
    const at = editor.state.doc.content.size - 1;
    typeChars(editor, "a", at);
    const first = { ...entries()[0] };

    typeChars(editor, "bcd", at + 1);

    expect(entries()).toHaveLength(1);
    expect(entries()[0].id).toBe(first.id);
    expect(entries()[0].timestamp).toBe(first.timestamp);
  });

  it("a change of AUTHOR breaks the chain", () => {
    // Over-merging is the failure that would corrupt attribution rather than
    // merely inflate the map, so this is primarily a guard against it. But note
    // it asserts BOTH directions at once, because each run is two characters:
    // with coalescing disabled the count is four, not two. A version typing one
    // character per author would be the pure guard the label suggests, and
    // would prove nothing on its own.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const at = editor.state.doc.content.size - 1;
    const next = typeChars(editor, "uu", at);
    typeChars(editor, "cc", next, "claude");

    expect(entries()).toHaveLength(2);
    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["uu"], claude: ["cc"] });
  });

  it("a NON-ADJACENT insertion breaks the chain", () => {
    // Same shape as the author-change case above: two-character runs mean the
    // count of two proves the separation AND the merge within each run.
    const { ydoc, editor, entries } = boundEditor("alpha bravo\n");
    typeChars(editor, "XX", editor.state.doc.content.size - 1);
    // Well away from the previous stamp, at the very start of the paragraph.
    typeChars(editor, "YY", 1);

    expect(entries()).toHaveLength(2);
    expect(decoratedTextByAuthor(ydoc, editor).user?.sort()).toEqual(["XX", "YY"]);
  });

  it("an UNANCHORED candidate is never coalesced — with the anchored control", () => {
    // The guard AND its positive anchor in one test. On its own the unbound
    // half is green even with coalescing working perfectly, because nothing
    // anchors there and nothing could merge; the bound half is what shows the
    // difference is the anchor rather than the harness.
    const ydoc = new Y.Doc();
    const unbound = new Editor({
      extensions: [...buildSchemaExtensions(), AuthorshipExtension.configure({ ydoc })],
      content: "<p>seed</p>",
    });
    live.push(unbound);
    typeChars(unbound, "abcd", unbound.state.doc.content.size - 1);
    const unboundEntries = [...ydoc.getMap(Y_MAP_AUTHORSHIP).values()] as AuthorshipRange[];
    expect(unboundEntries.every((entry) => entry.relRange === undefined)).toBe(true);
    expect(unboundEntries, "no anchor, no merge — four keystrokes, four entries").toHaveLength(4);

    const bound = boundEditor("seed\n");
    typeChars(bound.editor, "abcd", bound.editor.state.doc.content.size - 1);
    expect(bound.entries(), "the identical run merges once anchored").toHaveLength(1);
  });

  it("undo after a coalesce shrinks the entry back to the surviving text", () => {
    // The property the design turns on, and the fixture has to fight the
    // UndoManager to test it: `captureTimeout` (500ms) merges a burst into ONE
    // stack item, so without `stopCapturing()` a single undo removes the whole
    // run and the merged `toRel` is never exercised at all.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const at = editor.state.doc.content.size - 1;
    const next = typeChars(editor, "abc", at);
    undoManager(editor).stopCapturing();
    typeChars(editor, "d", next);

    expect(entries(), "still one entry after the fourth character").toHaveLength(1);
    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["abcd"] });

    undoManager(editor).undo();

    expect(editor.state.doc.textContent).toBe("seedabc");
    expect(
      decoratedTextByAuthor(ydoc, editor),
      "the merged anchor must shrink to the surviving text, not paint past it",
    ).toEqual({ user: ["abc"] });
  });

  it("backspace then retype still merges", () => {
    // The case that decides how much this is worth. A deletion is a
    // doc-changing transaction that stamps nothing; `lastStampId` is
    // deliberately left alone there, so the retype continues the run instead of
    // starting a new entry. Backspace-and-retype is the commonest editing
    // rhythm there is.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const at = editor.state.doc.content.size - 1;
    const next = typeChars(editor, "abc", at);
    expect(entries()).toHaveLength(1);

    editor.view.dispatch(editor.state.tr.delete(next - 1, next));
    expect(editor.state.doc.textContent).toBe("seedab");

    typeChars(editor, "XY", next - 1);

    expect(entries(), "the run continues across the deletion").toHaveLength(1);
    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["abXY"] });
  });

  it("deleting a whole run and retyping reuses the entry rather than orphaning it", () => {
    // The COLLAPSED-candidate case, which is delete-a-word-and-retype rather
    // than anything exotic. Plan review recommended refusing to merge into a
    // collapsed entry, for symmetry with `splitCoveringEntries`. Measured both
    // ways, the render is identical — the guard's only effect is to leave the
    // collapsed entry behind forever, since anchored entries are never reaped,
    // which is the accumulation this whole change exists to stop. So the guard
    // is deliberately absent and this is what pins that decision.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const at = editor.state.doc.content.size - 1;
    const next = typeChars(editor, "abc", at);
    editor.view.dispatch(editor.state.tr.delete(at, next));
    typeChars(editor, "XY", at);

    expect(editor.state.doc.textContent).toBe("seedXY");
    expect(
      entries(),
      "the collapsed entry is reused, not orphaned alongside a new one",
    ).toHaveLength(1);
    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["XY"] });
  });

  it("a different-author insertion still SPLITS a coalesced entry", () => {
    // Coalescing makes long entries, which makes `splitCoveringEntries` go from
    // rarely-firing to routine. The two must compose: this is the gap-3 case
    // over a merged run rather than a single stamp.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const at = editor.state.doc.content.size - 1;
    typeChars(editor, "USERTEXT", at);
    expect(entries()).toHaveLength(1);

    typeChars(editor, "C", at + 4, "claude");

    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({
      claude: ["C"],
      user: ["TEXT", "USER"],
    });
    expect(maxCoverage(ydoc, editor), "nothing double-covered").toBe(1);
  });

  it("a remote y-sync change between two keystrokes breaks the chain", () => {
    // Re-resolving the candidate catches one whose OFFSETS moved. It does not
    // catch one that should no longer be a candidate at all — a remote edit, an
    // MCP edit or a force-reload changes the document under it. Hence the
    // explicit clear before the y-sync early return.
    const { editor, entries } = boundEditor("seed\n");
    const at = editor.state.doc.content.size - 1;
    const next = typeChars(editor, "ab", at);
    expect(entries()).toHaveLength(1);

    // A doc-changing transaction wearing y-prosemirror's own key, which is how
    // every remote apply arrives.
    editor.view.dispatch(editor.state.tr.insertText("R", 1).setMeta(ySyncPluginKey, {}));

    typeChars(editor, "cd", next + 1);

    expect(entries(), "the pre-remote candidate must not be extended").toHaveLength(2);
  });

  it("does NOT merge across a block boundary", () => {
    // Cannot happen under the adjacency rule rather than being prevented by a
    // special case: every block separator costs exactly one flat character, so
    // two stamps either side of a paragraph break are never adjacent.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    typeChars(editor, "aa", editor.state.doc.content.size - 1);
    editor.view.dispatch(editor.state.tr.split(editor.state.doc.content.size - 1));
    typeChars(editor, "bb", editor.state.doc.content.size - 1);

    expect(editor.state.doc.childCount).toBe(2);
    // Exactly two entries and exactly two runs. The count used to be written as
    // `>= 2` to leave room for the split's own separator stamp; that stamp is
    // no longer minted, so the loose bound has nothing left to tolerate — and a
    // bound that tolerates an unknown extra entry cannot see one appear.
    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["aa", "bb"] });
    expect(entries().length, "the two runs stay separate").toBe(2);
  });

  it("the map does not grow per keystroke over a burst", () => {
    // The growth claim itself, stated as the number that matters.
    const { editor, entries } = boundEditor("seed\n");
    typeChars(
      editor,
      "the quick brown fox jumps over the lazy dog",
      editor.state.doc.content.size - 1,
    );

    expect(entries().length, "43 keystrokes must not produce 43 entries").toBe(1);
  });
});
