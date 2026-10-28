// @vitest-environment happy-dom
import { flushSync } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TUTORIAL_ANNOTATION_PREFIX } from "../../src/shared/constants.js";
import type { Annotation } from "../../src/shared/types.js";

// Same stub as use-tutorial-chat-advance: createCoworkStatus registers
// onDestroy, which is illegal under $effect.root.
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
 * #1725 — the tutorial's highlight seed is the user's own (`author: "user"`,
 * private, no Accept/Dismiss). Step 0 must still complete through the two
 * Claude comment seeds, and the user highlight seed must never count as the
 * user's own action at step 1.
 */

function seed(name: string, over: Record<string, unknown>): Annotation {
  return {
    id: `${TUTORIAL_ANNOTATION_PREFIX}${name}`,
    type: "comment",
    author: "claude",
    status: "pending",
    content: name,
    range: { from: 0, to: 1 },
    timestamp: 0,
    ...over,
  } as unknown as Annotation;
}

const highlightSeed = (): Annotation =>
  seed("highlight-1", { type: "highlight", author: "user", audience: "private" });
const noteSeed = (): Annotation =>
  seed("note-1", { type: "note", author: "user", audience: "private" });
const commentSeed = (status: Annotation["status"] = "pending"): Annotation =>
  seed("comment-1", { status, audience: "outbound" });

function harness(
  initial: Annotation[],
  run: (ctx: { set: (a: Annotation[]) => void; step: () => number }) => void,
): void {
  // `$state`, so a reassignment re-runs the hook's effects; with a plain `let`
  // every "does not advance" case would pass vacuously.
  let annotations = $state<Annotation[]>(initial);
  const dispose = $effect.root(() => {
    const tut = createTutorial(
      () => annotations,
      () => null,
      () => "welcome.md",
      () => [],
    );
    flushSync();
    run({
      set: (a) => {
        annotations = a;
        flushSync();
      },
      step: () => tut.currentStep,
    });
  });
  dispose();
}

describe("tutorial with a user-authored highlight seed (#1725)", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("step 0 waits on the pending seeds and completes when the Claude comment is accepted", () => {
    harness([highlightSeed(), noteSeed(), commentSeed()], ({ set, step }) => {
      expect(step()).toBe(0);
      set([highlightSeed(), noteSeed(), commentSeed("accepted")]);
      expect(step()).toBe(1);
    });
  });

  it("at step 1, the pending user highlight seed alone does not advance", () => {
    harness([highlightSeed(), noteSeed(), commentSeed("accepted")], ({ set, step }) => {
      expect(step()).toBe(1);
      // Re-delivering the seeds (as a reconnect would) is not a user action.
      set([highlightSeed(), noteSeed(), commentSeed("accepted")]);
      expect(step()).toBe(1);
    });
  });
});
