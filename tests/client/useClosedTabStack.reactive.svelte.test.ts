/**
 * Reactivity contract for the promoted `.svelte.ts` closed-tab stack.
 *
 * The imperative push/pop/peek/size/clear behaviour is covered in
 * `useClosedTabStack.test.ts`. This file proves the one thing the promotion
 * adds: the `top` getter is tracked, so a consumer's reactive context (here an
 * `$effect`) re-runs when the head of the stack changes. That is what drives
 * the new-tab launcher's "Reopen last closed" enabled state live while open.
 */

import { flushSync } from "svelte";
import { describe, expect, it } from "vitest";
import { createClosedTabStack } from "../../src/client/hooks/useClosedTabStack.svelte.js";

describe("createClosedTabStack reactive top", () => {
  it("re-runs an effect that reads top on push, pop, and clear", () => {
    const cleanup = $effect.root(() => {
      const stack = createClosedTabStack();
      let observed: string | null = "sentinel";

      $effect(() => {
        observed = stack.top?.filePath ?? null;
      });

      flushSync();
      expect(observed).toBeNull();

      stack.push({ filePath: "/a", closedAt: 1 });
      flushSync();
      expect(observed).toBe("/a");

      stack.push({ filePath: "/b", closedAt: 2 });
      flushSync();
      expect(observed).toBe("/b");

      stack.pop();
      flushSync();
      expect(observed).toBe("/a");

      stack.clear();
      flushSync();
      expect(observed).toBeNull();
    });
    cleanup();
  });
});
