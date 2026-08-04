import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DECLINED_BY_USER } from "../../../src/codex-agent/approval-protocol.js";
import { CodexApprovalBroker } from "../../../src/server/codex/approval-broker.js";

/**
 * Covers the two broker-level behaviours the HTTP-route tests
 * (`approval-routes.test.ts`) don't exercise directly: the 120s auto-decline
 * on timeout, and the legacy vs. modern decline result shape a timeout
 * produces. `cancel()` (used by the route's disconnect handler) shares the
 * exact same decline path, so it is pinned here too rather than duplicated
 * at the HTTP layer.
 */
describe("CodexApprovalBroker timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays pending right up to the 120s deadline, then auto-declines", async () => {
    const broker = new CodexApprovalBroker();
    const pending = broker.request("item/commandExecution/requestApproval", {
      command: "rm -rf /tmp/x",
    });

    // Positive control: 1ms before the deadline, the request is still open —
    // proving the eventual decline is genuinely gated by the 120s timer, not
    // an immediate no-op. A broker that declined everything on `request()`
    // would pass the assertion below but fail this one.
    await vi.advanceTimersByTimeAsync(119_999);
    expect(broker.list().some((v) => v.id === pending.id)).toBe(true);
    expect(broker.decide(pending.id, "accept")).toBe(true);
    await expect(pending.result).resolves.toEqual({ decision: "accept" });

    // Second request to observe the actual timeout firing (the first was
    // resolved by hand above).
    const timedOut = broker.request("item/commandExecution/requestApproval", {
      command: "npm test",
    });
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(timedOut.result).resolves.toEqual({ decision: "decline" });
    expect(broker.list().some((v) => v.id === timedOut.id)).toBe(false);
    // Once timed out, the id is gone — a late decide() is a no-op, not a
    // double-resolve.
    expect(broker.decide(timedOut.id, "accept")).toBe(false);
  });

  it("auto-declines a legacy-protocol method with the legacy denied/rejection shape", async () => {
    const broker = new CodexApprovalBroker();
    const pending = broker.request("execCommandApproval", { command: "echo hi" });

    await vi.advanceTimersByTimeAsync(120_000);

    await expect(pending.result).resolves.toEqual({
      decision: { denied: { rejection: DECLINED_BY_USER } },
    });
  });

  it("cancel() (the disconnect path) declines immediately without waiting for the timer", async () => {
    const broker = new CodexApprovalBroker();
    const pending = broker.request("applyPatchApproval", { reason: "edit" });

    broker.cancel(pending.id);

    await expect(pending.result).resolves.toEqual({
      decision: { denied: { rejection: DECLINED_BY_USER } },
    });
    expect(broker.list()).toEqual([]);
    // No timer left running for this id — advancing well past the deadline
    // must not throw or double-resolve.
    await vi.advanceTimersByTimeAsync(200_000);
  });

  it("cancel() on an unknown id is a no-op (already decided/timed out elsewhere)", () => {
    const broker = new CodexApprovalBroker();
    // Must not throw.
    expect(() => broker.cancel("no-such-id")).not.toThrow();
  });
});
