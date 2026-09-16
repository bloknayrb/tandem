// @vitest-environment happy-dom

/**
 * Accepting the replacement a REPLY proposes (#1626).
 *
 * `resolveAnnotation` reads `suggestedText` off the stored annotation record, so
 * a reply's proposal — which lives on the reply, over the parent's range — could
 * not reuse it without a parameter. The answer is one extracted ladder
 * (`applyAcceptedSuggestion`) that both entry points route through, and these
 * cases pin each rung SEPARATELY, because a re-implementation that drops one
 * still writes the right text in the happy path:
 *
 *   - the `snapshotContradicts` drift guard (#1629),
 *   - the pending gate, which is what stops a double accept inserting twice,
 *   - the missing-editor arm, which must NOT publish `accepted` (#1826),
 *   - the `recentlyResolved` postamble, which is what surfaces Undo,
 *   - and the parent's stored `suggestedText` ending up as what was APPLIED,
 *     without which `undoResolveAnnotation` declines "text changed" on every
 *     reply accept.
 *
 * Driven through the real hook with a LIVE Tiptap editor, for the reason
 * `suggestion-accept-drift-guard.test.ts` gives: the hook's own older suite
 * mocks the editor wholesale and cannot observe the document.
 *
 * FIXTURE NOTE: every proposal here is exactly as long as the target text.
 * These records are hand-built and carry no `relRange`, so `annotationToPmRange`
 * falls back to the stored flat offsets — which in production follow the edit
 * through the CRDT anchor and here do not. A longer replacement would leave undo
 * reading a truncated span and declining, which is a property of the fixture and
 * not of the code under test. Equal lengths take that variable off the table.
 */

import { render } from "@testing-library/svelte";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import type {
  UseAnnotationReviewParams,
  UseAnnotationReviewReturn,
} from "../../src/client/panels/useAnnotationReview.svelte";
import UseAnnotationReviewHarness from "../../src/client/svelte-harness/UseAnnotationReviewHarness.svelte";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants";
import type { Annotation, AnnotationReply } from "../../src/shared/types";

const PARENT_ID = "ann-1";
const REPLY_ID = "rpl-1";
/** All three are 11 characters — see the fixture note above. */
const ORIGINAL = "hello world";
const PARENT_PROPOSAL = "first offer";
const REPLY_PROPOSAL = "goodbye all";

function mountReview(params: UseAnnotationReviewParams): UseAnnotationReviewReturn {
  let api: UseAnnotationReviewReturn | undefined;
  render(UseAnnotationReviewHarness, {
    props: { params, onReady: (returned: UseAnnotationReviewReturn) => (api = returned) },
  });
  if (!api) throw new Error("useAnnotationReview did not report ready");
  return api;
}

/** Plain text of the whole document, in the projection the guards use. */
function docText(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", "\n");
}

describe("#1626: accepting a reply's suggestion", () => {
  let ydoc: Y.Doc;
  let editor: Editor;
  let annotations: Y.Map<unknown>;
  let replies: Y.Map<unknown>;
  const onApplyFailed = vi.fn();

  function seed(replyExtras: Partial<AnnotationReply> = {}) {
    annotations.set(PARENT_ID, {
      id: PARENT_ID,
      type: "comment",
      author: "claude",
      status: "pending",
      content: "why",
      suggestedText: PARENT_PROPOSAL,
      textSnapshot: ORIGINAL,
      timestamp: 0,
      range: { from: 0, to: ORIGINAL.length },
    } as Annotation);
    replies.set(REPLY_ID, {
      id: REPLY_ID,
      annotationId: PARENT_ID,
      author: "claude",
      text: "on reflection, this reads better",
      timestamp: 1,
      suggestedText: REPLY_PROPOSAL,
      ...replyExtras,
    } satisfies AnnotationReply);
  }

  function review(getEditor: () => Editor | null = () => editor): UseAnnotationReviewReturn {
    return mountReview({
      getYdoc: () => ydoc,
      getEditor,
      getAnnotations: () => [annotations.get(PARENT_ID) as Annotation],
      onActiveAnnotationChange: () => {},
      getScrollBehavior: () => "auto" as ScrollBehavior,
      onApplyFailed,
    });
  }

  beforeEach(() => {
    onApplyFailed.mockClear();
    ydoc = new Y.Doc();
    annotations = ydoc.getMap(Y_MAP_ANNOTATIONS);
    replies = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    editor = new Editor({ extensions: buildSchemaExtensions(), content: `<p>${ORIGINAL}</p>` });
  });
  afterEach(() => {
    editor.destroy();
    ydoc.destroy();
  });

  it("writes the REPLY's text into the document and resolves the parent", () => {
    seed();
    review().acceptReplySuggestion(PARENT_ID, REPLY_ID);

    // The reply's proposal, not the parent's — the whole point of #1626.
    expect(docText(editor)).toBe(REPLY_PROPOSAL);
    expect((annotations.get(PARENT_ID) as Annotation).status).toBe("accepted");
  });

  it("stores the applied text on the parent, so undo can still recognise it", () => {
    // `undoResolveAnnotation` compares the span against
    // `appliedProjection(... ann.suggestedText ...)`. If the parent kept its own
    // original proposal, every reply accept would decline "text changed" — so
    // superseding the field is required, not a side effect. Recorded as a
    // decision: the original proposal is not archived.
    seed();
    const api = review();
    api.acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect((annotations.get(PARENT_ID) as Annotation).suggestedText).toBe(REPLY_PROPOSAL);
    expect(api.undoResolveAnnotation(PARENT_ID)).toBe(true);
    expect(docText(editor)).toBe(ORIGINAL);
  });

  it("declines, leaving the document untouched, when the target text changed (#1629)", () => {
    seed();
    editor.commands.setContent("<p>totally other</p>");
    const before = docText(editor);

    review().acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect(docText(editor)).toBe(before);
    expect((annotations.get(PARENT_ID) as Annotation).status).toBe("pending");
    expect(onApplyFailed).toHaveBeenCalledWith(expect.anything(), "range");
  });

  it("is a no-op on a second accept — the text is present exactly once", () => {
    // The pending gate. Without it `applySuggestion` runs twice; the second run
    // resolves the same offsets against already-replaced text.
    seed();
    const api = review();
    api.acceptReplySuggestion(PARENT_ID, REPLY_ID);
    api.acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect(docText(editor)).toBe(REPLY_PROPOSAL);
  });

  it("leaves the record pending and reports no-editor when the editor is absent (#1826)", () => {
    // A null editor is a FAILED apply, not a licence to publish `accepted` —
    // source view unmounts Tiptap while the rail stays mounted by design.
    seed();
    review(() => null).acceptReplySuggestion(PARENT_ID, REPLY_ID);

    const parent = annotations.get(PARENT_ID) as Annotation;
    expect(parent.status).toBe("pending");
    // …and the FAILED path must not leave the reply's text on the parent as
    // though it had been chosen.
    expect(parent.suggestedText).toBe(PARENT_PROPOSAL);
    expect(docText(editor)).toBe(ORIGINAL);
    expect(onApplyFailed).toHaveBeenCalledWith(expect.anything(), "no-editor");
  });

  it("puts the parent in recentlyResolved, which is what surfaces Undo", () => {
    seed();
    const api = review();
    api.acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect(api.getRecentlyResolved().has(PARENT_ID)).toBe(true);
  });

  it("ignores a reply that carries no suggestion, or that names another parent", () => {
    // Both ids come from the card's own props, but the reply map is CRDT state
    // any connected client can write.
    seed({ suggestedText: undefined });
    const api = review();
    api.acceptReplySuggestion(PARENT_ID, REPLY_ID);
    expect(docText(editor)).toBe(ORIGINAL);

    replies.set(REPLY_ID, {
      id: REPLY_ID,
      annotationId: "some-other-annotation",
      author: "claude",
      text: "x",
      timestamp: 1,
      suggestedText: "should not!",
    } satisfies AnnotationReply);
    api.acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect(docText(editor)).toBe(ORIGINAL);
    expect((annotations.get(PARENT_ID) as Annotation).status).toBe("pending");
  });
});
