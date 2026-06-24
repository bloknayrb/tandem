import { describe, expect, it } from "vitest";
import { backoffOptionsFor } from "../../src/client/hooks/yjsSync.svelte";

describe("backoffOptionsFor — reconnect strategy → provider backoff", () => {
  it("exponential mirrors the provider defaults (1s base, ×2, 30s cap)", () => {
    expect(backoffOptionsFor("exponential")).toEqual({
      delay: 1000,
      factor: 2,
      maxAttempts: 0,
      minDelay: 1000,
      maxDelay: 30000,
      jitter: true,
    });
  });

  it("constant-2s holds a flat 2s retry with no growth or jitter", () => {
    expect(backoffOptionsFor("constant-2s")).toEqual({
      delay: 2000,
      factor: 1,
      maxAttempts: 0,
      minDelay: 2000,
      maxDelay: 2000,
      jitter: false,
    });
  });

  // Critical invariant: neither strategy may disable auto-reconnect. The
  // stale-tab generation-gate recovery (`authenticationFailed → scheduleRebuild`)
  // depends on a rejected provider eventually reconnecting and re-sending Auth.
  // `maxAttempts: 0` means "retry forever" in @hocuspocus/provider.
  it("never disables auto-reconnect (maxAttempts stays 0 for every strategy)", () => {
    for (const strategy of ["exponential", "constant-2s"] as const) {
      expect(backoffOptionsFor(strategy).maxAttempts).toBe(0);
    }
  });
});
