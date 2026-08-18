// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it } from "vitest";
import { yUndoPluginKey } from "y-prosemirror";
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
 * Mid-range insertion splits the covering entry — #1471 gap 3.
 *
 * WHAT WAS WRONG. A range's two endpoints are independent anchors, which makes
 * a DELETION self-healing: clip either side and the entry resolves to the
 * sub-span it still owns. An insertion in the middle is the one case that
 * property does not cover — neither endpoint's item is touched, so the entry
 * stretches over text it did not author. Measured on master before this landed,
 * typing `CLAUDE` into the middle of a user-authored `USERTEXT`:
 *
 *     user   = "USERCLAUDETEXT"
 *     claude = "CLAUDE"
 *
 * Six characters carrying two inline decorations with conflicting
 * `data-tandem-author`, and counted for both authors in the gutter. That is
 * #1388's render reached from a third direction.
 *
 * EVERY ASSERTION HERE GOES THROUGH `buildAuthorshipDecorations`, the real
 * render path, rather than re-deriving spans from the stored entries. A test
 * that resolves the anchors itself is asserting against its own copy of the
 * logic under test and stays green when production breaks — the
 * `a-mock-cannot-see-a-correspondence-bug` shape, which this area has already
 * produced once.
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

/** Decoration attributes are not on the public `Decoration` type. */
function decorationAttr(decoration: unknown, name: string): string | undefined {
  return (decoration as { type?: { attrs?: Record<string, string> } }).type?.attrs?.[name];
}

/** Text each inline authorship decoration covers, keyed by author. */
function decoratedTextByAuthor(ydoc: Y.Doc, editor: Editor): Record<string, string[]> {
  const doc = editor.state.doc;
  const set = buildAuthorshipDecorations(doc, ydoc.getMap(Y_MAP_AUTHORSHIP), ydoc, true);
  const out: Record<string, string[]> = {};
  for (const decoration of set.find()) {
    const author = decorationAttr(decoration, "data-tandem-author");
    if (!author) continue;
    (out[author] ??= []).push(doc.textBetween(decoration.from, decoration.to));
  }
  for (const key of Object.keys(out)) out[key].sort();
  return out;
}

/**
 * How many inline decorations cover each character position.
 *
 * The property gap 3 is actually about. Asserting the two authors' TEXTS
 * separately is not enough — `user=["USER","TEXT"]` and `claude=["CLAUDE"]`
 * would also be produced by a broken split that dropped a character, and the
 * gutter's `dominant` is computed from per-character coverage, so this is the
 * number that skews.
 */
function coverageCounts(ydoc: Y.Doc, editor: Editor): number[] {
  const doc = editor.state.doc;
  const set = buildAuthorshipDecorations(doc, ydoc.getMap(Y_MAP_AUTHORSHIP), ydoc, true);
  const counts = new Array<number>(doc.content.size).fill(0);
  for (const decoration of set.find()) {
    if (!decorationAttr(decoration, "data-tandem-author")) continue;
    for (let at = decoration.from; at < decoration.to; at++) counts[at]++;
  }
  return counts;
}

/** The `dominant` author each block's gutter decoration reports, in document order. */
function gutterAuthors(ydoc: Y.Doc, editor: Editor): string[] {
  const doc = editor.state.doc;
  const set = buildAuthorshipDecorations(doc, ydoc.getMap(Y_MAP_AUTHORSHIP), ydoc, true);
  const blocks: { from: number; block: string }[] = [];
  for (const decoration of set.find()) {
    const block = decorationAttr(decoration, "data-tandem-author-block");
    if (block) blocks.push({ from: decoration.from, block });
  }
  return blocks.sort((a, b) => a.from - b.from).map((entry) => entry.block);
}

/** Seed a user-authored `USERTEXT` and return the offset of its midpoint. */
function seedUserText(editor: Editor) {
  const end = editor.state.doc.content.size - 1;
  editor.view.dispatch(editor.state.tr.insertText("USERTEXT", end));
  const start = editor.state.doc.textContent.indexOf("USERTEXT") + 1;
  return { start, mid: start + 4, end: start + "USERTEXT".length };
}

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
  _resetAuthorshipWarnLatch();
});

describe("an insertion inside a stamped range splits it", () => {
  it("TEST 0 — the binding is real and the seeded stamp is anchored", () => {
    // ANTI-VACUUM. Without a Collaboration binding the Y fragment is empty,
    // every mint declines, and every test below silently becomes a green test
    // of the unanchored degradation path — which is exactly the state that let
    // this area ship broken for months.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    expect(ydoc.getXmlFragment("default").length).toBeGreaterThan(0);
    seedUserText(editor);
    expect(entries()).toHaveLength(1);
    expect(entries()[0].relRange, "the seeded stamp must be anchored").toBeDefined();
  });

  it("strictly inside: no character is covered twice", () => {
    // THE BUG. Before the split this produced user="USERCLAUDETEXT" over
    // claude="CLAUDE" — the assertion that inverts.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const { mid } = seedUserText(editor);

    editor.view.dispatch(
      editor.state.tr.insertText("CLAUDE", mid).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );

    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({
      claude: ["CLAUDE"],
      user: ["TEXT", "USER"],
    });
    expect(
      Math.max(...coverageCounts(ydoc, editor)),
      "no character may carry two authorship decorations",
    ).toBe(1);
    // Three entries: the left half keeping the original id, the new right half,
    // and Claude's own stamp.
    expect(entries()).toHaveLength(3);
    expect(entries().every((entry) => entry.relRange !== undefined)).toBe(true);
  });

  it("reuses the original's outer anchors instead of re-minting them", () => {
    // The first piece's `from` and the last piece's `to` ARE the entry's
    // existing endpoints. Re-deriving them would push two known-good CRDT
    // anchors back through the PM↔Y model seam — the correspondence that
    // drifted silently in #1450/#1459 — and then overwrite the originals with
    // the result. The all-or-nothing guard would not catch a bad outcome:
    // `flatOffsetToRelPos` has an assoc-directed ±1 retry whose whole purpose
    // is to return a NON-null anchor at a different offset than asked for.
    const { editor, entries } = boundEditor("seed\n");
    const { mid } = seedUserText(editor);
    const original = entries()[0];
    const originalFrom = JSON.stringify(original.relRange?.fromRel);
    const originalTo = JSON.stringify(original.relRange?.toRel);

    editor.view.dispatch(
      editor.state.tr.insertText("CLAUDE", mid).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );

    const halves = entries()
      .filter((entry) => entry.author === "user")
      .sort((a, b) => a.range.from - b.range.from);
    expect(halves).toHaveLength(2);
    expect(
      JSON.stringify(halves[0].relRange?.fromRel),
      "first piece keeps the original start",
    ).toBe(originalFrom);
    expect(JSON.stringify(halves[1].relRange?.toRel), "last piece keeps the original end").toBe(
      originalTo,
    );
  });

  it("derives piece ids from the original so a server re-stamp can find the family", () => {
    // `stampClaudeAuthorshipWholeDoc` keys entries `claude-block-{i}` so a
    // re-open re-`set`s the same key rather than accumulating duplicates.
    // Freshly generated ids would put every piece but the first beyond its
    // reach: the re-stamp would restore the whole-block range on top of
    // orphans it cannot see. The server half of this contract is pinned in
    // `tests/server/authorship-tracking.test.ts`.
    const { editor, entries } = boundEditor("seed\n");
    const { mid } = seedUserText(editor);
    const original = entries()[0];

    editor.view.dispatch(
      editor.state.tr.insertText("CLAUDE", mid).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );

    expect(
      entries()
        .filter((entry) => entry.author === "user")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([original.id, `${original.id}#1`].sort());
  });

  it("a SAME-author insertion does not split, and the gutter is not skewed by the overlap", () => {
    // The performance gate, and why it is safe. Splitting a same-author entry
    // changes no inline render — the union of the pieces is the original span
    // in the same colour — so the only thing it ever fixed was the gutter's
    // character counts. Two reviews measured the ungated version at 42-51x
    // slower per keystroke at 1,500 entries, including at the end of the
    // document where nothing splits at all, because containment was tested
    // after resolving every entry.
    //
    // What makes the skip neutral rather than a regression is that the gutter
    // now resolves an author PER CHARACTER instead of summing per-entry
    // overlaps. Without that, the stretched entry's characters would be counted
    // twice for `"user"` and could flip `dominant` in a mixed block.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const { mid, end } = seedUserText(editor);

    // The character counts have to STRADDLE the tipping point or this test
    // passes for the wrong reason — the first draft used 16 Claude characters
    // and the summing bug stayed green, because 12 double-counted user
    // characters still lost to 16. Claude writes 11; the user ends up owning 10
    // real characters across two entries, which sums to 12. So per-character
    // gives `claude` (10 < 11) and summing gives `user` (12 >= 11), and the two
    // are distinguishable by exactly one assertion.
    editor.view.dispatch(
      editor.state.tr.insertText("CCCCCCCCCCC", end).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );
    expect(gutterAuthors(ydoc, editor)).toEqual(["claude"]);

    const userEntriesBefore = entries().filter((entry) => entry.author === "user").length;
    editor.view.dispatch(editor.state.tr.insertText("uu", mid));

    expect(
      entries().filter((entry) => entry.author === "user").length,
      "the same-author entry is left whole — only a new stamp is added",
    ).toBe(userEntriesBefore + 1);
    expect(
      gutterAuthors(ydoc, editor),
      "and the overlap must not inflate the user count into a flipped dominant",
    ).toEqual(["claude"]);
  });

  it("the halves inherit the original author, timestamp and left-hand id", () => {
    const { editor, entries } = boundEditor("seed\n");
    const { mid } = seedUserText(editor);
    const original = entries()[0];

    editor.view.dispatch(
      editor.state.tr.insertText("CLAUDE", mid).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );

    const halves = entries().filter((entry) => entry.author === "user");
    expect(halves).toHaveLength(2);
    expect(halves.map((half) => half.timestamp)).toEqual([original.timestamp, original.timestamp]);
    expect(
      halves.some((half) => half.id === original.id),
      "the left half keeps the original id — a split is not a re-authoring",
    ).toBe(true);
  });

  it("at the exact START of a range: shifts, does not split", () => {
    // This and the END case below pin the ASSOC PAIR, not the split's
    // containment test. `from` sticks right and `to` sticks left, so an edge
    // insertion lands outside the resolved span and there is nothing to
    // divide. Worth being exact about: relaxing the split's `<` to `<=` fails
    // neither of these, because containment already fails on the far endpoint.
    // What would break them is an assoc change, and that is the invariant they
    // are really guarding.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const { start } = seedUserText(editor);

    editor.view.dispatch(
      editor.state.tr.insertText("CLAUDE", start).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );

    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({
      claude: ["CLAUDE"],
      user: ["USERTEXT"],
    });
    expect(entries().filter((entry) => entry.author === "user")).toHaveLength(1);
  });

  it("at the exact END of a range: appends, does not split", () => {
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const { end } = seedUserText(editor);

    editor.view.dispatch(
      editor.state.tr.insertText("CLAUDE", end).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );

    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({
      claude: ["CLAUDE"],
      user: ["USERTEXT"],
    });
    expect(entries().filter((entry) => entry.author === "user")).toHaveLength(1);
  });

  it("KNOWN LIMITATION: splitting the BLOCK loses the tail's attribution", () => {
    // NOT FIXED, and pinned so it is a known quantity rather than a surprise.
    // Filed as #1512; the doc-comment on `splitCoveringEntries` names it so
    // that function does not read as complete coverage of insertions.
    //
    // y-prosemirror implements a block split by DELETING the tail out of the
    // original `Y.XmlText` and re-inserting it into a new one, which destroys
    // the covering entry's `toRel` before anything can react. By the time the
    // split scan resolves the entry it has already collapsed to the split
    // point, so the strictly-inside test fails and there is nothing to cut.
    // The reap cannot help either — it skips anchored entries by design
    // (#1480), because deleting one destroys attribution permanently.
    //
    // This predates the gap-3 work and is unchanged by it. Fixing it needs a
    // different mechanism: re-anchor across the split inside the step loop,
    // where the before-frame still exists.
    const { ydoc, editor } = boundEditor("seed\n");
    const { mid } = seedUserText(editor);
    expect(decoratedTextByAuthor(ydoc, editor).user).toEqual(["USERTEXT"]);

    editor.view.dispatch(editor.state.tr.split(mid));

    expect(editor.state.doc.childCount, "the paragraph really did split").toBe(2);
    // `""` is the second, adjacent thing the issue records: the split step
    // reports `insertedLen > 0` for the block separator, so it mints a stamp
    // covering no visible text at all. Harmless, pure noise in a map that
    // already grows without bound, and asserted rather than filtered so that
    // suppressing it is a visible change rather than a silent one.
    expect(
      decoratedTextByAuthor(ydoc, editor).user,
      "the tail moved into the new block and lost its attribution — the limitation",
    ).toEqual(["", "USER"]);
  });

  it("an UNANCHORED covering entry degrades rather than splitting", () => {
    // THE DEGRADATION CONTRACT. A stored flat range on an unanchored entry is
    // not trustworthy enough to cut on — the offsets may already have drifted,
    // and a wrong cut is permanent. So the old overlap survives here, which is
    // no worse than the behaviour that shipped, and the entry stays whole.
    const ydoc = new Y.Doc();
    const editor = new Editor({
      extensions: [...buildSchemaExtensions(), AuthorshipExtension.configure({ ydoc })],
      content: "<p>seed</p>",
    });
    live.push(editor);

    const end = editor.state.doc.content.size - 1;
    editor.view.dispatch(editor.state.tr.insertText("USERTEXT", end));
    const entries = () => [...ydoc.getMap(Y_MAP_AUTHORSHIP).values()] as AuthorshipRange[];
    expect(entries()[0].relRange, "no fragment to anchor into — the premise").toBeUndefined();

    const mid = editor.state.doc.textContent.indexOf("USERTEXT") + 1 + 4;
    editor.view.dispatch(
      editor.state.tr.insertText("CLAUDE", mid).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );

    expect(entries().filter((entry) => entry.author === "user")).toHaveLength(1);
  });

  it("undoing the insertion leaves the halves adjacent, covering the original text", () => {
    // WHY DELETE-AND-REPLACE IS SAFE HERE WHEN THE REAP'S DELETE WAS NOT.
    // Nothing restores a Y.Map entry on undo, so the reap stopped deleting
    // anchored entries (#1480). The split has no such problem: the two halves
    // resolve back adjacent, which renders identically to the single range they
    // came from. Lossy in identity, not in attribution.
    const { ydoc, editor } = boundEditor("seed\n");
    const { mid } = seedUserText(editor);

    // Close the stack item, or `captureTimeout` (500ms) merges the seed and the
    // insertion into one item and the undo reverts both — the fixture would
    // then measure a document with no user text in it at all.
    const manager = (
      yUndoPluginKey.getState(editor.state) as { undoManager?: Y.UndoManager } | undefined
    )?.undoManager;
    if (!manager) throw new Error("no UndoManager — the Collaboration binding is not live");
    manager.stopCapturing();

    editor.view.dispatch(
      editor.state.tr.insertText("CLAUDE", mid).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );
    expect(decoratedTextByAuthor(ydoc, editor).user).toEqual(["TEXT", "USER"]);

    manager.undo();

    expect(editor.state.doc.textContent).toContain("USERTEXT");
    expect(
      decoratedTextByAuthor(ydoc, editor).user,
      "the halves must resolve back adjacent, covering the whole original span",
    ).toEqual(["TEXT", "USER"]);
    expect(Math.max(...coverageCounts(ydoc, editor)), "and still nothing double-covered").toBe(1);
    expect(decoratedTextByAuthor(ydoc, editor).claude).toBeUndefined();
  });

  it("TWO insertions into the same entry in one transaction cut it into three", () => {
    // THE CASE THAT FORCED THE DESIGN. This is find-replace-all: several
    // `"claude"` insertions into one `"user"` entry in a single transaction.
    // An earlier draft cut per insertion and had to skip any entry it had
    // already cut — the pieces are not in the map yet, so a second pass would
    // measure the pre-split span and emit overlapping ones. That skip made the
    // second cut degrade to exactly the double-coverage this file exists to
    // remove, measured at 2. Cutting by the whole sorted set at once has no
    // such case, and this test is what caught it.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const { start } = seedUserText(editor);

    const tr = editor.state.tr;
    // Later position first, the order find-replace-all applies its matches in.
    tr.insertText("BB", start + 6);
    tr.insertText("AA", start + 2);
    editor.view.dispatch(tr.setMeta(AUTHORSHIP_ORIGIN_META, "claude"));

    expect(editor.state.doc.textContent).toContain("USAAERTEBBXT");
    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({
      claude: ["AA", "BB"],
      user: ["ERTE", "US", "XT"],
    });
    expect(Math.max(...coverageCounts(ydoc, editor)), "nothing double-covered").toBe(1);
    expect(entries().filter((entry) => entry.author === "user")).toHaveLength(3);
  });
});
