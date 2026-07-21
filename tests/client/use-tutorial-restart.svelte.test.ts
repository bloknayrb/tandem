// @vitest-environment happy-dom
import { flushSync } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TUTORIAL_COMPLETED_KEY } from "../../src/shared/constants.js";

// createTutorial spins up a createCoworkStatus poller that registers onDestroy —
// illegal under $effect.root (no component instance). Stub it inert; the Cowork
// step is irrelevant to the replay re-arm this file tests.
vi.mock("../../src/client/hooks/useCoworkStatus.svelte.js", () => ({
  createCoworkStatus: () => ({
    get status() {
      return null;
    },
    get error() {
      return null;
    },
  }),
}));

import { createTutorial } from "../../src/client/hooks/useTutorial.svelte.js";

/**
 * Mount-level test for restartTutorial (WS-E replay re-arm). Needs the Svelte
 * compiler (.svelte.test.ts) so `$effect.root` + the hook's runes work, plus
 * happy-dom for localStorage. The pure predicates live in use-tutorial.test.ts.
 */
describe("restartTutorial (replay re-arm)", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("clears the completed flag + re-activates on the welcome tab", () => {
    // A returning user who already completed the tutorial.
    localStorage.setItem(TUTORIAL_COMPLETED_KEY, "true");

    const dispose = $effect.root(() => {
      const tut = createTutorial(
        () => [],
        () => null,
        () => "welcome.md",
      );
      flushSync();
      // Completed → not active despite welcome.md being the active tab.
      expect(tut.tutorialActive).toBe(false);

      tut.restartTutorial();
      flushSync();

      // Re-armed: the persisted flag is cleared and the tutorial is active again,
      // reset to step 0 so a full replay runs.
      expect(localStorage.getItem(TUTORIAL_COMPLETED_KEY)).toBeNull();
      expect(tut.tutorialActive).toBe(true);
      expect(tut.currentStep).toBe(0);
    });
    dispose();
  });
});
