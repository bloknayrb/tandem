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
import {
  AwarenessExtension,
  awarenessPluginKey,
} from "../../src/client/editor/extensions/awareness";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { extractText } from "../../src/server/mcp/document-model";
import { anchoredRange } from "../../src/server/positions";
import {
  AUTHORSHIP_TOGGLE_KEY,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AUTHORSHIP,
  Y_MAP_AWARENESS,
  Y_MAP_CLAUDE,
} from "../../src/shared/constants";
import { type FlatOffset, toFlatOffset } from "../../src/shared/positions/types";
import { anchorFlatRange } from "../../src/shared/positions/ydoc";

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
      AwarenessExtension.configure({ ydoc }),
    ],
  });
  live.push(editor);
  return { ydoc, editor };
}

/**
 * Flat-offset range of `needle`, in the SERVER's projection.
 *
 * `extractText(ydoc)` is that projection — the same function `validateRange`
 * measures a `textSnapshot` against — so a range built here is the range the
 * server would have stored. Two nearer-looking alternatives are both wrong:
 * `doc.textBetween` omits the `"## "` heading prefix the server counts, and
 * `pmDocFlatText` is the CLIENT's projection, which `src/client/positions.ts`
 * exists precisely because it can diverge. Today's fixtures are plain
 * paragraphs, so all three coincide and every version passed; add a heading to
 * a fixture — the obvious next edit — and only this one keeps the annotation on
 * the text the server thinks it is on.
 */
function rangeOf(doc: Y.Doc, needle: string): { from: FlatOffset; to: FlatOffset } {
  const text = extractText(doc);
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

/**
 * The text each authorship INLINE decoration covers.
 *
 * `buildAuthorshipDecorations` also emits block/gutter decorations, which have
 * no meaningful text, so this filters to the inline spans by their
 * `data-tandem-author` attribute — the same attribute the CSS keys on.
 */
function authorshipDecorationTexts(editor: Editor): string[] {
  const state = authorshipPluginKey.getState(editor.state) as {
    decorations?: { find?: () => Array<{ from: number; to: number; type?: { attrs?: unknown } }> };
  } | null;
  return (state?.decorations?.find?.() ?? [])
    .filter((d) => {
      const attrs = (d.type as { attrs?: Record<string, string> } | undefined)?.attrs;
      return attrs != null && "data-tandem-author" in attrs;
    })
    .map((d) => editor.state.doc.textBetween(d.from, d.to));
}

/**
 * Counts walks of a Y.Map, by wrapping the instance's own `forEach`.
 *
 * The decoration builders' first act is `map.forEach(...)`, so this separates
 * "the branch ran" from "the branch was skipped" without mocking a module — and
 * a result assertion cannot make that separation at all, because a skipped
 * rebuild and an empty rebuild produce the same decorations.
 */
function countWalks(map: Y.Map<unknown>): { walks: () => number; restore: () => void } {
  const original = map.forEach.bind(map);
  let n = 0;
  (map as unknown as { forEach: unknown }).forEach = (fn: Parameters<typeof original>[0]) => {
    n++;
    return original(fn);
  };
  return {
    walks: () => n,
    restore: () => {
      delete (map as unknown as { forEach?: unknown }).forEach;
    },
  };
}

function awarenessDecorationCount(editor: Editor): number {
  const set = awarenessPluginKey.getState(editor.state) as { find?: () => unknown[] } | null;
  return set?.find?.().length ?? 0;
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
    const range = rangeOf(ydoc, "Annotated sentence");
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
    const { from, to } = rangeOf(ydoc, "Annotated sentence");
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
    const range = rangeOf(ydoc, "Stamped sentence");
    ydoc.getMap(Y_MAP_AUTHORSHIP).set("stamp-1", {
      id: "stamp-1",
      author: "claude",
      range,
      timestamp: Date.now(),
    });
    editor.view.dispatch(editor.state.tr.setMeta(authorshipPluginKey, { type: "rebuild" }));
    expect(authorshipDecorationTexts(editor), "precondition: it was painted").toEqual([
      "Stamped sentence",
    ]);

    mcpWriteToSibling(ydoc, " Appended by Claude.");

    // The TEXT, not a count: a count passes with the overlay sitting on the
    // wrong words, which is exactly what a rebuild resolving stale offsets
    // would produce. authorship.ts has no recovery branch at all — it relies
    // entirely on its own Y.Map observer, and MOST MCP writes stamp
    // `Y_MAP_AUTHORSHIP` so the observer covers for them. A delete-only
    // `tandem_edit` does not (its stamp is gated on a non-empty insertion), and
    // neither does `applyChanges` or a watcher reload; those go dark without
    // this branch.
    expect(authorshipDecorationTexts(editor)).toEqual(["Stamped sentence"]);
  });

  it("re-anchors the overlay through a write EARLIER in the document", () => {
    // The authorship mirror of the annotation re-anchoring spec, and the only
    // one of these that can see WHICH document the rebuild resolves against.
    // Every other spec here appends at the END, where positions before the
    // insertion are identical in the old and new docs — so passing
    // `oldState.doc` to `buildAuthorshipDecorations` instead of `newState.doc`
    // is invisible to them, and was measured surviving the whole suite.
    // Prepending shifts everything, and only a rebuild against the post-change
    // doc lands the overlay on the words it belongs to.
    const { ydoc, editor } = boundEditor("First paragraph.\n\nStamped sentence here.\n");
    const { from, to } = rangeOf(ydoc, "Stamped sentence");
    const relRange = anchorFlatRange(ydoc, from, to);
    expect(
      relRange,
      "fixture: the anchors must exist for this spec to mean anything",
    ).not.toBeNull();
    ydoc.getMap(Y_MAP_AUTHORSHIP).set("stamp-1", {
      id: "stamp-1",
      author: "claude",
      range: { from, to },
      relRange,
      timestamp: Date.now(),
    });
    editor.view.dispatch(editor.state.tr.setMeta(authorshipPluginKey, { type: "rebuild" }));
    expect(authorshipDecorationTexts(editor)).toEqual(["Stamped sentence"]);

    const fragment = ydoc.getXmlFragment("default");
    ydoc.transact(() => {
      const first = fragment.get(0) as Y.XmlElement;
      (first.get(0) as Y.XmlText).insert(0, "Claude added this. ");
    }, "mcp-test");

    expect(authorshipDecorationTexts(editor)).toEqual(["Stamped sentence"]);
  });

  it("keeps Claude's presence marker painted through Claude's own write", () => {
    // The third plugin with this defect, and the one where it is most
    // self-defeating: `awareness.ts` paints where Claude is working, and the
    // writes that erased it were Claude's own. It has the same map-only
    // `docChanged` branch and, like `authorship.ts`, no recovery path.
    //
    // Asserted on the decoration COUNT rather than the covered text, because a
    // focus-paragraph marker is a node decoration over a whole block plus a
    // widget cursor — there is no span of characters it "means", so text would
    // assert nothing extra here.
    const { ydoc, editor } = boundEditor("First paragraph.\n\nSecond paragraph.\n");
    ydoc.getMap(Y_MAP_AWARENESS).set(Y_MAP_CLAUDE, {
      status: "editing",
      timestamp: Date.now(),
      active: true,
      focusParagraph: 0,
      focusOffset: null,
    });
    editor.view.dispatch(editor.state.tr.setMeta(awarenessPluginKey, true));
    const painted = awarenessDecorationCount(editor);
    expect(painted, "precondition: the marker was painted").toBeGreaterThan(0);

    mcpWriteToSibling(ydoc, " Appended by Claude.");

    expect(awarenessDecorationCount(editor)).toBe(painted);
  });

  it("does NOT rebuild the overlay on a local, non-y-sync edit", () => {
    // The negative control for the two authorship specs above, and nothing else
    // in the suite has it: dropping `tr.getMeta(ySyncPluginKey)` from the guard
    // — leaving a bare `if (pluginState.visible)` — leaves every other spec
    // green while putting a full O(entries × document) walk on every local
    // keystroke. That is the #610 class of regression, on a path #610 never
    // covered.
    //
    // A mark-only edit is the vehicle, deliberately. A text insertion stamps
    // authorship, which writes the Y.Map, which fires the observer, which
    // dispatches its own rebuild — measured at 2 walks, so a walk counter
    // cannot separate the branch from the observer there. Toggling a mark
    // changes the doc and stamps nothing: measured at 0 walks on this branch's
    // source, and 1 with the meta check removed.
    const { ydoc, editor } = boundEditor("Stamped sentence here.\n\nSecond paragraph.\n");
    const map = ydoc.getMap(Y_MAP_AUTHORSHIP);
    map.set("stamp-1", {
      id: "stamp-1",
      author: "claude",
      range: rangeOf(ydoc, "Stamped sentence"),
      timestamp: Date.now(),
    });
    editor.view.dispatch(editor.state.tr.setMeta(authorshipPluginKey, { type: "rebuild" }));
    expect(authorshipDecorationTexts(editor), "precondition: the overlay is on").toEqual([
      "Stamped sentence",
    ]);

    const counter = countWalks(map);
    try {
      const before = editor.state.doc;
      editor.chain().setTextSelection({ from: 1, to: 8 }).toggleBold().run();
      expect(editor.state.doc, "precondition: the mark step changed the doc").not.toBe(before);
      expect(counter.walks(), "a local edit must map, not rebuild").toBe(0);
    } finally {
      counter.restore();
    }
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
      range: rangeOf(ydoc, "Stamped sentence"),
      timestamp: Date.now(),
    });
    const before = authorshipPluginKey.getState(editor.state) as {
      capture: unknown;
    } | null;
    // The identity assertion below rides on the fall-through return, which is
    // `capture === pluginState.capture ? pluginState : {...pluginState, capture}`
    // — so it holds only while no capture is pending. Pinning that here means a
    // future change that leaves one across a y-sync transaction reds with a
    // message about the precondition rather than looking like the guard broke.
    expect(before?.capture, "precondition: no pending capture").toBeNull();

    mcpWriteToSibling(ydoc, " Appended by Claude.");

    expect(authorshipPluginKey.getState(editor.state)).toBe(before);
    expect(authorshipDecorationCount(editor)).toBe(0);
  });
});
