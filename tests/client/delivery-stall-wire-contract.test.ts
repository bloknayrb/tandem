import { describe, expect, it } from "vitest";
import { deliveryStall } from "../../src/client/status/delivery-stall.js";
import {
  getDeliveryState,
  recordWakeForward,
  resetDeliveryStateForTests,
} from "../../src/server/events/delivery-state.js";
import { DELIVERY_STALL_MS } from "../../src/shared/constants.js";

/**
 * The one seam in D-5 that neither side's own tests can see.
 *
 * `deliveryStall` matches the bare literal `"awaiting-poll"`; the server mints
 * it from `DeliveryJoinState`. Nothing in the type system joins the two — the
 * client deliberately treats the wire value as opaque `string`, so that an older
 * or newer server naming a state it has never heard of reads as "no claim"
 * rather than as a claim it happens to resemble. That is the right design and it
 * has one cost: renaming the server's variant is a silent, total kill of the
 * banner, with every test on both sides still green.
 *
 * This is the test that goes red instead. It does not import a shared constant
 * (there deliberately isn't one) — it drives the real server module into the
 * stalled condition and feeds its real output to the real client predicate.
 */

describe("delivery join — server state names reach the client predicate", () => {
  it("the state the server mints for an outstanding forward is the one the client acts on", () => {
    resetDeliveryStateForTests();

    const forwardedAt = 1_000_000;
    recordWakeForward(forwardedAt);
    // Well past the threshold, so the ONLY thing that can suppress the banner
    // here is the state string failing to match.
    const server = getDeliveryState(forwardedAt + DELIVERY_STALL_MS + 1_000, 1);

    expect(server.state).toBe("awaiting-poll");
    expect(
      deliveryStall({
        state: server.state,
        waitingMs: server.waitingMs,
        soloMode: false,
        serverUnreachable: false,
      }),
    ).toBe(DELIVERY_STALL_MS + 1_000);

    resetDeliveryStateForTests();
  });

  it("the states that mean 'no claim' are silent through the same path", () => {
    resetDeliveryStateForTests();

    // Nothing forwarded yet.
    const idle = getDeliveryState(1_000_000, 1);
    expect(idle.state).toBe("idle");
    expect(silentFor(idle)).toBeNull();

    // Forwarded, but the last external consumer is gone — a real wait that this
    // banner must not narrate, because `subscribers === 0` owns that story.
    recordWakeForward(1_000_000);
    const detached = getDeliveryState(1_000_000 + DELIVERY_STALL_MS + 1_000, 0);
    expect(detached.state).toBe("consumer-detached");
    expect(silentFor(detached)).toBeNull();

    resetDeliveryStateForTests();
  });
});

function silentFor(server: { state: string; waitingMs: number | null }): number | null {
  return deliveryStall({
    state: server.state,
    waitingMs: server.waitingMs,
    soloMode: false,
    serverUnreachable: false,
  });
}
