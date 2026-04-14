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

    // Force a cache miss by not setting cachedModeAt recently
    const { getCachedMode } = await import("../../src/monitor/index.js");
    const modePromise = getCachedMode();
    // Advance past the 2000ms mode-check timeout
    await vi.advanceTimersByTimeAsync(2500);
    const mode = await modePromise;
    // Note: Current getCachedMode still fail-open — B3 will change it to fail-closed.
    // This test just validates that the fetch is actually aborted (not hanging forever).
    // The mode value here will be whatever the current default is.
    expect(mode).toBe("solo");
  });
});
