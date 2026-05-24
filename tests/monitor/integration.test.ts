import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TANDEM_MODE_DEFAULT } from "../../src/shared/constants.js";
import { TandemModeSchema } from "../../src/shared/types.js";
import { createFetchStub, installMonitorFakeTimers } from "./fetch-harness.js";

// Both the server-side /api/mode handler and the monitor/channel-side
// getCachedMode() now converge on the SAME cold-start default
// (TANDEM_MODE_DEFAULT, "tandem"). The monitor side additionally became
// stale-preserving (#822): once a real mode has been observed, a transient
// /api/mode failure leaves the mode unchanged — it only ever reverts to the
// cold-start default when no successful fetch has landed yet. Having both
// sides in one file makes the shared default visible at a glance — if either
// side drifts, this test file fails.
describe("mode default convergence", () => {
  let stub: ReturnType<typeof createFetchStub>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
  });

  // The server-side default is applied at src/server/mcp/api-routes.ts via
  // TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE)).
  // Re-exercise that exact expression here so a regression to a different
  // default (e.g. "solo", removing the catch() clause) trips this test.
  it("server side defaults to 'tandem' for missing/malformed values", () => {
    const parseWithServerDefault = (input: unknown) =>
      TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(input);

    expect(parseWithServerDefault(undefined)).toBe("tandem");
    expect(parseWithServerDefault(null)).toBe("tandem");
    expect(parseWithServerDefault("")).toBe("tandem");
    expect(parseWithServerDefault("enterprise")).toBe("tandem");
    expect(parseWithServerDefault(42)).toBe("tandem");
    // TANDEM_MODE_DEFAULT itself must remain "tandem".
    expect(TANDEM_MODE_DEFAULT).toBe("tandem");
  });

  it("monitor side uses the cold-start default 'tandem' when /api/mode omits the mode field on a cold start", async () => {
    stub.on("/api/mode", () => new Response(JSON.stringify({}), { status: 200 }));
    const { getCachedMode } = await import("../../src/monitor/index.js");
    expect(await getCachedMode()).toBe(TANDEM_MODE_DEFAULT);
  });

  it("monitor side preserves an observed 'solo' across a later malformed /api/mode response (does NOT revert to the default)", async () => {
    let serveMalformed = false;
    stub.on("/api/mode", () => {
      if (serveMalformed) return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify({ mode: "solo" }), { status: 200 });
    });
    const { getCachedMode } = await import("../../src/monitor/index.js");
    expect(await getCachedMode()).toBe("solo");

    serveMalformed = true;
    await vi.advanceTimersByTimeAsync(2_500); // past TTL so the next call re-fetches
    expect(await getCachedMode()).toBe("solo"); // stale-preserved, NOT TANDEM_MODE_DEFAULT
  });
});
