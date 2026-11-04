// @vitest-environment happy-dom

/**
 * #2360 PR 3: Accept on Claude's reply rewrite, on a USER card.
 *
 * A user's own comment never carries an Accept of its own (`canAccept` is
 * `author !== "user"`), but once Claude answers inside the comment's thread
 * with a rewrite, that rewrite gets "Accept replacement". Accepting applies it
 * over the parent's range and closes the comment; Undo puts back both the
 * document text and the record (#2360 problem b: the parent's `suggestedText`
 * used to keep Claude's text after Undo).
 *
 * THE SNAPSHOT RULE. A browser-made user comment carries no `textSnapshot`
 * (`Toolbar.svelte`'s `createAnnotation` writes a flat range only). Without one
 * the accept cannot check its target and undo cannot restore it, so a rewrite
 * over a snapshot-less user parent is refused: Accept renders disabled with its
 * own reason. The probe below is the evidence for the accept half; the undo
 * half is the `typeof oldText === "string"` branch in `undoResolveAnnotation`.
 *
 * Live Tiptap editor for the hook cases, for the reason
 * `suggestion-accept-drift-guard.test.ts` gives. Parents are hand-built with no
 * `relRange`, so ranges resolve through the flat fallback and every proposal
 * is the same length as its target (see `reply-suggestion-accept.test.ts`'s
 * fixture note).
 */

import { within } from "@testing-library/dom";
import { cleanup, render } from "@testing-library/svelte";
import { Editor } from "@tiptap/core";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { canAcceptReplySuggestion } from "../../src/client/panels/annotation-context-menu";
import CommentThread from "../../src/client/panels/CommentThread.svelte";
import MarginColumn from "../../src/client/panels/MarginColumn.svelte";
import SidePanel from "../../src/client/panels/SidePanel.svelte";
import type {
  UseAnnotationReviewParams,
  UseAnnotationReviewReturn,
} from "../../src/client/panels/useAnnotationReview.svelte";
import UseAnnotationReviewHarness from "../../src/client/svelte-harness/UseAnnotationReviewHarness.svelte";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants";
import type { Annotation, AnnotationReply } from "../../src/shared/types";

const PARENT_ID = "ann-user";
const REPLY_ID = "rpl-claude";

/** "world" in "hello world" — flat 6..11. */
function userComment(extras: Record<string, unknown> = {}): Annotation {
  return {
    id: PARENT_ID,
    author: "user",
    type: "comment",
    audience: "outbound",
    range: { from: 6, to: 11 },
    content: "can this be better?",
    status: "pending",
    timestamp: 0,
    ...extras,
  } as Annotation;
}

function claudeRewrite(extras: Partial<AnnotationReply> = {}): AnnotationReply {
  return {
    id: REPLY_ID,
    annotationId: PARENT_ID,
    author: "claude",
    text: "try this",
    timestamp: 1,
    suggestedText: "earth",
    ...extras,
  };
}

function mountReview(params: UseAnnotationReviewParams): UseAnnotationReviewReturn {
  let api: UseAnnotationReviewReturn | undefined;
  render(UseAnnotationReviewHarness, {
    props: { params, onReady: (returned: UseAnnotationReviewReturn) => (api = returned) },
  });
  if (!api) throw new Error("useAnnotationReview did not report ready");
  return api;
}

function docText(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", "\n");
}

// `discloseUnfold` drives `element.animate()`, which happy-dom lacks.
beforeEach(() => {
  (Element.prototype as unknown as { animate: () => unknown }).animate = () => ({
    cancel() {},
    currentTime: 0,
    playState: "finished",
    effect: null,
    onfinish: null,
  });
});
afterEach(() => cleanup());

describe("the hook: accepting a Claude rewrite over a user parent", () => {
  let ydoc: Y.Doc;
  let editor: Editor;
  let annotations: Y.Map<unknown>;
  let replies: Y.Map<unknown>;
  const onApplyFailed = vi.fn();

  beforeEach(() => {
    onApplyFailed.mockClear();
    ydoc = new Y.Doc();
    annotations = ydoc.getMap(Y_MAP_ANNOTATIONS);
    replies = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    editor = new Editor({ extensions: buildSchemaExtensions(), content: "<p>hello world</p>" });
  });
  afterEach(() => {
    editor.destroy();
    ydoc.destroy();
  });

  function review(): UseAnnotationReviewReturn {
    return mountReview({
      getYdoc: () => ydoc,
      getEditor: () => editor,
      getAnnotations: () => [annotations.get(PARENT_ID) as Annotation],
      onActiveAnnotationChange: () => {},
      getScrollBehavior: () => "auto" as ScrollBehavior,
      onApplyFailed,
    });
  }

  const parent = () => annotations.get(PARENT_ID) as Annotation;

  it("PROBE: a snapshot-less, flat-only user parent is refused after an edit shifts its range", () => {
    // Exactly the shape `Toolbar.svelte` writes. On master this produced
    // "oh, heearthorld": the unverified arm applied at stale flat offsets.
    annotations.set(PARENT_ID, userComment());
    replies.set(REPLY_ID, claudeRewrite());
    editor.commands.insertContentAt(1, "oh, ");

    review().acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect(docText(editor)).toBe("oh, hello world");
    expect(parent().status).toBe("pending");
    expect(onApplyFailed).toHaveBeenCalledWith(expect.anything(), "range");
  });

  it("refuses a snapshot-less user parent even when nothing moved — undo could not restore it", () => {
    annotations.set(PARENT_ID, userComment());
    replies.set(REPLY_ID, claudeRewrite());

    review().acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect(docText(editor)).toBe("hello world");
    expect(parent().status).toBe("pending");
    expect(parent().suggestedText).toBeUndefined();
    expect(onApplyFailed).toHaveBeenCalledWith(expect.anything(), "range");
  });

  it("applies over a snapshot-bearing user parent and records which reply it took", () => {
    annotations.set(PARENT_ID, userComment({ textSnapshot: "world" }));
    replies.set(REPLY_ID, claudeRewrite());

    review().acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect(docText(editor)).toBe("hello earth");
    const p = parent();
    expect(p.status).toBe("accepted");
    expect(p.suggestedText).toBe("earth");
    expect(p.acceptedReplyId).toBe(REPLY_ID);
    // `null` is the marker for "the parent had no suggestion of its own".
    expect(p.priorSuggestedText).toBeNull();
  });

  it("Undo restores the document AND the user's record — no suggestedText, no provenance", () => {
    annotations.set(PARENT_ID, userComment({ textSnapshot: "world" }));
    replies.set(REPLY_ID, claudeRewrite());
    const api = review();
    api.acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect(api.undoResolveAnnotation(PARENT_ID)).toBe(true);

    expect(docText(editor)).toBe("hello world");
    const p = parent();
    expect(p.status).toBe("pending");
    expect("suggestedText" in p).toBe(false);
    expect("acceptedReplyId" in p).toBe(false);
    expect("priorSuggestedText" in p).toBe(false);
  });

  it("ignores a USER-authored reply that carries suggestedText", () => {
    annotations.set(PARENT_ID, userComment({ textSnapshot: "world" }));
    replies.set(REPLY_ID, claudeRewrite({ author: "user" }));

    review().acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect(docText(editor)).toBe("hello world");
    expect(parent().status).toBe("pending");
    // A predicate refusal is silent, unlike a target refusal.
    expect(onApplyFailed).not.toHaveBeenCalled();
  });

  it("ignores a rewrite on a PRIVATE comment (ADR-027: never Claude-facing)", () => {
    annotations.set(PARENT_ID, userComment({ textSnapshot: "world", audience: "private" }));
    replies.set(REPLY_ID, claudeRewrite());

    review().acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect(docText(editor)).toBe("hello world");
    expect(parent().status).toBe("pending");
    expect(onApplyFailed).not.toHaveBeenCalled();
  });

  it.each([
    ["a note", { type: "note" }, {}],
    ["a highlight", { type: "highlight" }, {}],
    ["a private reply", {}, { private: true }],
  ])("ignores a rewrite on %s", (_label, parentExtras, replyExtras) => {
    annotations.set(PARENT_ID, userComment({ textSnapshot: "world", ...parentExtras }));
    replies.set(REPLY_ID, claudeRewrite(replyExtras));

    review().acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect(docText(editor)).toBe("hello world");
    expect(onApplyFailed).not.toHaveBeenCalled();
  });

  it("refuses a user parent whose snapshot is truncated — Undo could never restore it", () => {
    annotations.set(PARENT_ID, userComment({ textSnapshot: "world", textSnapshotTruncated: true }));
    replies.set(REPLY_ID, claudeRewrite());

    review().acceptReplySuggestion(PARENT_ID, REPLY_ID);

    expect(docText(editor)).toBe("hello world");
    expect(onApplyFailed).toHaveBeenCalledWith(expect.anything(), "range");
  });

  it("reports a snapshot-bearing user card lost only once its text changes", async () => {
    annotations.set(PARENT_ID, userComment({ textSnapshot: "world" }));
    replies.set(REPLY_ID, claudeRewrite());
    const api = review();
    await tick();
    expect(api.isTargetLost(PARENT_ID)).toBe(false);

    editor.commands.insertContentAt({ from: 7, to: 12 }, "there");
    await vi.waitFor(() => expect(api.isTargetLost(PARENT_ID)).toBe(true));
  });

  it("reports a snapshot-less user card with a Claude rewrite as blocked", async () => {
    annotations.set(PARENT_ID, userComment());
    replies.set(REPLY_ID, claudeRewrite());
    const api = review();
    await tick();
    expect(api.isTargetLost(PARENT_ID)).toBe(true);
  });

  it("does not scan a user card whose only proposal is the user's own", async () => {
    annotations.set(PARENT_ID, userComment());
    replies.set(REPLY_ID, claudeRewrite({ author: "user" }));
    const api = review();
    await tick();
    expect(api.isTargetLost(PARENT_ID)).toBe(false);
  });
});

describe("canAcceptReplySuggestion", () => {
  it("accepts a Claude rewrite on a pending, Claude-facing comment of either author", () => {
    expect(canAcceptReplySuggestion(userComment(), claudeRewrite())).toBe(true);
    expect(canAcceptReplySuggestion(userComment({ author: "claude" }), claudeRewrite())).toBe(true);
  });

  it.each([
    ["resolved parent", userComment({ status: "accepted" }), claudeRewrite()],
    ["private comment", userComment({ audience: "private" }), claudeRewrite()],
    ["absent audience is not consent", userComment({ audience: undefined }), claudeRewrite()],
    ["note", userComment({ type: "note" }), claudeRewrite()],
    ["highlight", userComment({ type: "highlight" }), claudeRewrite()],
    ["user-authored reply", userComment(), claudeRewrite({ author: "user" })],
    ["import-authored reply", userComment(), claudeRewrite({ author: "import" })],
    ["private reply", userComment(), claudeRewrite({ private: true })],
    [
      "truthy non-boolean private",
      userComment(),
      claudeRewrite({ private: "true" as unknown as boolean }),
    ],
    ["reply of another parent", userComment(), claudeRewrite({ annotationId: "other" })],
    ["no proposal", userComment(), claudeRewrite({ suggestedText: undefined })],
  ])("refuses: %s", (_label, p, r) => {
    expect(canAcceptReplySuggestion(p, r)).toBe(false);
  });
});

describe("CommentThread: the Accept button is gated per reply", () => {
  it("shows Accept on Claude's rewrite and none on a user reply with suggestedText", () => {
    const { container } = render(CommentThread, {
      props: {
        replies: [
          claudeRewrite(),
          claudeRewrite({ id: "rpl-user", author: "user", suggestedText: "mine!", timestamp: 2 }),
        ],
        annotation: userComment({ textSnapshot: "world" }),
        isPending: true,
        onAcceptReplySuggestion: vi.fn(),
      },
    });
    // Positive control beside the absence check.
    expect(within(container).getByTestId(`accept-reply-btn-${REPLY_ID}`)).toBeTruthy();
    expect(container.querySelector("[data-testid='reply-suggestion-rpl-user']")).toBeTruthy();
    expect(container.querySelector("[data-testid='accept-reply-btn-rpl-user']")).toBeNull();
  });

  it("blocks a snapshot-less user card from the record alone, with its own reason", () => {
    // `targetLost` false: the scan gives no verdict without an editor, and the
    // button must not go live there.
    const onAcceptReplySuggestion = vi.fn();
    const { container } = render(CommentThread, {
      props: {
        replies: [claudeRewrite()],
        annotation: userComment(),
        isPending: true,
        onAcceptReplySuggestion,
        targetLost: false,
      },
    });
    const btn = within(container).getByTestId(`accept-reply-btn-${REPLY_ID}`) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const describedBy = btn.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reason = container.querySelector(`[id="${describedBy}"]`)?.textContent ?? "";
    expect(reason).toMatch(/can't confirm/);
    expect(reason).not.toMatch(/has changed/);
    btn.click();
    expect(onAcceptReplySuggestion).not.toHaveBeenCalled();
  });
});

describe("the panels wire Accept onto a user card", () => {
  function reviewStub(acceptReplySuggestion = vi.fn()): UseAnnotationReviewReturn {
    return {
      resolveAnnotation: vi.fn(),
      acceptReplySuggestion,
      undoResolveAnnotation: vi.fn(() => false),
      handleAccept: vi.fn(),
      handleDismiss: vi.fn(),
      scrollToAnnotation: vi.fn(),
      getRecentlyResolved: () => new Set<string>(),
      getReviewIndex: () => 0,
      getReviewTargets: () => [],
      isTargetLost: () => false,
    };
  }

  it("SidePanel", async () => {
    const ydoc = new Y.Doc();
    ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set(REPLY_ID, claudeRewrite());
    const acceptReplySuggestion = vi.fn();
    const { container } = render(SidePanel, {
      props: {
        annotations: [userComment({ textSnapshot: "world" })],
        editor: null,
        ydoc,
        documentId: "doc-a",
        activeAnnotationId: null,
        reduceMotion: true,
        onActiveAnnotationChange: vi.fn(),
        review: reviewStub(acceptReplySuggestion),
      },
    });
    await tick();
    const btn = await vi.waitFor(() =>
      within(container).getByTestId(`accept-reply-btn-${REPLY_ID}`),
    );
    btn.click();
    expect(acceptReplySuggestion).toHaveBeenCalledWith(PARENT_ID, REPLY_ID);
    // The user card's OWN Accept stays absent: only the reply rewrite is acceptable.
    expect(container.querySelector(`[data-testid='accept-btn-${PARENT_ID}']`)).toBeNull();
    ydoc.destroy();
  });

  it("MarginColumn", async () => {
    const onAcceptReplySuggestion = vi.fn();
    const { container } = render(MarginColumn, {
      annotations: [userComment({ textSnapshot: "world" })],
      isTargetLost: () => false,
      positions: new Map<string, number>([[PARENT_ID, 100]]),
      side: "right",
      mode: "full",
      width: 240,
      edgeInset: 8,
      gap: 24,
      activeAnnotationId: null,
      repliesById: new Map([[PARENT_ID, [claudeRewrite()]]]),
      onClick: () => {},
      onAcceptReplySuggestion,
    });
    await tick();
    const btn = await vi.waitFor(() =>
      within(container).getByTestId(`accept-reply-btn-${REPLY_ID}`),
    );
    btn.click();
    expect(onAcceptReplySuggestion).toHaveBeenCalledWith(PARENT_ID, REPLY_ID);
  });
});
