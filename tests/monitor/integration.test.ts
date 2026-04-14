import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchStub, installMonitorFakeTimers } from "./fetch-harness.js";

describe("mode default — monitor side of the documented asymmetry", () => {
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

  it("monitor treats a missing mode field as solo (privacy-preserving default)", async () => {
    stub.on("/api/mode", () => new Response(JSON.stringify({}), { status: 200 }));
    const { getCachedMode } = await import("../../src/monitor/index.js");
    expect(await getCachedMode()).toBe("solo");
  });
});
