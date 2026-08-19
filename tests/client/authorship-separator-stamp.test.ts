// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it, vi } from "vitest";
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
 * A block boundary is not authored content — #1512's "adjacent, smaller" half.
 *
 * The flat coordinate system charges a block separator one character, so the
 * insertion branch of `onTransaction` used to mint an entry covering a
 * separator and no text. #1512 calls that harmless because coalescing usually
 * swallows it, and usually it does.
 *
 * It is not harmless in two shapes, both pinned below: a split whose author
 * differs from the run it follows has nothing to coalesce into, and a split at
 * the END of a block mints an offset that sits between two `Y.XmlText`s, so the
 * anchor DECLINES and the entry paints through the flat fallback — which this
 * file's own comment calls "a confident decoration on the wrong text".
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

/** Seed a user-authored `USERTEXT`, returning its offsets. */
function seedUserText(editor: Editor) {
  const end = editor.state.doc.content.size - 1;
  editor.view.dispatch(editor.state.tr.insertText("USERTEXT", end));
  const start = editor.state.doc.textContent.indexOf("USERTEXT") + 1;
  return { start, mid: start + 4, end: start + "USERTEXT".length };
}

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
  _resetAuthorshipWarnLatch();
  vi.restoreAllMocks();
});

describe("a block separator is never stamped on its own", () => {
  it("TEST 0 — the binding is real and ordinary typing is still stamped", () => {
    // ANTI-VACUUM, and the anti-over-suppression guard in one. If the content
    // test were inverted, or the binding absent, this fails rather than every
    // case below quietly passing against an empty map.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    expect(ydoc.getXmlFragment("default").length).toBeGreaterThan(0);
    seedUserText(editor);
    expect(entries()).toHaveLength(1);
    expect(entries()[0].relRange, "ordinary typing must still anchor").toBeDefined();
    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["USERTEXT"] });
  });

  it("a differently-authored split mints no entry for the boundary", () => {
    // The shape coalescing cannot absorb: the split is tagged `claude`, the run
    // it lands in is the user's, so before this change the boundary became a
    // `claude` entry of its own — one covering no text, rendering an empty
    // decoration between the two blocks.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const { mid } = seedUserText(editor);

    editor.view.dispatch(editor.state.tr.split(mid).setMeta(AUTHORSHIP_ORIGIN_META, "claude"));

    expect(entries().map((entry) => entry.author)).toEqual(["user"]);
    // `USERTEXT`, not `USER`: the same series that suppressed this stamp also
    // re-anchors the tail a split carries into the new block (#1512), so the
    // run reads whole across the boundary.
    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["USERTEXT"] });
  });

  it("a split at the end of a block mints no unanchored entry, and warns nothing", () => {
    // The shape that is actively wrong today. The separator offset sits between
    // two `Y.XmlText`s, so `flatOffsetToRelPos` declines; the entry is stored
    // with frozen flat offsets and no anchor and paints through the flat
    // fallback. `warnOnce` firing is the tell, so assert on it directly rather
    // than only on the entry set.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { editor, entries } = boundEditor("seed\n");
    const { end } = seedUserText(editor);

    editor.view.dispatch(editor.state.tr.split(end).setMeta(AUTHORSHIP_ORIGIN_META, "claude"));

    expect(entries().filter((entry) => !entry.relRange)).toEqual([]);
    expect(entries().map((entry) => entry.author)).toEqual(["user"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("splitListItem is the same story with a different step", () => {
    // #1512 names Enter and `splitListItem` together, and they are different
    // steps against different fixtures. The end-of-item case is where the
    // declined mint was first measured.
    //
    // The run ending at the split point is `claude`'s and the split itself is
    // the user's, so coalescing has nothing to absorb the separator into. That
    // asymmetry is what makes this case able to fail: with a same-author run it
    // merges away and the test would pass against either implementation.
    const { editor, entries } = boundEditor("- alpha\n");
    const at = editor.state.doc.textContent.indexOf("alpha") + 1;
    editor.view.dispatch(editor.state.tr.insertText("USER", at + 5));
    editor.view.dispatch(
      editor.state.tr.insertText("CL", at + 9).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );
    expect(entries()).toHaveLength(2);

    editor.commands.setTextSelection(at + 11);
    editor.commands.splitListItem("listItem");

    expect(entries().filter((entry) => !entry.relRange)).toEqual([]);
    expect(
      entries()
        .map((entry) => entry.author)
        .sort(),
    ).toEqual(["claude", "user"]);
  });

  it("an inline atom is still stamped, though it renders no text", () => {
    // The carve-out, and the reason the test is not `textBetween(...) === ""`.
    // A hardBreak carries no text but is real authored content; suppressing it
    // would lose attribution for every Shift+Enter and every inserted image.
    const { editor, entries } = boundEditor("seed\n");
    const before = entries().length;

    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.setHardBreak();

    expect(entries().length, "a hardBreak insertion must still be attributed").toBe(before + 1);
  });

  it("typing after a split does not join the run across the boundary", () => {
    // The behaviour change that comes free with the suppression, and the reason
    // it needs pinning rather than mentioning. `lastStampId` is deliberately
    // left ALONE by a transaction that stamps nothing, so after this change the
    // candidate survives a split where the separator stamp used to replace it.
    // Adjacency is what must reject the merge — a block boundary costs two PM
    // positions, so the next character is not adjacent to the previous run.
    const { ydoc, editor, entries } = boundEditor("seed\n");
    const { mid } = seedUserText(editor);

    editor.view.dispatch(editor.state.tr.split(mid));
    const tailStart = editor.state.doc.resolve(editor.state.doc.content.size - 1).start();
    editor.view.dispatch(editor.state.tr.insertText("NEW", tailStart));

    expect(entries().length, "the run must not extend across the block boundary").toBe(2);
    // Two decorations, and the overlap is by design rather than a defect. The
    // repaired entry spans the boundary, so typing at the head of the new block
    // lands INSIDE it; `splitCoveringEntries` cuts a covering entry only when
    // the authors differ, because the gutter resolves an author per character
    // and a same-author overlap cannot skew it (#1513). Both decorations carry
    // `user`, so the render is identical either way.
    expect(decoratedTextByAuthor(ydoc, editor)).toEqual({ user: ["NEW", "USERNEWTEXT"] });
  });
});
