import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectAndStream, main } from "../../src/monitor/index.js";
import {
  ControllableStream,
  createFetchStub,
  installMonitorFakeTimers,
  sseFrame,
  sseResponse,
} from "./fetch-harness.js";

describe("retry counter semantics", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));
    stub.on("/api/channel-error", () => new Response("", { status: 200 }));
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("exits after MAX retries even when each attempt produces a single event first", async () => {
    let connectAttempts = 0;
    stub.on("/api/events", () => {
      connectAttempts++;
      const s = new ControllableStream();
      // Emit one event then immediately die
      setTimeout(() => {
        s.push(
          sseFrame(
            {
              id: `evt_${connectAttempts}`,
              type: "chat:message",
              timestamp: 1,
              payload: { messageId: "m", text: "hi", replyTo: null, anchor: null },
            },
            `evt_${connectAttempts}`,
          ),
        );
        s.error(new Error("stream died"));
      }, 0);
      return sseResponse(s);
    });

    const mainPromise = main().catch(() => {});
    // Advance through 5 retry cycles (each with 2s+ delay, growing with backoff in B7)
    await vi.advanceTimersByTimeAsync(200_000);
    await mainPromise;

    // With the old bug, this would loop forever. With the fix, max 5 attempts.
    expect(connectAttempts).toBeLessThanOrEqual(6); // CHANNEL_MAX_RETRIES is 5
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("writes a monitor:exit notification to stdout before process.exit(1)", async () => {
    stub.on("/api/events", () => {
      throw new Error("refused");
    });

    const mainPromise = main().catch(() => {});
    await vi.advanceTimersByTimeAsync(200_000);
    await mainPromise;

    const stdoutCalls = stdoutSpy.mock.calls.map((c) => String(c[0]));
    const exitLine = stdoutCalls.find(
      (s) => s.includes("monitor:exit") || s.includes("Tandem monitor disconnected"),
    );
    expect(exitLine).toBeDefined();
  });

  it("retries on a 503 from /api/events (non-ok response, not a thrown error)", async () => {
    let connectAttempts = 0;
    stub.on("/api/events", () => {
      connectAttempts++;
      return new Response("unavailable", { status: 503 });
    });

    const mainPromise = main().catch(() => {});
    await vi.advanceTimersByTimeAsync(200_000);
    await mainPromise;

    // CHANNEL_MAX_RETRIES = 5; expect at least that many connect attempts.
    expect(connectAttempts).toBeGreaterThanOrEqual(5);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("retry counter resets after STABLE_CONNECTION_MS of continuous uptime", async () => {
    let attempt = 0;
    const stream1 = new ControllableStream();
    const stream2 = new ControllableStream();
    stub.on("/api/events", () => {
      attempt++;
      if (attempt === 1) return sseResponse(stream1);
      if (attempt === 2) return sseResponse(stream2);
      throw new Error("unexpected attempt");
    });

    const p = main().catch(() => {});

    await vi.advanceTimersByTimeAsync(10);
    stream1.push(
      sseFrame(
        {
          id: "e1",
          type: "document:opened",
          timestamp: 1,
          payload: { fileName: "a.md", format: "md" },
        },
        "e1",
      ),
    );

    // Past STABLE_CONNECTION_MS (60s) — onStable resets retries to 0.
    await vi.advanceTimersByTimeAsync(60_500);

    stream1.end();
    // Second attempt should fire after the initial 2s delay, not 30s (cap).
    await vi.advanceTimersByTimeAsync(2_100);

    expect(attempt).toBe(2);

    stream2.end();
    // Drain remaining retries so main() exits via the MAX branch.
    await vi.advanceTimersByTimeAsync(200_000);
    await p;
  });

  it("503 response does not leak handshake/stable/watchdog timers", async () => {
    const beforeTimerCount = vi.getTimerCount();
    stub.on("/api/events", () => new Response("", { status: 503 }));

    await connectAndStream(undefined, () => {}).catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(beforeTimerCount);
  });
});

describe("exponential backoff", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));
    stub.on("/api/channel-error", () => new Response("", { status: 200 }));
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("sleeps 2^(n-1) * base between retries, capped at max", async () => {
    const attemptTimes: number[] = [];
    const start = Date.now();

    stub.on("/api/events", () => {
      attemptTimes.push(Date.now() - start);
      throw new Error("refused");
    });

    const mainPromise = main().catch(() => {});
    await vi.advanceTimersByTimeAsync(200_000);
    await mainPromise;

    // Expected delays between attempts: ~2000, ~4000, ~8000, ~16000 (capped at 30000)
    const deltas = attemptTimes.slice(1).map((t, i) => t - attemptTimes[i]!);
    expect(deltas[0]).toBeGreaterThanOrEqual(1900);
    expect(deltas[0]).toBeLessThan(3000);
    expect(deltas[1]).toBeGreaterThanOrEqual(3900);
    expect(deltas[1]).toBeLessThan(5000);
    expect(deltas[2]).toBeGreaterThanOrEqual(7900);
    expect(deltas[2]).toBeLessThan(9000);
  });
});
