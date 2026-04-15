import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectAndStream, main } from "../../src/monitor/index.js";
import { CHANNEL_MAX_RETRIES } from "../../src/shared/constants.js";
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
    // Advance past the full backoff budget (2+4+8+16+30 = 60s) so main()
    // exhausts CHANNEL_MAX_RETRIES and exits via the MAX branch.
    await vi.advanceTimersByTimeAsync(200_000);
    await mainPromise;

    // process.exit(1) only fires from the MAX branch, so connectAttempts must
    // be exactly CHANNEL_MAX_RETRIES — an upper bound alone would pass for an
    // early-exit regression (e.g. inverted loop condition) that still exits 1.
    expect(connectAttempts).toBe(CHANNEL_MAX_RETRIES);
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

    // Expect at least CHANNEL_MAX_RETRIES connect attempts before exhaustion.
    expect(connectAttempts).toBeGreaterThanOrEqual(CHANNEL_MAX_RETRIES);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("retry counter resets after STABLE_CONNECTION_MS of continuous uptime", async () => {
    // Accumulate retries BEFORE the stable-uptime period so the reset has
    // something to reset. Attempts 1+2 fail (retries climbs to 2), attempt 3
    // succeeds and stays up past STABLE_CONNECTION_MS (60s) so onStable fires
    // and main() resets retries to 0. When attempt 3 ends, main's catch runs:
    //   - With the reset: retries goes 0→1, backoff = 2000ms.
    //   - Without the reset: retries would go 2→3, backoff = 8000ms.
    // Asserting that attempt 4 fires within ~2s proves the reset happened.
    const attemptTimes: number[] = [];
    let attempt = 0;
    const stream3 = new ControllableStream();
    const stream4 = new ControllableStream();
    stub.on("/api/events", () => {
      attempt++;
      attemptTimes.push(Date.now());
      if (attempt <= 2) throw new Error("refused");
      if (attempt === 3) return sseResponse(stream3);
      if (attempt === 4) return sseResponse(stream4);
      throw new Error("unexpected attempt");
    });

    const p = main().catch(() => {});

    // Drive past attempts 1+2 (backoffs 2s+4s) so attempt 3 is active.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempt).toBe(3);

    // Hold attempt 3 up past STABLE_CONNECTION_MS so onStable fires.
    await vi.advanceTimersByTimeAsync(60_500);

    stream3.end();
    const t3End = Date.now();

    // Advance slightly past the base backoff (2s). If reset worked, attempt 4
    // has fired. If reset failed silently, retries would still be 2→3, delay
    // would be 8s, and attempt 4 would not have fired yet.
    await vi.advanceTimersByTimeAsync(2_100);

    expect(attempt).toBe(4);
    const delayToAttempt4 = attemptTimes[3]! - t3End;
    expect(delayToAttempt4).toBeGreaterThanOrEqual(1900);
    expect(delayToAttempt4).toBeLessThan(3000);

    stream4.end();
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
