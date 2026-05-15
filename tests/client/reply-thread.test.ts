// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import ReplyThread from "../../src/client/panels/ReplyThread.svelte";
import type { Annotation, AnnotationReply } from "../../src/shared/types";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "annotation-1",
    type: "comment",
    author: "claude",
    status: "pending",
    content: "Body",
    range: { from: 0, to: 1 },
    timestamp: 0,
    ...overrides,
  } as Annotation;
}

function makeReply(overrides: Partial<AnnotationReply> = {}): AnnotationReply {
  return {
    id: "reply-1",
    annotationId: "annotation-1",
    author: "claude",
    text: "Existing reply",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("ReplyThread", () => {
  it("renders existing replies when reply input is not available", () => {
    const replies = [makeReply()];

    const { container } = render(ReplyThread, {
      props: {
        annotation: makeAnnotation(),
        replies,
        isPending: false,
        isEditing: false,
      },
    });

    expect(container.querySelector("[data-testid='comment-thread']")).toBeTruthy();
    expect(container.textContent).toContain("Existing reply");
    expect(container.textContent).toContain("reply");
  });

  // ADR-027: notes are user-private. Even a count badge on a note that has
  // replies in the underlying Y.Map leaks information to Claude. The single
  // fan-out point (getVisibleReplies inside ReplyThread) must drop them.
  it("renders zero replies and zero count badge for a note annotation", () => {
    const replies = [
      makeReply({ id: "r1", text: "leak 1" }),
      makeReply({ id: "r2", text: "leak 2" }),
      makeReply({ id: "r3", text: "leak 3" }),
    ];

    const { container } = render(ReplyThread, {
      props: {
        annotation: makeAnnotation({ type: "note" }),
        replies,
        isPending: false,
        isEditing: false,
      },
    });

    // CommentThread renders nothing for empty replies.
    expect(container.querySelector("[data-testid='comment-thread']")).toBeNull();
    expect(container.textContent).not.toContain("leak");
    // Read-only count badge (non-pending + no onReply) must not surface a count.
    expect(container.textContent ?? "").not.toMatch(/\b3 replies\b/);
    expect(container.textContent ?? "").not.toMatch(/\b3 reply\b/);
  });

  it("count badge in reply button reads zero for note annotation", () => {
    const replies = [makeReply(), makeReply({ id: "r2" })];
    const onReply = async () => true;

    const { container } = render(ReplyThread, {
      props: {
        annotation: makeAnnotation({ type: "note" }),
        replies,
        isPending: true,
        isEditing: false,
        onReply,
      },
    });

    // For a note with onReply (e.g. hypothetical surface), the button label
    // omits the parenthesized count because visibleReplies is empty.
    const button = container.querySelector("[data-testid='reply-btn-annotation-1']");
    expect(button?.textContent?.trim()).toBe("Reply");
  });
});
