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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  shouldReleaseSolo,
  triggerSoloRelease,
} from "../../src/client/hooks/useTandemModeBroadcast.svelte.js";
import { _resetClientLog, readClientLog } from "../../src/client/utils/client-log.js";

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

/**
 * #1769: the route no longer writes the mode key — it answers 409
 * `MODE_NOT_TANDEM` when the room does not read Tandem. A 409 is TRANSIENT when
 * this POST merely outran the client's own CRDT write, so it gets exactly one
 * delayed retry; a second refusal is definitive enough to log and stop.
 *
 * `triggerSoloRelease` is driven directly rather than through
 * `TandemModeHarness`: `waitFor` polls on the faked timer and would hang.
 */
describe("WS-A2 triggerSoloRelease retry policy (#1769)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  function refusal(): Response {
    return new Response(JSON.stringify({ error: "MODE_NOT_TANDEM", data: { released: 0 } }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }

  function modeWarnings(): readonly string[] {
    return readClientLog()
      .filter((e) => e.scope === "tandem-mode")
      .map((e) => e.event);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    _resetClientLog();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetClientLog();
  });

  it("retries a MODE_NOT_TANDEM 409 once, after a delay, and stays silent on success", async () => {
    fetchSpy.mockResolvedValueOnce(refusal());
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const done = triggerSoloRelease();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    // The retry is DELAYED — nothing fires until the timer advances.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    await done;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(modeWarnings()).toEqual([]);
  });

  it("logs one static literal and stops after a second refusal", async () => {
    // A FRESH Response per call: a body is consumed once, and both attempts read it.
    fetchSpy.mockImplementation(async () => refusal());

    const done = triggerSoloRelease();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(250);
    await done;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(modeWarnings()).toEqual(["release-refused-room-not-tandem"]);
  });

  it("posts exactly once when the room already reads Tandem", async () => {
    fetchSpy.mockImplementation(async () => new Response("{}", { status: 200 }));

    await triggerSoloRelease();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(modeWarnings()).toEqual([]);
  });

  it("keeps the original single IMMEDIATE retry for any other failure", async () => {
    fetchSpy.mockImplementation(async () => new Response("boom", { status: 500 }));

    await triggerSoloRelease();

    // No timer advance needed: a 500 is not the mode race, so it is not delayed.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(modeWarnings()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
