// @vitest-environment happy-dom

/**
 * Undo must restore the STRUCTURE it took away, not just the characters (#1486).
 *
 * The flat projection spells three different things `"\n"`:
 *
 *   a block boundary   — serializes as a blank line
 *   a hard break       — serializes as a trailing `\`
 *   a literal newline  — serializes as a soft wrap
 *
 * Accepting a suggestion across a block boundary MERGES the blocks (the
 * `deleteRange` removes the boundary, which is correct). Undo then had a flat
 * string and no way to tell which of the three to put back, so it guessed —
 * and every guess writes a change to the file the user never made. Before this
 * it guessed "hard break" for every newline, which is right for a suggestion
 * string and wrong for a snapshot.
 *
 * `textSnapshotBreaks` carries the distinction. These tests drive the real hook
 * against a live editor, because the shape under test is what lands in the
 * document — a builder that returns the right JSON while `insertContentAt`
 * flattens it would pass a unit test and fail the user.
 */

import { render } from "@testing-library/svelte";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { useAnnotationReview } from "../../src/client/panels/useAnnotationReview.svelte";
import UseAnnotationReviewHarness from "../../src/client/svelte-harness/UseAnnotationReviewHarness.svelte";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants";
import type { Annotation } from "../../src/shared/types";

/**
 * A live `EditorView` leaves a `DOMObserver` flush pending on a timer. Left
 * undestroyed it fires after happy-dom tears down `document`, and vitest reports
 * `ReferenceError: document is not defined` as an UNHANDLED ERROR against this
 * file — every test green, exit code 1, and a stack naming only
 * `prosemirror-view`. Timing-dependent, so it passes locally and fails in CI.
 */
const live: Editor[] = [];

afterEach(() => {
  while (live.length > 0) live.pop()?.destroy();
});

function acceptedAnnotation(over: Partial<Annotation>): Annotation {
  return {
    id: "a1",
    type: "comment",
    author: "claude",
    status: "accepted",
    content: "why",
    suggestedText: "MERGED",
    timestamp: 0,
    range: { from: 0, to: 6 },
    ...over,
  } as Annotation;
}

function setup(html: string, ann: Annotation) {
  const ydoc = new Y.Doc();
  ydoc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(ann.id, ann);
  const editor = new Editor({ extensions: buildSchemaExtensions(), content: html });
  live.push(editor);
  const declined: Array<{ id: string; reason: string }> = [];
  let api: ReturnType<typeof useAnnotationReview> | undefined;
  render(UseAnnotationReviewHarness, {
    props: {
      params: {
        getYdoc: () => ydoc,
        getEditor: () => editor,
        getAnnotations: () => [ann],
        onActiveAnnotationChange: () => {},
        onUndoFailed: (failed: Annotation, reason: string) =>
          declined.push({ id: failed.id, reason }),
        getScrollBehavior: () => "auto" as ScrollBehavior,
      },
      onReady: (returned: ReturnType<typeof useAnnotationReview>) => (api = returned),
    },
  });
  if (!api) throw new Error("useAnnotationReview did not report ready");
  return { editor, ydoc, declined, review: api };
}

/** Block-level shape, ignoring the attribute noise `getJSON()` carries. */
function shape(editor: Editor): Array<{ type: string; text: string }> {
  return editor.state.doc.content.content.map((node) => ({
    type: node.type.name,
    // `"\n"` for a hardBreak leaf AND for a literal newline, deliberately: this
    // helper reports the same flattening the bug lives in, so the assertions
    // below have to look at `hardBreaks` to tell them apart.
    text: node.textBetween(0, node.content.size, "\n", "\n"),
  }));
}

/** How many hardBreak nodes the document holds, at any depth. */
function hardBreaks(editor: Editor): number {
  let n = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "hardBreak") n++;
  });
  return n;
}

describe("#1486: undo restores block boundaries", () => {
  it("puts back TWO paragraphs when the accept merged two", () => {
    // The document after an accept that spanned the boundary: one paragraph.
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      textSnapshot: "alpha\nbravo",
      textSnapshotBreaks: [{ at: 5, kind: "block" }],
    });
    const { editor, review } = setup("<p>MERGED</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(shape(editor)).toEqual([
      { type: "paragraph", text: "alpha" },
      { type: "paragraph", text: "bravo" },
    ]);
    // The distinguishing assertion. Before the fix this restored ONE paragraph
    // containing a hardBreak — same flat text, different file: a trailing `\`
    // where a blank line belonged.
    expect(hardBreaks(editor), "no hard break stands in for the boundary").toBe(0);
  });

  it("restores a hard break as a hard break, not a paragraph split", () => {
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      textSnapshot: "alpha\nbravo",
      textSnapshotBreaks: [{ at: 5, kind: "hard" }],
    });
    const { editor, review } = setup("<p>MERGED</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(shape(editor)).toEqual([{ type: "paragraph", text: "alpha\nbravo" }]);
    expect(hardBreaks(editor)).toBe(1);
  });

  it("leaves an UNLISTED newline literal — no break node, no split", () => {
    // A markdown soft wrap. Paragraphs are `whitespace: "pre"` since #1448, so
    // the newline lives in the text node and serializes back as a soft wrap.
    // Restoring it as a hard break would add a `\` that was never in the file.
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      textSnapshot: "alpha\nbravo",
    });
    const { editor, review } = setup("<p>MERGED</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(shape(editor)).toEqual([{ type: "paragraph", text: "alpha\nbravo" }]);
    expect(hardBreaks(editor), "a soft wrap must not become a hard break").toBe(0);
  });

  it("handles all three kinds in one snapshot", () => {
    // The case no pairwise test covers: the offsets have to stay correct across
    // a mix, since each block boundary rebases the ones after it.
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      //              0123456789...
      textSnapshot: "one\ntwo\nthree\nfour",
      textSnapshotBreaks: [
        { at: 3, kind: "hard" },
        { at: 7, kind: "block" },
        // index 13 left unlisted ⇒ literal
      ],
    });
    const { editor, review } = setup("<p>MERGED</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(shape(editor)).toEqual([
      { type: "paragraph", text: "one\ntwo" },
      { type: "paragraph", text: "three\nfour" },
    ]);
    expect(hardBreaks(editor)).toBe(1);
  });

  it("ignores recorded structure inside a code block", () => {
    // `codeBlock` declares `code: true` and its content expression does not
    // admit `hardBreak`, so honouring the record would build schema-invalid
    // content. Inside a code block a newline is genuinely a newline.
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      textSnapshot: "alpha\nbravo",
      textSnapshotBreaks: [{ at: 5, kind: "hard" }],
    });
    const { editor, review } = setup("<pre><code>MERGED</code></pre>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(shape(editor)).toEqual([{ type: "codeBlock", text: "alpha\nbravo" }]);
    expect(hardBreaks(editor)).toBe(0);
  });

  it("still undoes a record that predates the field", () => {
    // The compatibility case, and it has to CARRY a newline to mean anything —
    // a snapshot with no newline exercises none of the branch. No
    // `textSnapshotBreaks` at all ⇒ every newline is literal, which is what the
    // code did before the field existed.
    const ann = acceptedAnnotation({ suggestedText: "MERGED", textSnapshot: "plain\ntext" });
    const { editor, review } = setup("<p>MERGED</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(shape(editor)).toEqual([{ type: "paragraph", text: "plain\ntext" }]);
    expect(hardBreaks(editor)).toBe(0);
  });
});

/**
 * Where the restore lands matters as much as what it restores.
 *
 * A block boundary is put back by SPLITTING the receiving textblock, and the
 * fixtures above all use the one geometry where that is trivially right: an
 * annotation covering a whole top-level paragraph. Two other geometries exist
 * and both were broken by the first cut of this fix — one silently worse than
 * the bug it replaced.
 */
describe("#1486: block restore geometry", () => {
  it("merges into the surrounding text instead of orphaning it", () => {
    // The mid-paragraph case: "pre" and "post" are OUTSIDE the annotation.
    // Restoring closed paragraph nodes here split the host into four blocks —
    // `pre`, `alpha`, `bravo`, `post`. The restored ends must join what they
    // land beside, which is what an OPEN slice means.
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      textSnapshot: "alpha\nbravo",
      textSnapshotBreaks: [{ at: 5, kind: "block" }],
      range: { from: 3, to: 9 },
    });
    const { editor, review } = setup("<p>preMERGEDpost</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(shape(editor)).toEqual([
      { type: "paragraph", text: "prealpha" },
      { type: "paragraph", text: "bravopost" },
    ]);
  });

  it("merges a trailing boundary rather than appending an empty block", () => {
    // A snapshot ending ON the boundary — the range reached exactly to the start
    // of the next block. The restore's last block is empty, and must fuse with
    // what follows rather than land as a stray blank paragraph.
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      textSnapshot: "alpha\n",
      textSnapshotBreaks: [{ at: 5, kind: "block" }],
    });
    const { editor, review } = setup("<p>MERGEDpost</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(shape(editor)).toEqual([
      { type: "paragraph", text: "alpha" },
      { type: "paragraph", text: "post" },
    ]);
  });

  it("DECLINES inside a list item rather than rewriting the list", () => {
    // Splitting here yields one list item holding two paragraphs where two list
    // items belong. The recorded `"block"` kind cannot say which of those the
    // gap was, so undo refuses — and refuses permanently, through the same
    // `onUndoFailed` path as a truncated snapshot.
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      textSnapshot: "alpha\nbravo",
      textSnapshotBreaks: [{ at: 5, kind: "block" }],
    });
    const { editor, declined, review } = setup("<ul><li><p>MERGED</p></li></ul>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(false);
    expect(editor.getHTML()).toBe("<ul><li><p>MERGED</p></li></ul>");
    expect(declined).toEqual([{ id: "a1", reason: "block-structure" }]);
  });

  it("DECLINES inside a blockquote — conservative, and known to be", () => {
    // Splitting a paragraph inside a blockquote WOULD be right. The predicate is
    // deliberately narrower than that (see `canRestoreBlockBoundary`), so this
    // pins the cost of the choice rather than blessing it: change the predicate
    // and this test tells you which behaviour you changed.
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      textSnapshot: "alpha\nbravo",
      textSnapshotBreaks: [{ at: 5, kind: "block" }],
    });
    const { editor, declined, review } = setup("<blockquote><p>MERGED</p></blockquote>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(false);
    expect(editor.getHTML()).toBe("<blockquote><p>MERGED</p></blockquote>");
    expect(declined).toEqual([{ id: "a1", reason: "block-structure" }]);
  });

  it("DECLINES an opaque boundary rather than demoting a heading", () => {
    // The case the depth check cannot see. A range may legally run from one
    // block through the next heading's "## " and out the far side, and accepting
    // it merges the two into a heading — depth 1, so `canRestoreBlockBoundary`
    // says yes. But the rebuild only emits paragraphs, so the second block would
    // come back as body text. The server marks such a boundary `"block-opaque"`
    // and this refuses on it.
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      textSnapshot: "alpha\nbravo",
      textSnapshotBreaks: [{ at: 5, kind: "block-opaque" }],
      // Past the heading's "## " prefix, which occupies flat offsets 0-2 and has
      // no position in the editor.
      range: { from: 3, to: 9 },
    });
    const { editor, declined, review } = setup("<h2>MERGED</h2>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(false);
    expect(editor.getHTML()).toBe("<h2>MERGED</h2>");
    expect(declined).toEqual([{ id: "a1", reason: "block-structure" }]);
  });

  it("does not let an opaque boundary fall through to an inline restore", () => {
    // The subtle half: an opaque break contributes no `"block"` entry, so a
    // check placed after `restored.blocks` would miss it entirely and restore a
    // LITERAL newline — which the markdown serializer writes as a setext
    // underline or an `&#xA;` entity. Same doc as the paragraph cases, so the
    // only thing distinguishing this from a successful undo is the kind.
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      textSnapshot: "alpha\nbravo",
      textSnapshotBreaks: [{ at: 5, kind: "block-opaque" }],
    });
    const { editor, review } = setup("<p>MERGED</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(false);
    expect(editor.getHTML()).toBe("<p>MERGED</p>");
  });

  it("ignores a break offset that no longer points at a newline", () => {
    // `textSnapshotBreaks` is never re-anchored while `range` is, so a record
    // can carry offsets that describe text that has moved on. Each recorded
    // position is STEPPED OVER during the rebuild, so honouring a stale one
    // deletes a real character. Degrading to "all literal" is the safe read.
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      textSnapshot: "alpha\nbravo",
      // index 2 is "p", not a newline.
      textSnapshotBreaks: [{ at: 2, kind: "block" }],
    });
    const { editor, declined, review } = setup("<p>MERGED</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    // Every character survives, and no block was invented.
    expect(shape(editor)).toEqual([{ type: "paragraph", text: "alpha\nbravo" }]);
    expect(hardBreaks(editor)).toBe(0);
    expect(declined).toEqual([]);
  });

  it("does NOT decline a hard break inside a list item", () => {
    // The decline is scoped to block boundaries. A hard break needs no split, so
    // a container is no obstacle — without the `restored.blocks` guard on the
    // decline this would refuse an undo it can perform.
    const ann = acceptedAnnotation({
      suggestedText: "MERGED",
      textSnapshot: "alpha\nbravo",
      textSnapshotBreaks: [{ at: 5, kind: "hard" }],
    });
    const { editor, declined, review } = setup("<ul><li><p>MERGED</p></li></ul>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(hardBreaks(editor)).toBe(1);
    expect(declined).toEqual([]);
  });
});
