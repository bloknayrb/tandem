/**
 * Behavior test for the `tandem_reply` AbortError re-throw (#364).
 *
 * Reproduces the silent-failure pattern: `fetchWithTimeout` resolves with a
 * Response (headers landed) but `res.json()` hangs and the AbortSignal fires
 * during the body read. Before #364, a bare `catch {}` swallowed the
 * AbortError and reported `data = { message: "Non-JSON response" }` with
 * `res.ok === true` — a fake-success returned to Claude with no `isError`.
 *
 * This test reproduces the run.ts handler logic in isolation (the handler
 * body is not exported) and asserts that the AbortError surfaces as a
 * structured `isError: true` response, not a fake-success.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeFetchError,
  fetchWithTimeout,
  isAbortOrTimeoutError,
} from "../../src/shared/fetch-with-timeout.js";
import { createFetchStub, installMonitorFakeTimers } from "../monitor/fetch-harness.js";

/** Reproduce the run.ts tandem_reply call+parse logic. Kept tight to the
 *  catch shape we're guarding so a future regression in run.ts has a
 *  matching regression here. */
async function callReplyLike(
  url: string,
  args: unknown,
  timeoutMs: number,
): Promise<{ isError?: boolean; text: string }> {
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      },
      timeoutMs,
    );
    let data: unknown;
    try {
      data = await res.json();
    } catch (parseErr) {
      if (isAbortOrTimeoutError(parseErr)) throw parseErr;
      data = { message: "Non-JSON response" };
    }
    if (!res.ok) {
      return { isError: true, text: `Reply failed (${res.status}): ${JSON.stringify(data)}` };
    }
    return { text: JSON.stringify(data) };
  } catch (err) {
    return {
      isError: true,
      text: `Failed to send reply: ${describeFetchError(err, "/api/channel-reply", timeoutMs)}`,
    };
  }
}

describe("tandem_reply AbortError handling", () => {
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

  it("surfaces a body-side timeout as isError (not fake-success Non-JSON response)", async () => {
    // Headers land immediately so the caller enters res.json(); the body
    // ReadableStream is bound to the AbortSignal, which fires when
    // AbortSignal.timeout expires.
    stub.on("/api/channel-reply", (_url, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // Abort plumbs through to controller.error so res.json() rejects.
          signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "TimeoutError"));
          });
          // Never enqueue, never close — the body just hangs.
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const p = callReplyLike("http://localhost/api/channel-reply", { text: "hi" }, 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await p;

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/timed out after 1000ms/);
    // The fake-success path would report this string instead.
    expect(result.text).not.toMatch(/Non-JSON response/);
  });

  it("returns isError on connection-level timeout before headers arrive", async () => {
    stub.on("/api/channel-reply", (_url, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "TimeoutError"));
        });
      });
    });

    const p = callReplyLike("http://localhost/api/channel-reply", { text: "hi" }, 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await p;

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/\/api\/channel-reply timed out after 1000ms/);
  });

  it("returns success payload on normal 200 JSON response", async () => {
    stub.on("/api/channel-reply", () => {
      return new Response(JSON.stringify({ ok: true, id: "abc" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const result = await callReplyLike("http://localhost/api/channel-reply", { text: "hi" }, 5_000);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toEqual({ ok: true, id: "abc" });
  });
});
