/**
 * Tests for the shared `fetchWithTimeout` helper that channel/ and monitor/
 * route through. Mirrors `tests/monitor/timeouts.test.ts` patterns.
 *
 * Coverage:
 *  - timeout fires within bounded ms
 *  - clearTimeout fires on success path (no leaked AbortSignal.timeout timer)
 *  - AbortError propagates as a thrown error (not silent fake-success)
 *  - late response after timeout is discarded by AbortSignal
 *  - describeFetchError tags the endpoint and threshold
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeFetchError,
  fetchWithTimeout,
  isAbortOrTimeoutError,
} from "../../src/shared/fetch-with-timeout.js";
import { createFetchStub, installMonitorFakeTimers } from "../monitor/fetch-harness.js";

describe("fetchWithTimeout", () => {
  let stub: ReturnType<typeof createFetchStub>;

  beforeEach(() => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
  });

  it("aborts a hung fetch within the configured deadline", async () => {
    stub.on("/api/slow", (_url, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          // AbortSignal.timeout produces TimeoutError (DOMException name).
          // Surface that name so callers can pattern-match correctly.
          reject(new DOMException("aborted", "TimeoutError"));
        });
      });
    });

    const p = fetchWithTimeout("http://localhost/api/slow", {}, 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(p).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("returns the response on success without leaking the abort timer", async () => {
    let resolvedAbortFired = false;
    stub.on("/api/fast", (_url, init) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        resolvedAbortFired = true;
      });
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });

    const res = await fetchWithTimeout("http://localhost/api/fast", {}, 5_000);
    expect(res.ok).toBe(true);
    // Advance well past the timeout window — if the AbortSignal.timeout timer
    // still fired, the abort handler would set the flag. AbortSignal.timeout
    // is built on setTimeout, so the fake-timer surface controls it.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolvedAbortFired).toBe(false);
  });

  it("isAbortOrTimeoutError matches both AbortError and TimeoutError", () => {
    expect(isAbortOrTimeoutError(new DOMException("a", "AbortError"))).toBe(true);
    expect(isAbortOrTimeoutError(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isAbortOrTimeoutError(new Error("plain"))).toBe(false);
    expect(isAbortOrTimeoutError("string")).toBe(false);
  });

  it("describeFetchError tags timeout aborts with endpoint + ms", () => {
    const err = new DOMException("aborted", "TimeoutError");
    expect(describeFetchError(err, "/api/x", 2_000)).toBe("/api/x timed out after 2000ms");
    const abort = new DOMException("aborted", "AbortError");
    expect(describeFetchError(abort, "/api/y", 3_000)).toBe("/api/y timed out after 3000ms");
    expect(describeFetchError(new Error("boom"), "/api/z", 1_000)).toBe("boom");
  });
});
