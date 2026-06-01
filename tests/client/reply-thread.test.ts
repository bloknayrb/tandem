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

  // #1000: notes carry PRIVATE reply threads, displayed to the owning user.
  // (Claude never sees them — that boundary is enforced server-side, not here.)
  // A13: note replies sit behind the disclosure toggle (collapse-by-default).
  it("note annotation shows disclosure toggle for its private replies", () => {
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

    // Post-#1000: notes show private threads to the owning user via the A13 toggle.
    const toggle = container.querySelector("[data-testid='reply-toggle-annotation-1']");
    expect(toggle).toBeTruthy();
    expect(toggle?.textContent).toContain("3 replies");
    // Collapsed by default — thread not mounted until toggled.
    expect(container.querySelector("[data-testid='comment-thread']")).toBeNull();
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

  it("a note with a reply input shows toggle and button reads 'Reply'", () => {
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

    // Post-#1000: notes get a disclosure toggle; count lives there, not on the button.
    expect(container.querySelector("[data-testid='reply-toggle-annotation-1']")).toBeTruthy();
    const button = container.querySelector("[data-testid='reply-btn-annotation-1']");
    expect(button?.textContent?.trim()).toBe("Reply");
  });
});
