import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchStub, installMonitorFakeTimers } from "./fetch-harness.js";

describe("fetch timeout", () => {
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

  it("aborts a hung /api/mode fetch via AbortSignal.timeout and falls back to solo", async () => {
    stub.on("/api/mode", (_url, init) => {
      const signal = init?.signal;
      // Return a promise that never resolves unless aborted
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const { getCachedMode } = await import("../../src/monitor/index.js");
    const modePromise = getCachedMode();
    // Advance past the 2000ms mode-check timeout
    await vi.advanceTimersByTimeAsync(2500);
    const mode = await modePromise;
    expect(mode).toBe("solo");
  });
});

describe("mode cache under clock skew", () => {
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
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("backward Date.now() jump does not wedge the mode cache permanently", async () => {
    // The /api/mode handler lives in the test body (not beforeEach) so we can
    // flip its response mid-test and distinguish "cache wedged, no refetch"
    // from "cache recovered via refetch" by the returned value.
    let currentMode: "tandem" | "solo" = "tandem";
    let modeCallCount = 0;
    stub.on("/api/mode", () => {
      modeCallCount++;
      return new Response(JSON.stringify({ mode: currentMode }), { status: 200 });
    });

    const mod = await import("../../src/monitor/index.js");
    expect(await mod.getCachedMode()).toBe("tandem");
    expect(modeCallCount).toBe(1);

    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() - 60 * 60 * 1000);

    // Under backward skew, (now - cachedModeAt) is negative, so the TTL check
    // treats the cache as still fresh and no refetch fires. Stuck but safe.
    await vi.advanceTimersByTimeAsync(5000);
    expect(await mod.getCachedMode()).toBe("tandem");
    expect(modeCallCount).toBe(1);

    // Restore the clock and flip the server response. A working recovery path
    // must re-fetch and observe the new value; a wedged cache returns stale
    // "tandem" and fails the assertion.
    vi.restoreAllMocks();
    currentMode = "solo";
    await vi.advanceTimersByTimeAsync(3000);
    expect(await mod.getCachedMode()).toBe("solo");
    expect(modeCallCount).toBe(2);
  });
});
