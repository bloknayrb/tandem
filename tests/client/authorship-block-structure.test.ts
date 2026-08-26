// @vitest-environment happy-dom

import { Editor, Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  _resetAuthorshipWarnLatch,
  AUTHORSHIP_ORIGIN_META,
  AuthorshipExtension,
  authorshipPluginKey,
  buildAuthorshipDecorations,
  type StructuralCapture,
} from "../../src/client/editor/extensions/authorship";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { Y_MAP_AUTHORSHIP } from "../../src/shared/constants";
import type { AuthorshipRange } from "../../src/shared/types";
import { timeoutMs } from "../helpers/timing.js";

/**
 * Attribution survives a block-structure change — #1512 and its siblings.
 *
 * y-prosemirror implements Enter, backspace-join, a heading toggle, a list or
 * blockquote wrap, and a multi-block paste by DELETING the affected text out of
 * its `Y.XmlText` (or rebuilding the `Y.XmlElement` outright) and inserting
 * fresh items. Nothing links the new items to the old, so a covering entry's
 * anchor cannot follow. Measured on master before this landed, one anchored
 * `user` entry over `USERTEXT`:
 *
 *     Enter mid-word      user = ["USER"]        the tail lost its author
 *     backspace-join      nothing at all
 *     heading toggle      nothing at all
 *     bullet-list wrap    nothing at all
 *     blockquote wrap     nothing at all
 *     paste 2 paragraphs  user = ["USERAABB"]    tail lost, paste absorbed
 *
 * The four that render nothing are silent: an anchored entry never falls back
 * to its flat range (#1471 §1.5), so the colouring just disappears.
 *
 * EVERY ASSERTION GOES THROUGH `buildAuthorshipDecorations`, never by
 * re-resolving anchors in the test — a test that resolves them itself asserts
 * against its own copy of the logic under test.
 */

const live: Editor[] = [];

function boundEditor(markdown: string, extra: Extension[] = []) {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, markdown);
  const editor = new Editor({
    extensions: [
      ...buildSchemaExtensions(),
      Collaboration.configure({ document: ydoc }),
      AuthorshipExtension.configure({ ydoc }),
      ...extra,
    ],
  });
  live.push(editor);
  const entries = () => [...ydoc.getMap(Y_MAP_AUTHORSHIP).values()] as AuthorshipRange[];
  return { ydoc, editor, entries };
}

function decorationAttr(decoration: unknown, name: string): string | undefined {
  return (decoration as { type?: { attrs?: Record<string, string> } }).type?.attrs?.[name];
}

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

/** `pos:author` per block gutter decoration, in document order. */
function gutterAuthors(ydoc: Y.Doc, editor: Editor): string[] {
  const doc = editor.state.doc;
  const set = buildAuthorshipDecorations(doc, ydoc.getMap(Y_MAP_AUTHORSHIP), ydoc, true);
  const blocks: { from: number; author: string }[] = [];
  for (const decoration of set.find()) {
    const author = decorationAttr(decoration, "data-tandem-author-block");
    if (author) blocks.push({ from: decoration.from, author });
  }
  return blocks.sort((a, b) => a.from - b.from).map((b) => b.author);
}

/** How many inline authorship decorations cover each position. */
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

/** Type a user-authored `USERTEXT` at the end of the first block. */
function seedUserText(editor: Editor) {
  const end = editor.state.doc.content.size - 1;
  editor.view.dispatch(editor.state.tr.insertText("USERTEXT", end));
  const start = editor.state.doc.textContent.indexOf("USERTEXT") + 1;
  return { start, mid: start + 4, end: start + "USERTEXT".length };
}

function captureOf(editor: Editor) {
  return (authorshipPluginKey.getState(editor.state) as { capture?: StructuralCapture } | undefined)
    ?.capture;
}

function isStructural(step: unknown): boolean {
  return (step as { structure?: boolean }).structure === true;
}

/** A two-paragraph slice, open at both ends — what a multi-block paste inserts. */
function twoParagraphSlice(editor: Editor) {
  const node = editor.state.schema.nodeFromJSON({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "AA" }] },
      { type: "paragraph", content: [{ type: "text", text: "BB" }] },
    ],
  });
  return new Slice(node.content, 1, 1);
}

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
  _resetAuthorshipWarnLatch();
  vi.restoreAllMocks();
});

describe("attribution survives a block-structure change", () => {
  it("TEST 0 — the binding is real and the seeded stamp is anchored", () => {
    // ANTI-VACUUM. Without a Collaboration binding the fragment is empty, every
    // mint declines, and every case below becomes a green test of the degraded
    // path — which is the state that let this area ship broken for months.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    expect(ydoc.getXmlFragment("default").length).toBeGreaterThan(0);
    seedUserText(editor);
    expect(entries()).toHaveLength(1);
    expect(entries()[0].relRange, "the seeded stamp must be anchored").toBeDefined();
  });

  it("Enter mid-run keeps the tail attributed", () => {
    // #1512 as filed. `user === ["USER"]` before this change.
    const { ydoc, editor } = boundEditor("seed\n");
    const { mid } = seedUserText(editor);

    editor.view.dispatch(editor.state.tr.split(mid));

    expect(editor.state.doc.childCount, "the paragraph really did split").toBe(2);
    // The exact text, not `coverageCounts`: with one entry, maximum coverage is
    // 1 both before and after, so a coverage assertion cannot fail here. This
    // also pins the single-entry choice — a head + tail implementation renders
    // `["TEXT", "USER"]`.
    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["USERTEXT"] });
    expect(gutterAuthors(ydoc, editor)).toEqual(["user", "user"]);
  });

  it("splitListItem keeps the tail attributed", () => {
    // A different step against a different fixture, and #1512 names both.
    const { ydoc, editor } = boundEditor("- alpha\n");
    const at = editor.state.doc.textContent.indexOf("alpha") + 1;
    editor.view.dispatch(editor.state.tr.insertText("USERTEXT", at + 5));

    editor.commands.setTextSelection(at + 9);
    editor.commands.splitListItem("listItem");

    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["USERTEXT"] });
  });

  it("an entry carried whole into the new block keeps its author and its block", () => {
    // The worse half of #1512, and the one whose visible defect is in the
    // gutter: before this change the entry collapsed and the surviving span was
    // the two boundary tokens, which paint no text — but left a `user` bar on
    // the `seed` paragraph the user never authored.
    const { ydoc, editor } = boundEditor("seed\n");
    const { start } = seedUserText(editor);

    editor.view.dispatch(editor.state.tr.split(start));

    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["USERTEXT"] });
    expect(gutterAuthors(ydoc, editor), "no bar on the unauthored first block").toEqual(["user"]);
  });

  it("backspace at the head of a block keeps the joined text attributed", () => {
    // Renders NOTHING before this change — silently, since an anchored entry
    // never falls back to its flat range.
    const { ydoc, editor } = boundEditor("seed\n\nx\n");
    let second = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === "x") second = pos;
      return true;
    });
    editor.view.dispatch(editor.state.tr.insertText("USERTEXT", second + 2));

    editor.commands.setTextSelection(second + 1);
    editor.commands.joinBackward();

    expect(editor.state.doc.childCount, "the blocks really did join").toBe(1);
    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["USERTEXT"] });
  });

  it.each([
    ["heading", (e: Editor) => e.commands.toggleHeading({ level: 2 })],
    ["bullet list", (e: Editor) => e.commands.toggleBulletList()],
    ["blockquote", (e: Editor) => e.commands.toggleBlockquote()],
  ])("wrapping the block in a %s keeps its attribution", (_name, run) => {
    // Three more doors that render nothing today. y-prosemirror rebuilds the
    // `Y.XmlElement` for a node-type change, so both endpoints are orphaned and
    // `relRangeToPmPositions` returns null — which is why the repair cannot
    // decide reuse per endpoint and must mint both.
    const { ydoc, editor } = boundEditor("seed\n");
    seedUserText(editor);

    editor.commands.setTextSelection(3);
    run(editor);

    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["USERTEXT"] });
  });

  it("a multi-block paste keeps the tail and does not absorb the pasted text", () => {
    // Two defects in one door, and the only one whose step is `structure:
    // false`. Before this change: `user = ["USERAABB"]` — the tail lost AND the
    // pasted text painted as the user's own work.
    const { ydoc, editor } = boundEditor("seed\n");
    const { mid } = seedUserText(editor);

    editor.view.dispatch(
      editor.state.tr
        .replace(mid, mid, twoParagraphSlice(editor))
        .setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );

    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({
      claude: ["AABB"],
      user: ["TEXT", "USER"],
    });
    expect(Math.max(...coverageCounts(ydoc, editor)), "no character has two authors").toBe(1);
  });

  it("a split and another author's insertion in one transaction do not double-cover", () => {
    // The misfire a reviewer found. `splitCoveringEntries` declines here — the
    // entry has already collapsed, so its strictly-inside test fails — and a
    // whole-span re-mint would then cover Claude's `CC` as the user's.
    const { ydoc, editor } = boundEditor("seed\n");
    const { start, mid } = seedUserText(editor);

    editor.view.dispatch(
      editor.state.tr
        .insertText("CC", mid)
        .split(start + 6)
        .setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );

    const rendered = decoratedTextByAuthor(ydoc, editor);
    // THE POSITIVE ANCHOR, and it is the whole reason this test can fail.
    // Review found the original version passing with the repair disabled:
    // without it the user entry does not render AT ALL, so `rendered.user` is
    // undefined and every assertion below is satisfied by an empty universe —
    // `claude` is right, nothing contains `CC`, and no character is covered
    // twice because barely anything is covered at all.
    expect(rendered.user?.join(""), "the user's own text must still be attributed").toContain(
      "TEXT",
    );
    expect(rendered.claude).toEqual(["CC"]);
    expect(rendered.user?.join("")).not.toContain("CC");
    expect(Math.max(...coverageCounts(ydoc, editor)), "no character has two authors").toBe(1);
  });

  it("a SAME-author insertion in the same transaction as a split keeps the tail", () => {
    // The sibling of the case above, and the one that was silently broken on
    // master too — measured byte-identical there, so this is a gap the repair
    // closes rather than a regression it introduced.
    //
    // A split destroys the entry's `toRel`, and Yjs resolves the destroyed
    // anchor to the LEFT EDGE of the deletion, which for a mid-run split is
    // exactly where the new text was typed. `coalesceIntoPrevious`'s adjacency
    // test therefore passes on a coincidence, merges into the dead entry, and
    // rewrites its `toRel` to the split boundary — losing everything past it
    // forever, since anchored entries are never reaped. The merge also keeps
    // the candidate's id, which made `reanchorCaptured` skip the very entry it
    // exists to rebuild. Coalescing is now refused outright on a structural
    // transaction.
    const { ydoc, editor } = boundEditor("seed\n");
    const { start, mid } = seedUserText(editor);

    // Same author on both halves — no `AUTHORSHIP_ORIGIN_META`.
    editor.view.dispatch(editor.state.tr.insertText("CC", mid).split(start + 6));

    expect(editor.state.doc.childCount, "the paragraph really did split").toBe(2);
    const rendered = decoratedTextByAuthor(ydoc, editor);
    expect(rendered.user?.join("|"), "the tail past the split must still be attributed").toContain(
      "TEXT",
    );
    // Two entries describing overlapping characters, both `user`. That is the
    // tolerated shape, not a defect: `splitCoveringEntries` cuts only when the
    // authors differ, and the gutter resolves an author PER CHARACTER, so a
    // same-author overlap cannot skew `dominant` (#1513). The assertion that
    // matters is that no character ends up with two DIFFERENT authors.
    expect(new Set(Object.keys(rendered)), "nothing is attributed to claude").toEqual(
      new Set(["user"]),
    );
  });

  it("a repaired sibling never overwrites an id already in the map", () => {
    // Review found no uniqueness guard on the sibling id and could not force a
    // natural collision, so this plants one rather than arguing about
    // reachability. The overwrite is a silent `Y.Map.set` over a live entry
    // covering unrelated text — nothing warns — so the guard is worth having
    // whether or not the natural path is reachable today.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const { start, mid } = seedUserText(editor);
    const base = entries()[0].id;

    // A decoy sitting exactly where the repair wants to mint. Unanchored on
    // purpose: `capturePositions` skips entries without a `relRange`, so it is
    // never captured and can only be destroyed by a blind overwrite.
    const decoy = {
      id: base + "#r1",
      author: "claude" as const,
      range: { from: 0, to: 4 },
      timestamp: 1,
    };
    ydoc.getMap(Y_MAP_AUTHORSHIP).set(decoy.id, decoy);

    // A split plus another author's insertion inside the entry — the shape that
    // makes the repair emit more than one span, and so mint a sibling.
    editor.view.dispatch(
      editor.state.tr
        .insertText("CC", mid)
        .split(start + 6)
        .setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );

    const survivor = entries().find((entry) => entry.id === decoy.id);
    expect(survivor, "the decoy must still be in the map").toBeDefined();
    expect(survivor?.range, "and must not have been overwritten").toEqual({ from: 0, to: 4 });
  });

  it("an entry the change did not touch is left byte-identical", () => {
    // The negative. The entry is in a different block from the split, so the
    // repair must decline — an implementation that re-mints everything it
    // captured passes every test above and fails this one.
    const { editor, entries } = boundEditor("first\n\nsecond\n");
    let second = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === "second") second = pos;
      return true;
    });
    editor.view.dispatch(editor.state.tr.insertText("KEEP", second + 1));
    const before = JSON.stringify(entries()[0]);

    editor.view.dispatch(editor.state.tr.split(3));

    expect(entries()).toHaveLength(1);
    expect(JSON.stringify(entries()[0]), "the untouched entry must not be rewritten").toBe(before);
  });

  it("one entry in the head and another in the tail both survive", () => {
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const at = editor.state.doc.content.size - 1;
    editor.view.dispatch(editor.state.tr.insertText("AAAA", at));
    editor.view.dispatch(
      editor.state.tr.insertText("BBBB", at + 4).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );
    expect(entries()).toHaveLength(2);

    // Split between the two runs.
    editor.view.dispatch(editor.state.tr.split(at + 4));

    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ claude: ["BBBB"], user: ["AAAA"] });
  });

  it("deleting an entry's text outright leaves no repaired ghost", () => {
    // The collapsed-`mapped` guard. Minting from a zero-width mapped range
    // produces an anchor that paints nothing — it resolves INVERTED rather than
    // expanding — but which nothing can ever reap, since the reap skips
    // anchored entries by design (#1480). Asserted on the stored shape, because
    // the render is identical either way.
    const { editor, entries } = boundEditor("seed\n");
    const { start, end } = seedUserText(editor);
    expect(entries()).toHaveLength(1);

    // A structural replace that removes the whole run and the block with it.
    editor.view.dispatch(editor.state.tr.delete(start - 1, end + 1));

    for (const entry of entries()) {
      expect(entry.range.to, "no zero-width entry may be created").toBeGreaterThan(
        entry.range.from,
      );
    }
  });

  it("reuses the endpoint that survived instead of re-minting it", () => {
    // On a midpoint split the entry's `from` is untouched — it resolves to the
    // position the mapping predicts — while `to` is the endpoint the split
    // destroyed. So `fromRel` comes through unchanged and only `toRel` is new.
    //
    // HONEST LABEL: the `fromRel` half of this is a GUARD, not evidence.
    // Mutation-tested — removing the reuse branch and re-minting both endpoints
    // fails nothing here, because a fresh mint at a live offset reproduces the
    // same anchor byte for byte. That was checked at the offset where it is
    // most likely to diverge, immediately after a hardBreak, where
    // `flatOffsetToRelPos` takes its assoc-directed retry: still identical,
    // because the stored anchor came from that same retry.
    //
    // The reuse stays anyway. It is what `splitCoveringEntries` and
    // `coalesceIntoPrevious` both do, for a reason those comments spell out,
    // and it cannot be wrong where the stored anchor was right — whereas a
    // re-mint inherits whatever the retry does in future. The `toRel` half
    // below does discriminate: it fails against a repair that leaves the dead
    // endpoint alone.
    const { editor, entries } = boundEditor("seed\n");
    const { mid } = seedUserText(editor);
    const before = entries()[0].relRange;
    expect(before).toBeDefined();

    editor.view.dispatch(editor.state.tr.split(mid));

    const after = entries()[0].relRange;
    expect(JSON.stringify(after?.fromRel), "the surviving endpoint must be reused").toBe(
      JSON.stringify(before?.fromRel),
    );
    expect(JSON.stringify(after?.toRel), "the destroyed endpoint must be re-minted").not.toBe(
      JSON.stringify(before?.toRel),
    );
  });

  it("a capture does not leak into the next transaction", () => {
    // The capture lives in plugin state, and three of `apply`'s four return
    // paths carry that state forward unchanged — so it has to be set on every
    // path, not just the one that computes it. Otherwise the next keystroke
    // maps a stale capture through a transaction that never saw the split.
    const { editor } = boundEditor("seed\n");
    const { mid } = seedUserText(editor);

    editor.view.dispatch(editor.state.tr.split(mid));
    expect(captureOf(editor), "the structural transaction captures").toBeTruthy();

    editor.view.dispatch(editor.state.tr.insertText("z", 2));
    expect(captureOf(editor), "ordinary typing must clear it").toBeFalsy();
  });

  it("ordinary typing never captures, and a structural change always does", () => {
    // Both halves of the gate. The negative alone is a zero-of-zero: it also
    // passes against a gate that never fires, which would make the whole repair
    // a silent no-op — the exact failure mode of `structure` being an
    // undeclared field that could stop being stored.
    const { editor } = boundEditor("seed\n");
    seedUserText(editor);

    editor.view.dispatch(editor.state.tr.insertText("aa", 2));
    expect(captureOf(editor)).toBeFalsy();

    editor.view.dispatch(editor.state.tr.split(4));
    expect(captureOf(editor)).toBeTruthy();
  });

  it(
    "the cost gate holds at 1,500 entries — typing captures nothing, a split captures all",
    () => {
      // THE COST GATE, at the scale the sibling gate in `authorship-split.test.ts`
      // was measured at. The capture walk is O(entries) and resolves every anchor
      // against the pre-change doc, so running it per keystroke is what would make
      // this unshippable — two reviews measured the ungated containment test on
      // that sibling path at 42-51x slower per keystroke at this entry count.
      //
      // Counted, not timed: a timing assertion at this size flakes on CI, and the
      // count is the quantity that actually costs. Measured here for the record —
      // 1,500 entries, this fixture, happy-dom: ordinary typing 4.6 ms, a split
      // 6.8 ms, so the repair adds ~2.1 ms on a structural keystroke and nothing
      // at all on an ordinary one. The ratio is 1.4x, not the sibling's 42x,
      // because the gate keeps the walk off the common path entirely.
      //
      // Both halves are here for the usual reason: the negative alone also passes
      // against a repair that never fires.
      const { editor, entries } = boundEditor("seed\n");
      for (let i = 0; i < 1500; i++) {
        const at = editor.state.doc.content.size - 1;
        const tr = editor.state.tr.insertText("xxxx", at);
        if (i % 2 === 1) tr.setMeta(AUTHORSHIP_ORIGIN_META, "claude");
        editor.view.dispatch(tr);
      }
      expect(entries().length, "the fixture really is at scale").toBeGreaterThanOrEqual(1500);

      editor.view.dispatch(editor.state.tr.insertText("z", 2));
      expect(captureOf(editor), "typing at scale must still walk nothing").toBeFalsy();

      editor.view.dispatch(editor.state.tr.split(10));
      expect(
        captureOf(editor)?.positions.length,
        "and a split must capture the whole population, not a truncated slice",
      ).toBeGreaterThanOrEqual(1500);
      // 1,500 seeding dispatches through a real ProseMirror view exceed the 5 s
      // default when the whole suite is competing for the machine.
      // The assertion here is a COUNT, not a duration (see the top of this test),
      // so a longer ceiling under instrumentation weakens nothing -- it only stops
      // V8 overhead from being reported as a cost-gate regression.
    },
    timeoutMs(60_000, 300_000),
  );

  it("a remote (y-sync) structural change is never captured", () => {
    // For a remote or MCP change Y is written BEFORE ProseMirror applies, so
    // there is no pre-change frame to capture and the positions would be
    // garbage. Repairing from them would be worse than not repairing.
    const { editor } = boundEditor("seed\n");
    seedUserText(editor);

    editor.view.dispatch(editor.state.tr.split(4).setMeta(ySyncPluginKey, {}));

    expect(captureOf(editor)).toBeFalsy();
  });

  it("an appended doc-changing transaction invalidates the round", () => {
    // `@tiptap/core` appends TEXT-moving steps on every paste that matches a
    // paste rule, and `prosemirror-tables` appends structural ones. Those steps
    // are in the Y.Doc the repair reads but NOT in the root transaction's
    // mapping, so mapping across the gap would place an anchor one frame
    // behind. Fail closed: the entry keeps today's behaviour.
    let appends = 0;
    const Appender = Extension.create({
      name: "testAppender",
      addProseMirrorPlugins() {
        return [
          new Plugin({
            appendTransaction(transactions, _oldState, newState) {
              // Keyed on the STRUCTURAL step specifically. Keying it on
              // "any doc change" instead makes it fire on the seeding
              // transaction and then decline on the split — which still leaves
              // a `Z` in the document, so a naive "the appender fired" guard
              // passes while the round under test had no append at all. That
              // is how this test first passed for the wrong reason.
              if (!transactions.some((tr) => tr.steps.some((step) => isStructural(step)))) {
                return null;
              }
              appends += 1;
              return newState.tr.insertText("Z", 1);
            },
          }),
        ];
      },
    });
    const { editor } = boundEditor("seed\n", [Appender]);
    seedUserText(editor);
    expect(appends, "nothing structural yet").toBe(0);

    editor.view.dispatch(editor.state.tr.split(6));

    expect(appends, "the appender must have fired on THIS round").toBe(1);
    expect(captureOf(editor), "the appended change must invalidate the capture").toBeFalsy();
  });

  it("a table cell attribute change is left alone", () => {
    // A reviewer reported this as a sixth door, reasoning from the step shape.
    // It is `ReplaceAroundStep structure: true` and so passes the gate — but
    // y-prosemirror updates attributes in place when the node type is
    // unchanged, so the anchors survive and the repair must decline. Pinned as
    // a negative so a future widening of the gate cannot quietly start
    // rewriting anchors that were never broken.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    let cellPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (cellPos === -1 && node.type.name === "tableCell") cellPos = pos;
      return true;
    });
    editor.view.dispatch(editor.state.tr.insertText("USERTEXT", cellPos + 2));
    const before = JSON.stringify(entries()[0]);

    const cell = editor.state.doc.nodeAt(cellPos);
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(cellPos, undefined, { ...cell?.attrs, colwidth: [120] }),
    );

    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["USERTEXT"] });
    expect(JSON.stringify(entries()[0]), "a surviving anchor must not be re-minted").toBe(before);
  });
});
