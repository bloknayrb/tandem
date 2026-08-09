import { describe, expect, it } from "vitest";
import { deliveryStall } from "../../src/client/status/delivery-stall.js";
import { DELIVERY_STALL_MS } from "../../src/shared/constants.js";

/**
 * D-5's decision, isolated from rendering.
 *
 * The failures worth guarding here are all failures of SILENCE or of
 * over-claiming — a banner that appears during a healthy turn is worse than no
 * banner, because the whole point of this surface is to stop the product
 * looking broken when it is merely asynchronous.
 */

const base = {
  state: "awaiting-poll",
  waitingMs: DELIVERY_STALL_MS,
  soloMode: false,
  serverUnreachable: false,
};

describe("deliveryStall", () => {
  it("fires once the wait crosses the threshold", () => {
    expect(deliveryStall(base)).toBe(DELIVERY_STALL_MS);
  });

  it("stays silent below it", () => {
    // A model that is working polls every 2-3 tool calls, so a brief wait is
    // the normal shape of a healthy session and must not be reported.
    expect(deliveryStall({ ...base, waitingMs: DELIVERY_STALL_MS - 1 })).toBeNull();
    expect(deliveryStall({ ...base, waitingMs: 0 })).toBeNull();
  });

  describe("states that make no claim", () => {
    it.each([["polled"], ["idle"]])("stays silent on %s", (state) => {
      expect(deliveryStall({ ...base, state, waitingMs: 10 * 60_000 })).toBeNull();
    });

    it("stays silent on consumer-detached even though a wait is real", () => {
      // The wait IS real there, but nothing is attached to have picked it up —
      // so "Claude hasn't picked this up" blames a model for a missing
      // transport. `subscribers === 0` owns that story, via the no-push notice.
      expect(
        deliveryStall({ ...base, state: "consumer-detached", waitingMs: 60 * 60_000 }),
      ).toBeNull();
    });

    it("stays silent on a state string it has never heard of", () => {
      // An older or newer server naming a state this client does not know must
      // read as "no claim", never as a claim it happens to resemble.
      expect(deliveryStall({ ...base, state: "awaiting" })).toBeNull();
      expect(deliveryStall({ ...base, state: "AWAITING-POLL" })).toBeNull();
      expect(deliveryStall({ ...base, state: null })).toBeNull();
    });

    it("stays silent when the server declined to report a wait", () => {
      expect(deliveryStall({ ...base, waitingMs: null })).toBeNull();
    });
  });

  describe("precedence", () => {
    it("Solo outranks it — the user opted out of AI surfacing", () => {
      expect(deliveryStall({ ...base, soloMode: true, waitingMs: 60 * 60_000 })).toBeNull();
    });

    it("a dead server outranks it, and must not stack with it", () => {
      // "Claude hasn't picked this up" is true with the server gone and blames
      // the wrong party — and the offline notice already tells that story
      // better, including that the message may not survive the reconnect.
      expect(
        deliveryStall({ ...base, serverUnreachable: true, waitingMs: 60 * 60_000 }),
      ).toBeNull();
    });
  });

  it("reports the raw wait, leaving formatting to the component", () => {
    expect(deliveryStall({ ...base, waitingMs: 754_000 })).toBe(754_000);
  });
});
