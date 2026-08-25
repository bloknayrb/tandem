// @vitest-environment happy-dom

/**
 * A truncated `textSnapshot` must not be restored over the full text (#1486).
 *
 * `captureSnapshot` caps the snapshot at 200 characters, for a real reason: it
 * bounds annotation record size against pathological ranges (#1000 review R2).
 * Undo then restored that string VERBATIM — so undoing an accepted suggestion
 * over a longer range deleted everything past the cap, and the old marker (a
 * trailing "...") was written into the document as three literal characters.
 *
 * Undo now declines. Refusing is recoverable; silently truncating the user's
 * document is not.
 *
 * THREE HOPS have to agree for that to work, and the middle one is invisible
 * from either end: capture sets the flag, `sanitizeAnnotation`'s strict
 * allowlist has to carry it, and undo reads it off the SANITIZED record. Miss
 * the allowlist and the guard reads `undefined`, concludes the snapshot is
 * whole, and performs the exact corruption it was added to prevent — with the
 * fix apparently in place. Each hop is pinned separately below.
 */

import { render } from "@testing-library/svelte";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { useAnnotationReview } from "../../src/client/panels/useAnnotationReview.svelte";
import UseAnnotationReviewHarness from "../../src/client/svelte-harness/UseAnnotationReviewHarness.svelte";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants";
import { sanitizeAnnotation } from "../../src/shared/sanitize";
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
    text: "why",
    content: "why",
    suggestedText: "SHORT",
    createdAt: 0,
    timestamp: 0,
    range: { from: 0, to: 5 },
    ...over,
  } as unknown as Annotation;
}

function setup(html: string, ann: Annotation) {
  const ydoc = new Y.Doc();
  const map = ydoc.getMap<Annotation>(Y_MAP_ANNOTATIONS);
  map.set(ann.id, ann);
  const editor = new Editor({ extensions: buildSchemaExtensions(), content: html });
  live.push(editor);
  const undoFailures: string[] = [];
  let api: ReturnType<typeof useAnnotationReview> | undefined;
  render(UseAnnotationReviewHarness, {
    props: {
      params: {
        getYdoc: () => ydoc,
        getEditor: () => editor,
        getAnnotations: () => [ann],
        onActiveAnnotationChange: () => {},
        getScrollBehavior: () => "auto" as ScrollBehavior,
        onUndoFailed: (failed: Annotation) => undoFailures.push(failed.id),
      },
      onReady: (returned: ReturnType<typeof useAnnotationReview>) => (api = returned),
    },
  });
  if (!api) throw new Error("useAnnotationReview did not report ready");
  return {
    editor,
    review: api,
    undoFailures,
    statusOf: (id: string) => map.get(id)?.status,
  };
}

describe("#1486: undo declines a truncated snapshot", () => {
  it("leaves the document alone rather than restoring a prefix", () => {
    // The corruption. `textSnapshot` holds the first 200 characters of what was
    // there; restoring it would delete the rest.
    const ann = acceptedAnnotation({
      suggestedText: "SHORT",
      textSnapshot: "x".repeat(200),
      textSnapshotTruncated: true,
    });
    const { editor, review, statusOf, undoFailures } = setup("<p>SHORT</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(false);
    expect(editor.state.doc.textContent, "document untouched").toBe("SHORT");
    // The annotation must NOT fall back to "pending". The document still holds
    // the suggested text, so a pending annotation would invite a second accept
    // and describe a state that is not the one on screen.
    expect(statusOf("a1"), "still accepted").toBe("accepted");
    // And the refusal is reported. Unlike the range-stale declines beside it
    // this one never resolves on a retry, so a `console.warn` the user cannot
    // see would leave a permanently dead Undo button with no explanation.
    expect(undoFailures).toEqual(["a1"]);
  });

  it("declines a LEGACY truncated record, which carries no flag at all", () => {
    // Written before `textSnapshotTruncated` existed and marked only by the old
    // trailing ellipsis. These are on disk in every existing install, so a fix
    // that reads the flag alone protects annotations nobody has made yet and
    // none of the ones already at risk.
    const ann = acceptedAnnotation({
      suggestedText: "SHORT",
      textSnapshot: `${"x".repeat(197)}...`,
    });
    const { editor, review, undoFailures } = setup("<p>SHORT</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(false);
    expect(editor.state.doc.textContent).toBe("SHORT");
    expect(undoFailures).toEqual(["a1"]);
  });

  it("still undoes a SHORT snapshot that happens to end in an ellipsis", () => {
    // The legacy sniff tests length AND the ellipsis. Testing the ellipsis
    // alone would refuse undo on every sentence that trails off — ordinary
    // prose, not a truncation.
    const ann = acceptedAnnotation({
      suggestedText: "SHORT",
      textSnapshot: "he hesitated...",
    });
    const { editor, review, undoFailures } = setup("<p>SHORT</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(editor.state.doc.textContent).toBe("he hesitated...");
    expect(undoFailures).toEqual([]);
  });

  it("still undoes normally when the snapshot is complete", () => {
    // The positive control. Without it, a guard that refused EVERY undo would
    // pass the test above and look like a fix.
    const ann = acceptedAnnotation({
      suggestedText: "SHORT",
      textSnapshot: "original text",
    });
    const { editor, review } = setup("<p>SHORT</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(editor.state.doc.textContent).toBe("original text");
  });

  it("undoes when the flag is present but false", () => {
    // `textSnapshotTruncated: false` is a complete snapshot, not a truncated
    // one — the guard tests for `true`, not for presence.
    const ann = acceptedAnnotation({
      suggestedText: "SHORT",
      textSnapshot: "original text",
      textSnapshotTruncated: false,
    });
    const { editor, review } = setup("<p>SHORT</p>", ann);

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(editor.state.doc.textContent).toBe("original text");
  });
});

describe("#1486: the flag survives sanitize", () => {
  it("is carried through the allowlist", () => {
    // The invisible hop. `sanitizeAnnotation` is a strict allowlist and every
    // read routes through it, so an unlisted field is silently dropped and the
    // guard above never fires — with the guard, the schema and the capture site
    // all correct. Pinned on its own because no end-to-end test of undo can
    // tell "flag absent" from "flag stripped".
    const sanitized = sanitizeAnnotation(
      acceptedAnnotation({ textSnapshot: "x".repeat(200), textSnapshotTruncated: true }),
      () => {},
    );
    expect(sanitized.textSnapshotTruncated).toBe(true);
  });

  it("stays absent when it was never set", () => {
    const sanitized = sanitizeAnnotation(acceptedAnnotation({ textSnapshot: "short" }), () => {});
    expect(sanitized.textSnapshotTruncated).toBeUndefined();
  });
});
