// @vitest-environment happy-dom

/**
 * Cowork ships dark (ADR-055): the desktop tutorial still completes.
 *
 * `createTutorial` holds `completionStep` at `Infinity` until the Cowork status
 * "settles". Before the dark gate, settled on desktop meant a status or an
 * error had arrived. With the poller off neither ever does, so a gate applied
 * to the poller alone leaves the desktop tutorial unable to finish, and
 * `nextStep()` unclamped. The existing `use-tutorial-*` suites cannot see it:
 * they run with Tauri off, where settled is true by definition.
 *
 * `.svelte.test.ts` for `$effect.root`. The real `createCoworkStatus` registers
 * `onDestroy`, which is illegal there, so it is replaced by a stub that
 * captures the `getActive` it was handed; that capture is also the only way to
 * observe that the tutorial would not have started a poller.
 */

import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTauriRuntime } from "../../src/client/cowork/cowork-helpers.js";
import { COWORK_ENABLED, TUTORIAL_COMPLETED_KEY } from "../../src/shared/constants.js";

const captured: { getActive: (() => boolean) | null } = { getActive: null };

vi.mock(import("../../src/client/hooks/useCoworkStatus.svelte.js"), () => ({
  createCoworkStatus: (getActive: () => boolean) => {
    captured.getActive = getActive;
    return {
      get status() {
        return null;
      },
      get error() {
        return null;
      },
      loading: false,
      refetch: vi.fn(async () => true),
    };
  },
}));

import { createTutorial } from "../../src/client/hooks/useTutorial.svelte.js";

describe("Cowork ships dark (ADR-055): the desktop tutorial", () => {
  beforeEach(() => {
    captured.getActive = null;
    localStorage.clear();
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    localStorage.clear();
  });

  it("starts no Cowork poller, clamps at step 3 and completes", () => {
    expect(COWORK_ENABLED).toBe(false);
    expect(isTauriRuntime()).toBe(true);

    const dispose = $effect.root(() => {
      const tut = createTutorial(
        () => [],
        () => null,
        () => "welcome.md",
        () => [],
      );
      flushSync();
      expect(tut.tutorialActive).toBe(true);

      expect(captured.getActive, "createTutorial never asked for a Cowork status").not.toBeNull();
      expect(captured.getActive?.()).toBe(false);

      // Four presses against a three-step tutorial. An unsettled status leaves
      // `completionStep` at Infinity and this lands on 4.
      for (let i = 0; i < 4; i++) tut.nextStep();
      flushSync();
      expect(tut.currentStep).toBe(3);

      vi.advanceTimersByTime(3000);
      flushSync();
      expect(tut.tutorialActive).toBe(false);
      expect(localStorage.getItem(TUTORIAL_COMPLETED_KEY)).toBe("true");
    });
    dispose();
  });
});
