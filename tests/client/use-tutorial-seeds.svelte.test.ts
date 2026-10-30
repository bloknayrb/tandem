// @vitest-environment happy-dom
import { flushSync } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TUTORIAL_ANNOTATION_PREFIX } from "../../src/shared/constants.js";
import type { Annotation } from "../../src/shared/types.js";

// Same stub as use-tutorial-checklist: createCoworkStatus registers
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

import { createTutorial, type TutorialState } from "../../src/client/hooks/useTutorial.svelte.js";

/**
 * #1725 — the tutorial's highlight seed is the user's own (`author: "user"`,
 * private, no Accept/Dismiss). It must never count as the user asking Claude
 * something, or as the user resolving one (#1711 checklist).
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
  run: (ctx: { set: (a: Annotation[]) => void; tut: TutorialState }) => void,
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
      () => new Set(),
    );
    flushSync();
    run({
      set: (a) => {
        annotations = a;
        flushSync();
      },
      tut,
    });
  });
  dispose();
}

describe("tutorial with a user-authored highlight seed (#1725)", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("the pending user highlight seed never ticks 'Ask Claude something'", () => {
    harness([highlightSeed(), noteSeed(), commentSeed("accepted")], ({ set, tut }) => {
      // Re-delivering the seeds (as a reconnect would) is not a user action.
      set([highlightSeed(), noteSeed(), commentSeed("accepted")]);
      expect(tut.asked).toBe(false);
      expect(tut.reviewed).toBe(false);
    });
  });
});
