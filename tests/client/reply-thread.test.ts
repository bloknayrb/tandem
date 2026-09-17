// @vitest-environment happy-dom

import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
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

  it("#1123 M3: a claude reply with agentIdentity bylines with the model name, not the family label", async () => {
    const replies = [
      makeReply({
        text: "local model reply",
        agentIdentity: { provider: "local-ollama", displayName: "Qwen 2.5" },
      }),
    ];
    const { container } = render(ReplyThread, {
      props: {
        annotation: makeAnnotation(),
        replies,
        isPending: false,
        isEditing: false,
      },
    });
    await fireEvent.click(
      container.querySelector("[data-testid='reply-toggle-annotation-1']") as Element,
    );
    // The specific model name renders; the generic family fallback ("Assistant"
    // when no model is configured in this test's store) does not.
    expect(container.textContent).toContain("Qwen 2.5");
    // #1123 M4: the byline is tinted with the per-agent color (inline override).
    const author = container.querySelector(".ct-author.is-claude");
    expect(author?.getAttribute("style") ?? "").toContain(
      "color: var(--tandem-agent-local-ollama);",
    );
    const dot = container.querySelector(".ct-author-dot--claude");
    expect(dot?.getAttribute("style") ?? "").toContain(
      "background: var(--tandem-agent-local-ollama);",
    );
  });

  it("#1123 M4: a claude reply WITHOUT agentIdentity adds no inline color (byte-identical dark)", async () => {
    const replies = [makeReply({ text: "vanilla claude reply" })];
    const { container } = render(ReplyThread, {
      props: {
        annotation: makeAnnotation(),
        replies,
        isPending: false,
        isEditing: false,
      },
    });
    await fireEvent.click(
      container.querySelector("[data-testid='reply-toggle-annotation-1']") as Element,
    );
    // No agentIdentity ⇒ no inline style attribute at all ⇒ the CSS class's
    // --tandem-author-claude renders exactly as before M4.
    const author = container.querySelector(".ct-author.is-claude");
    expect(author?.getAttribute("style")).toBeNull();
    const dot = container.querySelector(".ct-author-dot--claude");
    expect(dot?.getAttribute("style")).toBeNull();
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

  // #1000: notes carry PRIVATE reply threads shown to the owning user via the
  // same A13 collapse-by-default disclosure as comments. Claude never sees these
  // threads — ADR-027 is enforced server-side.
  it("note annotation shows A13 disclosure toggle (collapsed by default)", () => {
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

    // Toggle present with count (same as A13 comment behavior).
    const toggle = container.querySelector("[data-testid='reply-toggle-annotation-1']");
    expect(toggle).toBeTruthy();
    expect(toggle?.textContent ?? "").toMatch(/\b3\s+replies\b/);
    // Thread collapsed by default — CommentThread not mounted until toggle clicked.
    expect(container.querySelector("[data-testid='comment-thread']")).toBeNull();
    expect(container.textContent).not.toContain("private 1");
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

  it("pending note shows A13 toggle and plain Reply button", () => {
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

    // Toggle present with count — same as comments.
    const toggle = container.querySelector("[data-testid='reply-toggle-annotation-1']");
    expect(toggle).toBeTruthy();
    expect(toggle?.textContent ?? "").toMatch(/\b2\s+replies\b/);
    // Thread collapsed by default.
    expect(container.querySelector("[data-testid='comment-thread']")).toBeNull();
    // Reply button says plain "Reply" — count lives on the toggle.
    const button = container.querySelector("[data-testid='reply-btn-annotation-1']");
    expect(button?.textContent?.trim()).toBe("Reply");
  });
});

/**
 * #1626 review — **the auto-open must survive the LIVE path, not just a fresh
 * mount.**
 *
 * The seed shipped as a mount-time `untrack(...)` initializer. SidePanel's
 * pending list is `{#each filteredData.pending as ann (ann.id)}` — KEYED — so
 * when the Y.Map observer rebuilds `repliesMap` an already-rendered card is
 * updated in place and never remounted. A suggestion arriving at a card the
 * user is looking at therefore never ran the initializer: `open` stayed false,
 * the `{#if open}` block never mounted, and neither the proposal nor its Accept
 * button existed in the DOM — the user saw "1 reply" and nothing else. The
 * seed's own rationale ("a proposal the user cannot see is a proposal they
 * cannot accept") is what that defeats, so the rerender case is the one that
 * matters; the mount case is kept as the control it always was.
 */
describe("#1626: a suggestion-bearing reply opens the thread", () => {
  const SUGGESTION = makeReply({ id: "r2", text: "refined", suggestedText: "Replacement" });

  it("opens at mount when a suggestion is already present", () => {
    const { container } = render(ReplyThread, {
      props: {
        annotation: makeAnnotation(),
        replies: [SUGGESTION],
        isPending: true,
        isEditing: false,
        onAcceptReplySuggestion: () => {},
      },
    });

    expect(
      container
        .querySelector("[data-testid='reply-toggle-annotation-1']")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(container.querySelector("[data-testid='reply-suggestion-r2']")).toBeTruthy();
    expect(container.querySelector("[data-testid='accept-reply-btn-r2']")).toBeTruthy();
  });

  it("opens when the suggestion arrives at an ALREADY-MOUNTED card", async () => {
    const props = {
      annotation: makeAnnotation(),
      replies: [makeReply()],
      isPending: true,
      isEditing: false,
      onAcceptReplySuggestion: () => {},
    };
    const { container, rerender } = render(ReplyThread, { props });

    const toggle = container.querySelector("[data-testid='reply-toggle-annotation-1']");
    expect(toggle?.getAttribute("aria-expanded"), "collapsed while no proposal exists").toBe(
      "false",
    );

    // The reply record syncing in — a prop update, NOT a remount, which is what
    // the keyed `{#each}` guarantees and what the mount-time seed missed.
    await rerender({ ...props, replies: [makeReply(), SUGGESTION] });
    await tick();

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-testid='reply-suggestion-r2']")).toBeTruthy();
    expect(container.querySelector("[data-testid='accept-reply-btn-r2']")).toBeTruthy();
  });

  it("does NOT re-open a thread the user closed", async () => {
    // The latch. A bare `$effect` would re-open on every reply-list rerender,
    // which is precisely why the original was written as a mount-time seed —
    // the fix has to keep that property, not trade it away.
    const props = {
      annotation: makeAnnotation(),
      replies: [SUGGESTION],
      isPending: true,
      isEditing: false,
      onAcceptReplySuggestion: () => {},
    };
    const { container, rerender } = render(ReplyThread, { props });

    const toggle = container.querySelector("[data-testid='reply-toggle-annotation-1']") as Element;
    await fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded"), "user closed it").toBe("false");

    await rerender({ ...props, replies: [SUGGESTION, makeReply({ id: "r3", text: "later" })] });
    await tick();

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
