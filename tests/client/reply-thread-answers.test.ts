// @vitest-environment happy-dom

/**
 * #2360: a Claude answer in the user's own comment thread. The thread opens
 * for a NEW answer (latched on the newest unseen one), shows "N new" until the
 * answer has been on screen with the thread open, and marks it seen then.
 */
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation, AnnotationReply } from "../../src/shared/types";
import { createFakeThreadAnswers } from "./fixtures/fakeThreadAnswers.svelte";
import ReplyThreadWithAnswers from "./fixtures/ReplyThreadWithAnswers.svelte";

beforeEach(() => {
  (Element.prototype as unknown as { animate: () => unknown }).animate = () => ({
    cancel() {},
    currentTime: 0,
    playState: "finished",
    effect: null,
    onfinish: null,
  });
});
afterEach(() => vi.unstubAllGlobals());

const USER_CARD = {
  id: "card",
  type: "comment",
  author: "user",
  audience: "outbound",
  status: "pending",
  content: "Is this right?",
  range: { from: 0, to: 1 },
  timestamp: 0,
} as Annotation;

function answer(id: string, timestamp = 1): AnnotationReply {
  return { id, annotationId: "card", author: "claude", text: `answer ${id}`, timestamp };
}

const toggle = (c: HTMLElement) =>
  c.querySelector("[data-testid='reply-toggle-card']") as HTMLElement;
const marker = (c: HTMLElement) => c.querySelector("[data-testid='reply-unseen-card']");

/** A controllable IntersectionObserver: nothing intersects until told. */
function stubIntersectionObserver() {
  const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];
  class FakeIO {
    targets: Element[] = [];
    constructor(public callback: IntersectionObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
    disconnect() {
      this.targets = [];
    }
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeIO);
  return {
    observers,
    show(visible: boolean) {
      for (const o of observers) {
        if (o.targets.length === 0) continue;
        o.callback(
          o.targets.map(
            (target) => ({ target, isIntersecting: visible }) as IntersectionObserverEntry,
          ),
          o as unknown as IntersectionObserver,
        );
      }
    },
  };
}

describe("ReplyThread — Claude answers on a user's card (#2360)", () => {
  it("stays collapsed on mount when every answer has been seen", async () => {
    const fake = createFakeThreadAnswers([]);
    const { container } = render(ReplyThreadWithAnswers, {
      props: { answers: fake.answers, annotation: USER_CARD, replies: [answer("a")] },
    });
    await tick();
    expect(toggle(container).getAttribute("aria-expanded")).toBe("false");
    expect(marker(container)).toBeNull();
    expect(fake.marked).toEqual([]);
  });

  it("opens on mount for an answer that is still unseen, and marks it seen once shown", async () => {
    const io = stubIntersectionObserver();
    const fake = createFakeThreadAnswers(["a"]);
    const { container } = render(ReplyThreadWithAnswers, {
      props: { answers: fake.answers, annotation: USER_CARD, replies: [answer("a")] },
    });
    await tick();
    expect(toggle(container).getAttribute("aria-expanded")).toBe("true");
    expect(marker(container)?.textContent).toContain("1 new");
    // Open but not on screen (a hidden panel, scrolled away): not seen.
    io.show(false);
    await tick();
    expect(fake.marked).toEqual([]);
    // It observes the newest answer itself, not the whole thread.
    expect(
      io.observers.some((o) =>
        o.targets.some((t) => (t as HTMLElement).dataset.testid === "reply-a"),
      ),
    ).toBe(true);
    io.show(true);
    await tick();
    expect(fake.marked).toEqual([["a"]]);
    await tick();
    expect(marker(container)).toBeNull();
  });

  it("opens when an answer arrives at an already-mounted card", async () => {
    const fake = createFakeThreadAnswers([]);
    const mine = { ...answer("mine"), author: "user" } as AnnotationReply;
    const { container, rerender } = render(ReplyThreadWithAnswers, {
      props: { answers: fake.answers, annotation: USER_CARD, replies: [mine] },
    });
    await tick();
    expect(toggle(container).getAttribute("aria-expanded")).toBe("false");
    stubIntersectionObserver();
    await rerender({ answers: fake.answers, annotation: USER_CARD, replies: [mine, answer("a")] });
    fake.setUnseen(["a"]);
    await tick();
    expect(toggle(container).getAttribute("aria-expanded")).toBe("true");
  });

  it("a thread the user closes stays closed until a newer answer arrives", async () => {
    stubIntersectionObserver();
    const fake = createFakeThreadAnswers(["a"]);
    const { container, rerender } = render(ReplyThreadWithAnswers, {
      props: { answers: fake.answers, annotation: USER_CARD, replies: [answer("a")] },
    });
    await tick();
    expect(toggle(container).getAttribute("aria-expanded")).toBe("true");
    await fireEvent.click(toggle(container));
    await tick();
    expect(toggle(container).getAttribute("aria-expanded")).toBe("false");
    // The click was attention: the answer counts as seen.
    expect(fake.marked).toEqual([["a"]]);
    await rerender({
      answers: fake.answers,
      annotation: USER_CARD,
      replies: [answer("a"), answer("b", 2)],
    });
    fake.setUnseen(["b"]);
    await tick();
    expect(toggle(container).getAttribute("aria-expanded")).toBe("true");
  });

  it("marks nothing while the window is away, and marks it on return", async () => {
    const fake = createFakeThreadAnswers(["a"]);
    fake.setActive(false);
    // No IntersectionObserver here: an open thread counts as on screen.
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(ReplyThreadWithAnswers, {
      props: { answers: fake.answers, annotation: USER_CARD, replies: [answer("a")] },
    });
    await tick();
    expect(toggle(container).getAttribute("aria-expanded")).toBe("true");
    expect(fake.marked).toEqual([]);
    fake.setActive(true);
    await tick();
    expect(fake.marked).toEqual([["a"]]);
  });
});
