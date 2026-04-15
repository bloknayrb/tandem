import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TANDEM_MODE_DEFAULT } from "../../src/shared/constants.js";
import { TandemModeSchema } from "../../src/shared/types.js";
import { createFetchStub, installMonitorFakeTimers } from "./fetch-harness.js";

// Fences the asymmetry documented in docs/architecture.md "Contract Asymmetry:
// Mode Check": the server-side /api/mode handler defaults missing/malformed
// values to "tandem" (fails open); the monitor-side getCachedMode() defaults
// to "solo" (fails closed). Having both sides in one file makes the asymmetry
// visible at a glance — if either side drifts, this test file fails.
describe("mode default asymmetry", () => {
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
  it("server side fails open to 'tandem' for missing/malformed values", () => {
    const parseWithServerDefault = (input: unknown) =>
      TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(input);

    expect(parseWithServerDefault(undefined)).toBe("tandem");
    expect(parseWithServerDefault(null)).toBe("tandem");
    expect(parseWithServerDefault("")).toBe("tandem");
    expect(parseWithServerDefault("enterprise")).toBe("tandem");
    expect(parseWithServerDefault(42)).toBe("tandem");
    // TANDEM_MODE_DEFAULT itself must remain "tandem" for the asymmetry to hold.
    expect(TANDEM_MODE_DEFAULT).toBe("tandem");
  });

  it("monitor side fails closed to 'solo' when /api/mode omits the mode field", async () => {
    stub.on("/api/mode", () => new Response(JSON.stringify({}), { status: 200 }));
    const { getCachedMode } = await import("../../src/monitor/index.js");
    expect(await getCachedMode()).toBe("solo");
  });
});
