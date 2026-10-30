// @vitest-environment happy-dom

/**
 * Cowork ships dark (ADR-055): the desktop tutorial still completes.
 *
 * `createTutorial` holds `allDone` false until the Cowork status "settles".
 * Before the dark gate, settled on desktop meant a status or an error had
 * arrived. With the poller off neither ever does, so a gate applied to the
 * poller alone leaves the desktop checklist unable to finish even with every
 * item ticked. The existing `use-tutorial-*` suites cannot see it:
 * they run with Tauri off, where settled is true by definition.
 *
 * `.svelte.test.ts` for `$effect.root`. The real `createCoworkStatus` registers
 * `onDestroy`, which is illegal there, so it is replaced by a stub that
 * captures the `getActive` it was handed; that capture is also the only way to
 * observe that the tutorial would not have started a poller.
 */

import type { Editor } from "@tiptap/core";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTauriRuntime } from "../../src/client/cowork/cowork-helpers.js";
import { COWORK_ENABLED, TUTORIAL_COMPLETED_KEY } from "../../src/shared/constants.js";
import type { ChatMessage } from "../../src/shared/types.js";

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

  it("starts no Cowork poller, reaches allDone with three ticks and completes", async () => {
    expect(COWORK_ENABLED).toBe(false);
    expect(isTauriRuntime()).toBe(true);

    let resolved = $state<ReadonlySet<string>>(new Set());
    let messages = $state<ChatMessage[]>([]);
    const handlers = new Set<(p: { transaction: unknown }) => void>();
    const editor = {
      isFocused: true,
      on: (_e: string, h: (p: { transaction: unknown }) => void) => handlers.add(h),
      off: (_e: string, h: (p: { transaction: unknown }) => void) => handlers.delete(h),
    };
    let tut: ReturnType<typeof createTutorial> | undefined;
    const dispose = $effect.root(() => {
      tut = createTutorial(
        () => [],
        () => editor as unknown as Editor,
        () => "welcome.md",
        () => messages,
        () => resolved,
      );
    });
    flushSync();
    expect(tut?.tutorialActive).toBe(true);

    expect(captured.getActive, "createTutorial never asked for a Cowork status").not.toBeNull();
    expect(captured.getActive?.()).toBe(false);

    // Tick all three. An unsettled Cowork status would hold `allDone` false.
    resolved = new Set(["tutorial-suggest-1"]);
    messages = [{ id: "m", author: "user", text: "hi", timestamp: Date.now() + 1, read: true }];
    for (const h of handlers) h({ transaction: { docChanged: true, getMeta: () => undefined } });
    await Promise.resolve();
    flushSync();
    expect(tut?.allDone).toBe(true);
    expect(tut?.showCowork).toBe(false);

    vi.advanceTimersByTime(3000);
    flushSync();
    expect(tut?.tutorialActive).toBe(false);
    expect(localStorage.getItem(TUTORIAL_COMPLETED_KEY)).toBe("true");
    dispose();
  });
});
