// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  AnnotationExtension,
  annotationPluginKey,
} from "../../src/client/editor/extensions/annotation";
import {
  AuthorshipExtension,
  authorshipPluginKey,
} from "../../src/client/editor/extensions/authorship";
import { pmDocFlatText } from "../../src/client/positions";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { anchoredRange } from "../../src/server/positions";
import {
  AUTHORSHIP_TOGGLE_KEY,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AUTHORSHIP,
} from "../../src/shared/constants";
import { type FlatOffset, toFlatOffset } from "../../src/shared/positions/types";

/**
 * #1669 — annotation and authorship decorations must survive an MCP content
 * write to an UNRELATED region of the document.
 *
 * WHY A BOUND EDITOR RATHER THAN THE MOCKED HARNESS. The unit specs in
 * `annotation-decoration.test.ts` drive `apply()` with a hand-built transaction,
 * so they assert that the plugin does the right thing GIVEN a y-sync
 * transaction. They cannot see whether a real MCP write produces one, or what
 * the real `DecorationSet.map` does to a real decoration under a real
 * whole-document ReplaceStep — and the defect lives in exactly that gap.
 * y-prosemirror's `_typeChanged` does not patch the PM doc, it replaces it, and
 * `InlineType.map` maps `from` with assoc +1 and `to` with assoc -1, so every
 * inline decoration collapses to `from >= to` and is dropped. Reproducing that
 * needs the real mapping, which means the real editor.
 *
 * WHAT AN MCP WRITE ACTUALLY IS, here. `tandem_edit` mutates the server's Y.Doc
 * and the change reaches this editor through the y-prosemirror binding. Writing
 * to `ydoc.getXmlFragment("default")` outside the binding is the same thing
 * arriving by the same door — the observer fires, `_typeChanged` runs, and the
 * transaction it dispatches carries `ySyncPluginKey`. Deliberately NOT a
 * `setMeta(ySyncPluginKey, {})` on a hand-made transaction: that would be the
 * mocked harness again, wearing a real editor.
 *
 * THE EDIT TARGETS A SIBLING PARAGRAPH. If it overlapped the annotated range
 * the decoration would be legitimately invalidated and the spec would pass on
 * broken code for the wrong reason.
 */

const live: Editor[] = [];

interface Fixture {
  ydoc: Y.Doc;
  editor: Editor;
}

function boundEditor(markdown: string): Fixture {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, markdown);
  const editor = new Editor({
    extensions: [
      ...buildSchemaExtensions(),
      Collaboration.configure({ document: ydoc }),
      AnnotationExtension.configure({ ydoc }),
      AuthorshipExtension.configure({ ydoc }),
    ],
  });
  live.push(editor);
  return { ydoc, editor };
}

/**
 * Flat-offset range of `needle`, in the SERVER's projection.
 *
 * `pmDocFlatText`, never `doc.textBetween`: they are different projections, and
 * `src/client/positions.ts` exists because of the difference — `textBetween`
 * omits the `"## "` heading prefix the server counts, among other divergences.
 * Today's fixtures are plain paragraphs, so the two coincide and a `textBetween`
 * version passed; add a heading to a fixture — the obvious next edit — and the
 * annotation would land on the wrong text while `count > 0` still held.
 */
function rangeOf(editor: Editor, needle: string): { from: FlatOffset; to: FlatOffset } {
  const text = pmDocFlatText(editor.state.doc);
  const at = text.indexOf(needle);
  if (at === -1) throw new Error(`fixture does not contain ${JSON.stringify(needle)}`);
  return { from: toFlatOffset(at), to: toFlatOffset(at + needle.length) };
}

function authorshipDecorationCount(editor: Editor): number {
  const state = authorshipPluginKey.getState(editor.state) as {
    decorations?: { find?: () => unknown[] };
  } | null;
  return state?.decorations?.find?.().length ?? 0;
}

/** Every decoration in the annotation plugin's set, as the text it covers. */
function annotationDecorationTexts(editor: Editor): string[] {
  const set = annotationPluginKey.getState(editor.state) as {
    find?: () => Array<{ from: number; to: number }>;
  } | null;
  return (set?.find?.() ?? []).map((d) => editor.state.doc.textBetween(d.from, d.to));
}

/**
 * An MCP content write to a region that carries no annotation and no stamp.
 *
 * Goes through the Y type rather than the editor, so y-prosemirror's own
 * `_typeChanged` produces the whole-document replacement — the step the bug
 * turns on. `origin` is a non-null stand-in for the server's write origin so
 * the transaction is not treated as the binding's own echo.
 */
function mcpWriteToSibling(ydoc: Y.Doc, text: string): void {
  const fragment = ydoc.getXmlFragment("default");
  ydoc.transact(() => {
    const last = fragment.get(fragment.length - 1) as Y.XmlElement;
    const body = last.get(0) as Y.XmlText;
    body.insert(body.length, text);
  }, "mcp-test");
}

beforeEach(() => {
  localStorage.setItem(AUTHORSHIP_TOGGLE_KEY, "true");
});

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
  localStorage.clear();
});

describe("#1669 decorations survive an MCP content write", () => {
  it("keeps the annotation decoration painted after a sibling-paragraph edit", () => {
    const { ydoc, editor } = boundEditor("Annotated sentence here.\n\nSecond paragraph.\n");
    const range = rangeOf(editor, "Annotated sentence");
    ydoc.getMap(Y_MAP_ANNOTATIONS).set("ann-1", {
      id: "ann-1",
      type: "highlight",
      status: "pending",
      content: "",
      author: "user",
      createdAt: Date.now(),
      range,
    });
    // The Y.Map observer coalesces through requestAnimationFrame, so drive the
    // rebuild the way the plugin's own observer does rather than waiting on a
    // frame: this spec is about what happens to an ALREADY-PAINTED set.
    editor.view.dispatch(editor.state.tr.setMeta(annotationPluginKey, true));
    expect(annotationDecorationTexts(editor), "precondition: it was painted").toEqual([
      "Annotated sentence",
    ]);

    mcpWriteToSibling(ydoc, " Appended by Claude.");

    // No further input, no timer: the decoration must be there on the very
    // transaction that replaced the document. Before the fix this came back
    // empty, and the identity-keyed recovery gate could not fire until two
    // transactions later — which for `tandem_edit` means the user typing twice.
    expect(annotationDecorationTexts(editor)).toEqual(["Annotated sentence"]);
  });

  it("re-anchors a relRange annotation through a write EARLIER in the document", () => {
    // What the rebuild actually buys, and the reason it is strictly better than
    // the mapping it replaces rather than merely equal to it.
    //
    // The two specs above insert at the END, so flat offsets and CRDT anchors
    // agree and a fix that rebuilt from stale flat offsets alone would pass. An
    // insert BEFORE the annotated range separates them: the stored flat offsets
    // now name the wrong characters, and only the `relRange` still names the
    // right ones. `_typeChanged` runs during Yjs transaction cleanup, so the
    // Y.Doc is already updated when `annotationToPmRange` resolves the anchors
    // — which is what makes rebuilding correct here at all.
    //
    // The assertion is on the TEXT under the decoration, not on the count: a
    // count-based version passes with the mark sitting on the wrong words, and
    // "the mark moved to different text" is precisely the failure a flat-only
    // rebuild would produce.
    const { ydoc, editor } = boundEditor("First paragraph.\n\nAnnotated sentence here.\n");
    const { from, to } = rangeOf(editor, "Annotated sentence");
    const anchored = anchoredRange(ydoc, from, to, "Annotated sentence");
    if (!anchored.ok) throw new Error("fixture: anchoredRange rejected the range");
    expect(
      anchored.relRange,
      "fixture: the anchors must exist for this spec to mean anything",
    ).toBeDefined();
    ydoc.getMap(Y_MAP_ANNOTATIONS).set("ann-1", {
      id: "ann-1",
      type: "highlight",
      status: "pending",
      content: "",
      author: "user",
      createdAt: Date.now(),
      range: anchored.range,
      relRange: anchored.relRange,
    });
    editor.view.dispatch(editor.state.tr.setMeta(annotationPluginKey, true));
    expect(annotationDecorationTexts(editor)).toEqual(["Annotated sentence"]);

    // Prepend to the FIRST paragraph — everything after it shifts.
    const fragment = ydoc.getXmlFragment("default");
    ydoc.transact(() => {
      const first = fragment.get(0) as Y.XmlElement;
      (first.get(0) as Y.XmlText).insert(0, "Claude added this. ");
    }, "mcp-test");

    expect(annotationDecorationTexts(editor)).toEqual(["Annotated sentence"]);
  });

  it("keeps the authorship overlay painted after a sibling-paragraph edit", () => {
    const { ydoc, editor } = boundEditor("Stamped sentence here.\n\nSecond paragraph.\n");
    const range = rangeOf(editor, "Stamped sentence");
    ydoc.getMap(Y_MAP_AUTHORSHIP).set("stamp-1", {
      id: "stamp-1",
      author: "claude",
      range,
      createdAt: Date.now(),
    });
    editor.view.dispatch(editor.state.tr.setMeta(authorshipPluginKey, { type: "rebuild" }));
    expect(authorshipDecorationCount(editor), "precondition: it was painted").toBeGreaterThan(0);

    mcpWriteToSibling(ydoc, " Appended by Claude.");

    // authorship.ts has no recovery branch at all — it relies entirely on its
    // own Y.Map observer, and survives today only because every current MCP
    // write also stamps `Y_MAP_AUTHORSHIP`. A content-only write path added
    // later would make the overlay go dark with nothing to notice it.
    expect(authorshipDecorationCount(editor)).toBeGreaterThan(0);
  });

  it("skips the rebuild entirely when the authorship overlay is toggled off", () => {
    // The `visible` gate on the new branch — and the assertion is on plugin
    // state IDENTITY, not on the decoration count, because the count cannot see
    // this guard. `buildAuthorshipDecorations` itself short-circuits on
    // `!visible` and returns the empty set, so deleting `&& pluginState.visible`
    // from the guard leaves the count at 0 and a count-based control passes
    // against the very mutation it exists to kill. (It also passes with the
    // whole branch reverted, which makes it worthless in both directions.)
    //
    // What the guard actually buys is the call not happening. The only
    // observable difference is the return: with the guard, a y-sync transaction
    // falls through to `return pluginState` and the object comes back by
    // identity; without it, a fresh object is constructed every time.
    localStorage.setItem(AUTHORSHIP_TOGGLE_KEY, "false");
    const { ydoc, editor } = boundEditor("Stamped sentence here.\n\nSecond paragraph.\n");
    ydoc.getMap(Y_MAP_AUTHORSHIP).set("stamp-1", {
      id: "stamp-1",
      author: "claude",
      range: rangeOf(editor, "Stamped sentence"),
      createdAt: Date.now(),
    });
    const before = authorshipPluginKey.getState(editor.state);

    mcpWriteToSibling(ydoc, " Appended by Claude.");

    expect(authorshipPluginKey.getState(editor.state)).toBe(before);
    expect(authorshipDecorationCount(editor)).toBe(0);
  });
});
