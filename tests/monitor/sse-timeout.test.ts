import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectAndStream } from "../../src/monitor/index.js";
import {
  ControllableStream,
  createFetchStub,
  installMonitorFakeTimers,
  sseFrame,
  sseResponse,
} from "./fetch-harness.js";

describe("SSE handshake vs stream timeout", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
    stdoutSpy.mockRestore();
  });

  it("aborts the handshake if the fetch call hasn't returned within CONNECT_FETCH_TIMEOUT_MS", async () => {
    stub.on("/api/events", (_url, init) => {
      // Reject when aborted. Attach catch synchronously below so the rejection
      // is never "unhandled" even if it fires during fake-timer advancement.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const promise = connectAndStream(undefined, () => {});
    const rejected = promise.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(11_000);
    const err = (await rejected) as Error;
    expect(err).toBeInstanceOf(Error);
  });

  it("does NOT abort an active stream at 10s (handshake timeout no longer governs body)", async () => {
    const stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));

    const onEventId = vi.fn();
    const promise = connectAndStream(undefined, onEventId);

    // Emit a frame at t=0
    stream.push(
      sseFrame(
        {
          id: "first",
          type: "chat:message",
          timestamp: 1,
          payload: { messageId: "m", text: "hi", replyTo: null, anchor: null },
        },
        "first",
      ),
    );
    // Advance past the old 10s handshake budget — stream must still be alive.
    await vi.advanceTimersByTimeAsync(15_000);
    // Keep the stream fed before the 60s inactivity watchdog triggers.
    stream.push(
      sseFrame(
        {
          id: "second",
          type: "chat:message",
          timestamp: 2,
          payload: { messageId: "m2", text: "hi2", replyTo: null, anchor: null },
        },
        "second",
      ),
    );
    await vi.advanceTimersByTimeAsync(100);
    stream.end();
    await promise.catch(() => {});

    expect(onEventId).toHaveBeenCalledWith("first");
    expect(onEventId).toHaveBeenCalledWith("second");
  });

  it("cancels the stream after SSE_INACTIVITY_TIMEOUT_MS (60s) with no bytes", async () => {
    const stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));

    const promise = connectAndStream(undefined, () => {});
    // Prevent the outer rejection from being logged as unhandled while we wait
    // for the watchdog to fire inside advanceTimersByTimeAsync.
    const rejected = promise.catch((err: unknown) => err);

    // Emit one frame so the handshake completes and the reader starts.
    stream.push(
      sseFrame(
        {
          id: "only",
          type: "chat:message",
          timestamp: 1,
          payload: { messageId: "m", text: "hi", replyTo: null, anchor: null },
        },
        "only",
      ),
    );
    // Let the frame be consumed, then wait out the inactivity window.
    // Advance in small chunks so the watchdog's setInterval callbacks have
    // time to flush their microtasks between ticks.
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(10_000);

    const err = await rejected;
    expect(String((err as Error).message ?? err)).toMatch(/inactivity/i);
  }, 15_000);

  it("keeps the stream alive while frames arrive at 30s intervals for 3 minutes", async () => {
    const stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));

    const onEventId = vi.fn();
    const promise = connectAndStream(undefined, onEventId);

    for (let i = 0; i < 6; i++) {
      stream.push(
        sseFrame(
          {
            id: `e${i}`,
            type: "chat:message",
            timestamp: i,
            payload: { messageId: `m${i}`, text: "hi", replyTo: null, anchor: null },
          },
          `e${i}`,
        ),
      );
      await vi.advanceTimersByTimeAsync(30_000);
    }

    stream.end();
    await promise.catch(() => {});

    // All six frames observed (watchdog never fired).
    for (let i = 0; i < 6; i++) {
      expect(onEventId).toHaveBeenCalledWith(`e${i}`);
    }
  });
});
