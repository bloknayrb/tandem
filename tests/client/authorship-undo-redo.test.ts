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
 * Undo/redo attribution — #1471 gap 2 and #1480.
 *
 * WHAT THIS FILE IS FOR. The plan for gap 2 was a stack-item handshake:
 * stash deleted entries on the Yjs UndoManager's stack item, put them back on
 * pop, and write the just-died set onto the counterpart item so the operation
 * self-inverts. That is a substantial mechanism with handlers, teardown
 * ordering hazards, and a re-entrancy story.
 *
 * It may be unnecessary. `createAbsolutePositionFromRelativePosition` resolves
 * through `followRedone`, which chases an item through its redone incarnations,
 * and every call site in this repo uses the 2-arg form that passes
 * `followUndoneDeletions = true`. If a stored anchor therefore resolves BACK
 * after an undo, then simply not deleting collapsed entries produces the
 * correct trace on its own: after an accept the covered entries collapse and
 * (given the resolver fix) paint nothing; after undo they resolve again and
 * paint; after redo they collapse again. No handshake, no revive list, no
 * pop-time write.
 *
 * These tests are that experiment, kept as the executable record of what it
 * settled — a measurement that lives only in a commit message gets re-litigated.
 *
 * They also carry #1480's scenario end to end. Its stated mechanism — that
 * ProseMirror's history plugin does not replay `getMeta()` on redo — describes a
 * plugin the product editor never registers (`StarterKit.configure({ history:
 * false })`, and `Collaboration` binds Mod-z to the Yjs manager). What is real is
 * the symptom, and this is where it gets pinned.
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

/** The real UndoManager the editor is bound to — not a hand-built one. */
function undoManager(editor: Editor): Y.UndoManager {
  const state = yUndoPluginKey.getState(editor.state) as
    | { undoManager?: Y.UndoManager }
    | undefined;
  const manager = state?.undoManager;
  if (!manager) throw new Error("no UndoManager — the Collaboration binding is not live");
  return manager;
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

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
  _resetAuthorshipWarnLatch();
});

describe("the §2.0 gate: does an anchor resolve back after an undo?", () => {
  it("the editor really is bound to a Yjs UndoManager, not ProseMirror history", () => {
    // ANTI-VACUUM, and it also settles #1480's premise. If this throws, every
    // test below is measuring some other editor's undo.
    const { editor } = boundEditor("alpha bravo\n");
    expect(undoManager(editor)).toBeInstanceOf(Y.UndoManager);
  });

  it("a collapsed anchor resolves BACK after undo, and collapses again on redo", () => {
    // THE MEASUREMENT THE WHOLE OF PART 2 TURNS ON. The intuition is that Yjs
    // restores content as new items with new clocks, so a pre-undo anchor is
    // dead afterwards and entries must be re-minted. That intuition is wrong:
    // resolution runs through `followRedone`, which chases an item through its
    // redone incarnations.
    const { ydoc, editor, entries } = boundEditor("alpha bravo charlie\n");

    const at = editor.getText().indexOf("bravo") + 1;
    editor.view.dispatch(
      editor.state.tr.insertText("ZZZZ", at).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );
    const claude = entries().find((entry) => entry.author === "claude") as AuthorshipRange;
    expect(claude?.relRange, "the stamp must be anchored for this to mean anything").toBeDefined();
    expect(decoratedTextByAuthor(ydoc, editor).claude).toEqual(["ZZZZ"]);

    undoManager(editor).undo();
    expect(
      decoratedTextByAuthor(ydoc, editor).claude,
      "after undo the inserted text is gone, so the anchor collapses and paints nothing",
    ).toBeUndefined();

    undoManager(editor).redo();
    expect(
      decoratedTextByAuthor(ydoc, editor).claude,
      "after redo the SAME stored anchor must find the re-inserted text again",
    ).toEqual(["ZZZZ"]);
  });

  it("survives undo and redo twice, without re-minting", () => {
    // Convergence at depth. A mechanism that works once and drifts on the second
    // cycle is worse than none, because the drift is invisible.
    const { ydoc, editor, entries } = boundEditor("alpha bravo charlie\n");

    const at = editor.getText().indexOf("bravo") + 1;
    editor.view.dispatch(
      editor.state.tr.insertText("ZZZZ", at).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );
    const stored = JSON.stringify(
      (entries().find((entry) => entry.author === "claude") as AuthorshipRange).relRange,
    );

    for (let cycle = 0; cycle < 2; cycle++) {
      undoManager(editor).undo();
      expect(decoratedTextByAuthor(ydoc, editor).claude, `cycle ${cycle} undo`).toBeUndefined();
      undoManager(editor).redo();
      expect(decoratedTextByAuthor(ydoc, editor).claude, `cycle ${cycle} redo`).toEqual(["ZZZZ"]);
    }

    // And nothing re-minted it along the way — the SAME anchor did all of that.
    expect(
      JSON.stringify(
        (entries().find((entry) => entry.author === "claude") as AuthorshipRange).relRange,
      ),
      "the stored anchor must be untouched across four pops",
    ).toBe(stored);
  });

  it("#1480: accept then undo then redo attributes the right text at every step", () => {
    // #1480's scenario end to end, and the highest-value case in this area.
    // Shipped behaviour was: undo left a stale `claude` entry painting the
    // user's restored original text AS CLAUDE, and redo attributed the redone
    // text to nobody.
    //
    // Modelled as replace-then-undo-then-redo, which is the accept shape: user
    // text is removed and Claude text put in its place.
    const { ydoc, editor, entries } = boundEditor("the user wrote this\n");

    const from = editor.getText().indexOf("user wrote this") + 1;
    editor.view.dispatch(
      editor.state.tr
        .insertText("CLAUDE WROTE THIS INSTEAD", from, from + "user wrote this".length)
        .setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );
    expect(entries().some((entry) => entry.author === "claude")).toBe(true);
    expect(decoratedTextByAuthor(ydoc, editor).claude).toEqual(["CLAUDE WROTE THIS INSTEAD"]);

    undoManager(editor).undo();
    expect(editor.getText()).toContain("user wrote this");
    expect(
      decoratedTextByAuthor(ydoc, editor).claude,
      "THE #1480 BUG: the restored user text must not be attributed to Claude",
    ).toBeUndefined();

    undoManager(editor).redo();
    expect(
      decoratedTextByAuthor(ydoc, editor).claude,
      "and the redone text must be attributed to Claude again, not to nobody",
    ).toEqual(["CLAUDE WROTE THIS INSTEAD"]);
  });

  it("a whole-paragraph deletion restores its attribution on undo", () => {
    // The harshest case for the claim, because the anchor's PARENT type is
    // deleted rather than merely its content — the state that looks most like
    // "unrecoverable" and would justify the re-mint design if anything did.
    const { ydoc, editor, entries } = boundEditor("first para\n\nsecond para\n");

    const at = editor.getText().indexOf("second") + 1;
    editor.view.dispatch(
      editor.state.tr.insertText("NEW ", at).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );
    expect(decoratedTextByAuthor(ydoc, editor).claude).toEqual(["NEW "]);
    expect(entries().some((entry) => entry.author === "claude")).toBe(true);

    // CLOSE THE STACK ITEM before deleting, and this is load-bearing rather
    // than hygiene. `Y.UndoManager` merges edits within `captureTimeout`
    // (500ms) into ONE item, and a test makes both edits in the same
    // millisecond — so without this the single undo reverts the insertion as
    // well as the deletion, the text comes back WITHOUT the stamped word, and
    // the anchor correctly resolves to null. The assertion below then fails
    // while the code is right: the fixture had quietly merged the two states it
    // exists to keep apart.
    undoManager(editor).stopCapturing();

    // Delete the entire second paragraph, node boundaries included.
    const doc = editor.state.doc;
    const second = doc.child(1);
    const start = doc.content.size - second.nodeSize;
    editor.view.dispatch(editor.state.tr.delete(start, doc.content.size));
    expect(decoratedTextByAuthor(ydoc, editor).claude).toBeUndefined();
    // The premise, and the thing this case actually caught: the entry must
    // still EXIST. It used to be reaped here, and no undo restores a Y.Map
    // entry — so the attribution was gone permanently, which is the whole of
    // #1480's redo symptom and had nothing to do with anchors dying.
    expect(
      entries().some((entry) => entry.author === "claude"),
      "the entry must survive the reap",
    ).toBe(true);

    undoManager(editor).undo();
    expect(
      decoratedTextByAuthor(ydoc, editor).claude,
      "a deleted parent type is recoverable too — followRedone chases it",
    ).toEqual(["NEW "]);
  });
});
