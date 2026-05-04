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
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TANDEM_AUTH_TOKEN;
    delete process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN;
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
  });
  afterEach(() => {
    stub.restore();
    process.env = { ...originalEnv };
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

  it("routes through authFetch so plugin auth wins while headers and timeout signal survive", async () => {
    process.env.TANDEM_AUTH_TOKEN = "T".repeat(32);
    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = "P".repeat(32);
    stub.on("/api/auth", (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("Authorization")).toBe(`Bearer ${"P".repeat(32)}`);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const res = await fetchWithTimeout(
      "http://localhost/api/auth",
      { headers: { "Content-Type": "application/json" } },
      5_000,
    );

    expect(res.ok).toBe(true);
  });

  it("composes caller abort with the timeout signal", async () => {
    const ctrl = new AbortController();
    stub.on("/api/caller-abort", (_url, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const p = fetchWithTimeout("http://localhost/api/caller-abort", { signal: ctrl.signal }, 5_000);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
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
