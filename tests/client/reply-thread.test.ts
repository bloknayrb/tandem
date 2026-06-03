// @vitest-environment happy-dom

import { fireEvent, render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import ReplyThread from "../../src/client/panels/ReplyThread.svelte";
import type { Annotation, AnnotationReply } from "../../src/shared/types";

// `discloseUnfold` (A13) is a Svelte css-transition → drives `element.animate()`
// (WAAPI), which happy-dom lacks. Stub a minimal Animation so the `{#if open}`
// unfold doesn't throw when a thread is expanded. (Mirrors the stub in
// DocumentTabs.svelte.test.ts.)
beforeEach(() => {
  (Element.prototype as unknown as { animate: () => unknown }).animate = () => ({
    cancel() {},
    currentTime: 0,
    playState: "finished",
    effect: null,
    onfinish: null,
  });
});

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

describe("ReplyThread — A13 disclosure", () => {
  it("collapses replies behind a toggle; expanding reveals the thread", async () => {
    const replies = [makeReply()];

    const { container } = render(ReplyThread, {
      props: {
        annotation: makeAnnotation(),
        replies,
        isPending: false,
        isEditing: false,
      },
    });

    // Collapse-by-default: the toggle shows the count, the thread is NOT mounted.
    const toggle = container.querySelector("[data-testid='reply-toggle-annotation-1']");
    expect(toggle).toBeTruthy();
    expect(toggle?.textContent).toContain("1 reply");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-testid='comment-thread']")).toBeNull();

    // Expanding mounts CommentThread with the reply text.
    await fireEvent.click(toggle as Element);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-testid='comment-thread']")).toBeTruthy();
    expect(container.textContent).toContain("Existing reply");
  });

  it("pluralises the toggle count", () => {
    const replies = [makeReply({ id: "r1" }), makeReply({ id: "r2" })];
    const { container } = render(ReplyThread, {
      props: {
        annotation: makeAnnotation(),
        replies,
        isPending: false,
        isEditing: false,
      },
    });
    const toggle = container.querySelector("[data-testid='reply-toggle-annotation-1']");
    expect(toggle?.textContent).toContain("2 replies");
  });

  // #1000: notes carry PRIVATE reply threads shown directly to the owning user
  // (no collapse toggle — the toggle is for comments only). Notes render
  // CommentThread immediately; a read-only count badge appears for non-pending
  // notes. Claude never sees these threads — ADR-027 is enforced server-side.
  it("note annotation shows thread directly with a read-only count badge", () => {
    const replies = [
      makeReply({ id: "r1", text: "private 1" }),
      makeReply({ id: "r2", text: "private 2" }),
      makeReply({ id: "r3", text: "private 3" }),
    ];

    const { container } = render(ReplyThread, {
      props: {
        annotation: makeAnnotation({ type: "note" }),
        replies,
        isPending: false,
        isEditing: false,
      },
    });

    // Thread is always-visible for notes (no toggle needed).
    expect(container.querySelector("[data-testid='comment-thread']")).toBeTruthy();
    expect(container.textContent).toContain("private 1");
    // Toggle must be absent (notes bypass the A13 disclosure).
    expect(container.querySelector("[data-testid='reply-toggle-annotation-1']")).toBeNull();
    // Read-only count badge (non-pending + no onReply).
    expect(container.textContent ?? "").toMatch(/\b3\s+replies\b/);
  });

  it("highlights still render zero replies", () => {
    const replies = [makeReply({ id: "r1", text: "nope" })];
    const { container } = render(ReplyThread, {
      props: {
        annotation: makeAnnotation({ type: "highlight" }),
        replies,
        isPending: false,
        isEditing: false,
      },
    });
    expect(container.querySelector("[data-testid='comment-thread']")).toBeNull();
    expect(container.textContent).not.toContain("nope");
  });

  it("pending note shows thread directly and button embeds the count", () => {
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

    // Thread directly visible (notes bypass the A13 disclosure toggle).
    expect(container.querySelector("[data-testid='comment-thread']")).toBeTruthy();
    // Toggle absent for notes.
    expect(container.querySelector("[data-testid='reply-toggle-annotation-1']")).toBeNull();
    // Compose button embeds the count for pending notes with existing replies.
    const button = container.querySelector("[data-testid='reply-btn-annotation-1']");
    expect(button?.textContent?.trim()).toBe("Reply (2)");
  });
});
