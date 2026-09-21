// @vitest-environment happy-dom
import { flushSync } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TUTORIAL_ANNOTATION_PREFIX } from "../../src/shared/constants.js";
import type { Annotation, ChatMessage } from "../../src/shared/types.js";

// createTutorial spins up a createCoworkStatus poller that registers onDestroy —
// illegal under $effect.root (no component instance). Stub it inert; the Cowork
// step is irrelevant to the step-1 advance this file tests.
vi.mock(import("../../src/client/hooks/useCoworkStatus.svelte.js"), () => ({
  createCoworkStatus: () => ({
    get status() {
      return null;
    },
    get error() {
      return null;
    },
    loading: false,
    refetch: vi.fn(async () => true),
  }),
}));

import { createTutorial } from "../../src/client/hooks/useTutorial.svelte.js";

/**
 * #1965 — tutorial step 2 ("Ask a question", `currentStep === 1`) must also
 * complete when the user sends a chat message, which is what its own copy and
 * the user guide promise. A user who only uses Chat during that step was stuck.
 *
 * The advance is time-scoped against `stepAdvancedAt`, because chat is durable
 * and app-global: a pre-existing message must not auto-skip the step.
 */

/** The resolved tutorial seed that drives the step-0 effect to step 1. */
function resolvedSeed(): Annotation {
  return {
    id: `${TUTORIAL_ANNOTATION_PREFIX}seed`,
    type: "note",
    author: "user",
    status: "resolved",
    content: "seed",
    range: { from: 0, to: 1 },
    timestamp: 0,
  } as unknown as Annotation;
}

function userAnnotation(): Annotation {
  return {
    id: "ann-real",
    type: "highlight",
    author: "user",
    status: "pending",
    content: "mine",
    range: { from: 0, to: 1 },
    timestamp: 0,
  } as unknown as Annotation;
}

function message(author: "user" | "claude", timestamp: number): ChatMessage {
  return {
    id: `msg-${author}-${timestamp}`,
    author,
    text: "hello",
    timestamp,
    read: true,
  };
}

/**
 * Drive the hook to step 1, then swap in the step-1 stubs and flush.
 *
 * The stubs are read through mutable cells so the same hook instance sees the
 * step-0 inputs first and the step-1 inputs after — a fresh `createTutorial`
 * per phase would lose `stepAdvancedAt`, which is the term under test.
 */
function atStepOne(
  run: (ctx: {
    setAnnotations: (a: Annotation[]) => void;
    setMessages: (m: ChatMessage[]) => void;
    step: () => number;
  }) => void,
): void {
  // `$state`, not plain `let`: the getters are read inside the hook's
  // `$effect`s, so a plain reassignment would never re-run them and every
  // "does not advance" case would pass vacuously.
  let annotations = $state<Annotation[]>([resolvedSeed()]);
  let messages = $state<ChatMessage[]>([]);
  const dispose = $effect.root(() => {
    const tut = createTutorial(
      () => annotations,
      () => null,
      () => "welcome.md",
      () => messages,
    );
    flushSync();
    expect(tut.currentStep).toBe(1);
    run({
      setAnnotations: (a) => {
        annotations = a;
        flushSync();
      },
      setMessages: (m) => {
        messages = m;
        flushSync();
      },
      step: () => tut.currentStep,
    });
  });
  dispose();
}

describe("tutorial step 1 chat advance (#1965)", () => {
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it("advances on a user chat message sent during the step", () => {
    atStepOne(({ setMessages, step }) => {
      setMessages([message("user", Date.now() + 1000)]);
      expect(step()).toBe(2);
    });
  });

  it("does not advance on a Claude-authored message", () => {
    atStepOne(({ setMessages, step }) => {
      setMessages([message("claude", Date.now() + 1000)]);
      expect(step()).toBe(1);
    });
  });

  it("still advances on a non-tutorial user annotation", () => {
    atStepOne(({ setAnnotations, step }) => {
      setAnnotations([resolvedSeed(), userAnnotation()]);
      expect(step()).toBe(2);
    });
  });

  it("holds at step 1 with empty chat and no user annotation", () => {
    atStepOne(({ setMessages, step }) => {
      setMessages([]);
      expect(step()).toBe(1);
    });
  });

  it("does not advance on a chat message that predates the step", () => {
    // The replay case: chat is durable and `restartTutorial` cannot clear it,
    // so without the `timestamp > stepAdvancedAt` term this silently skips
    // "Ask a question" for every user with any chat history.
    atStepOne(({ setMessages, step }) => {
      setMessages([message("user", Date.now() - 60_000)]);
      expect(step()).toBe(1);
    });
  });
});
