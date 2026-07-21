/**
 * WS-A2 release-trigger edge detection.
 *
 * The Solo→Tandem release POST must fire on exactly ONE transition and nowhere
 * else — not on entering Solo, not on a same-mode no-op, not on the initial
 * broadcast. `shouldReleaseSolo` is the pure predicate behind
 * `useTandemModeBroadcast.setTandemMode`; a regression here would either drop
 * the proactive release (held items stall until Claude's next poll) or fire
 * spurious releases (needless wakes / marker churn).
 */

import { describe, expect, it } from "vitest";

import { shouldReleaseSolo } from "../../src/client/hooks/useTandemModeBroadcast.svelte.js";

describe("WS-A2 shouldReleaseSolo", () => {
  it("fires on the Solo→Tandem transition", () => {
    expect(shouldReleaseSolo("solo", "tandem")).toBe(true);
  });

  it("does not fire when entering Solo (Tandem→Solo)", () => {
    expect(shouldReleaseSolo("tandem", "solo")).toBe(false);
  });

  it("does not fire on same-mode no-ops", () => {
    expect(shouldReleaseSolo("tandem", "tandem")).toBe(false);
    expect(shouldReleaseSolo("solo", "solo")).toBe(false);
  });
});
