/**
 * Regression guard: the `/api/events` SSE keepalive write must not crash the
 * server on a broken socket.
 *
 * On an abruptly-closed connection (client SIGKILL / network drop) the periodic
 * `res.write(": keepalive")` throws EPIPE/ECONNRESET. Because that write runs
 * inside a `setInterval` callback, an unwrapped throw becomes an *uncaught*
 * exception — and EPIPE/ECONNRESET are not known-Hocuspocus errors, so the
 * server's `handleFatalError` would `process.exit(1)` the whole process. The
 * fix wraps the keepalive write (mirroring the browser notify-stream handler)
 * and tears the subscriber down instead. This test pins that: a throwing
 * keepalive must be swallowed and must clean up, never propagate.
 */

import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_SSE_KEEPALIVE_MS } from "../../src/shared/constants.js";

const { subscribeSpy, unsubscribeSpy } = vi.hoisted(() => ({
  subscribeSpy: vi.fn(),
  unsubscribeSpy: vi.fn(),
}));

vi.mock("../../src/server/events/queue.js", () => ({
  subscribe: subscribeSpy,
  unsubscribe: unsubscribeSpy,
  replaySince: vi.fn(() => []),
}));

import { sseHandler } from "../../src/server/events/sse.js";

function makeReq(): Request {
  return { headers: {}, on: vi.fn() } as unknown as Request;
}

/** A `res` whose keepalive write throws EPIPE, like a dead socket. */
function makeThrowingRes(): { res: Response; write: ReturnType<typeof vi.fn> } {
  const write = vi.fn((chunk: string) => {
    if (chunk.includes("keepalive")) {
      const err = new Error("write EPIPE") as NodeJS.ErrnoException;
      err.code = "EPIPE";
      throw err;
    }
    return true;
  });
  const res = { writeHead: vi.fn(), write, writableEnded: false } as unknown as Response;
  return { res, write };
}

describe("/api/events keepalive is crash-safe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    subscribeSpy.mockClear();
    unsubscribeSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not propagate a throwing keepalive write (would crash the server)", () => {
    const { res } = makeThrowingRes();
    sseHandler(makeReq(), res);

    // The regression: firing the keepalive interval must NOT throw out of the
    // callback. Before the fix, the unguarded write's EPIPE escaped here.
    expect(() => vi.advanceTimersByTime(CHANNEL_SSE_KEEPALIVE_MS)).not.toThrow();
  });

  it("tears down the subscriber when the keepalive write fails", () => {
    const { res } = makeThrowingRes();
    sseHandler(makeReq(), res);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    const registered = subscribeSpy.mock.calls[0][0];

    vi.advanceTimersByTime(CHANNEL_SSE_KEEPALIVE_MS);

    // cleanup() ran: the exact subscriber callback was unsubscribed...
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(unsubscribeSpy).toHaveBeenCalledWith(registered);
  });

  it("clears the interval on failure so it does not fire again", () => {
    const { res, write } = makeThrowingRes();
    sseHandler(makeReq(), res);

    vi.advanceTimersByTime(CHANNEL_SSE_KEEPALIVE_MS);
    const keepaliveWrites = write.mock.calls.filter((c) =>
      String(c[0]).includes("keepalive"),
    ).length;

    // Advancing further must not produce another keepalive write — the interval
    // was cleared by cleanup(), not left running to throw every tick.
    vi.advanceTimersByTime(CHANNEL_SSE_KEEPALIVE_MS * 3);
    const after = write.mock.calls.filter((c) => String(c[0]).includes("keepalive")).length;
    expect(after).toBe(keepaliveWrites);
  });

  it("keeps the subscriber alive when keepalive writes succeed", () => {
    const write = vi.fn(() => true);
    const res = { writeHead: vi.fn(), write, writableEnded: false } as unknown as Response;
    sseHandler(makeReq(), res);

    vi.advanceTimersByTime(CHANNEL_SSE_KEEPALIVE_MS * 3);

    // Healthy connection: no teardown, and keepalives were actually written.
    expect(unsubscribeSpy).not.toHaveBeenCalled();
    expect(write.mock.calls.some((c) => String(c[0]).includes("keepalive"))).toBe(true);
  });

  it("does not write a keepalive once the response has ended", () => {
    const write = vi.fn(() => true);
    const res = { writeHead: vi.fn(), write, writableEnded: true } as unknown as Response;
    sseHandler(makeReq(), res);

    vi.advanceTimersByTime(CHANNEL_SSE_KEEPALIVE_MS * 2);
    expect(write.mock.calls.some((c) => String(c[0]).includes("keepalive"))).toBe(false);
  });
});
