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

/** The `/api/channel-error` bodies the consumer has POSTed so far. */
function errorReportBodies(stub: ReturnType<typeof createFetchStub>): Array<{ error?: string }> {
  return stub.calls
    .filter((c) => c.url.includes("/api/channel-error"))
    .map((c) => JSON.parse(String(c.init?.body ?? "{}")) as { error?: string });
}

describe("retry counter semantics", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("keeps retrying past MAX and reports once, on a connect-then-die stream", async () => {
    // The stub is unchanged from when this spec asserted the exit: each attempt
    // emits one event and then dies. It is the only *connect*-then-fail shape
    // in the suite, and so the only one that can catch a latch cleared on the
    // handshake rather than on `onStable` — under a fail-always stub that
    // regression is invisible, because `everConnected` never goes true.
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

    void main().catch(() => {});
    // Well past the old 2+4+8+16+30 budget: at the 30s cap this is ~10 cycles.
    await vi.advanceTimersByTimeAsync(200_000);
    await vi.advanceTimersByTimeAsync(0);

    // Capture before any assertion: the loop never settles, so a spec that
    // asserts against the live counters races its own teardown.
    const attempts = connectAttempts;
    const reports = errorReportBodies(stub);
    const stdoutCalls: string[] = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));

    expect(attempts).toBeGreaterThanOrEqual(8);
    // An upper bound alone would pass for a fix that still exits.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.error).toBe("MONITOR_CONNECT_FAILED");
    // Matched on the notice's own phrase, not `tandem_checkInbox`: the
    // per-event line this stub also produces contains that phrase too.
    expect(stdoutCalls.filter((s) => /retrying in the background/.test(s))).toHaveLength(1);
  });

  // Contract narrowed deliberately: the stdout notice is conditional on having
  // connected at least once. Here the server was never reachable, so there is
  // nothing to report — the line says a connection was lost, and none was ever
  // made. (The original justification also leaned on the host
  // arming this monitor in every session; #1354 replaced `when: "always"` with
  // `on-skill-invoke`, so that half no longer holds — see the note in
  // `src/monitor/run.ts` for why the contract survives without it.)
  // `tests/monitor/index.test.ts` covers the connected-then-dropped case,
  // where the notice DOES fire.
  it("stays silent on stdout when it never connected, and keeps retrying", async () => {
    let connectAttempts = 0;
    stub.on("/api/events", () => {
      connectAttempts++;
      throw new Error("refused");
    });

    void main().catch(() => {});
    await vi.advanceTimersByTimeAsync(200_000);
    await vi.advanceTimersByTimeAsync(0);

    const attempts = connectAttempts;
    const stdoutCalls: string[] = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    // Matched on the new notice's phrases, not the retired "disconnected"
    // wording — that would go vacuous and leave the `!everConnected` guard
    // pinned by nothing.
    expect(stdoutCalls.find((s) => /retrying in the background/.test(s))).toBeUndefined();
    expect(stdoutCalls.find((s) => /tandem_checkInbox/.test(s))).toBeUndefined();
    expect(attempts).toBeGreaterThanOrEqual(8);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("retries on a 503 from /api/events (non-ok response, not a thrown error)", async () => {
    let connectAttempts = 0;
    stub.on("/api/events", () => {
      connectAttempts++;
      return new Response("unavailable", { status: 503 });
    });

    void main().catch(() => {});
    await vi.advanceTimersByTimeAsync(200_000);
    await vi.advanceTimersByTimeAsync(0);

    const attempts = connectAttempts;
    // Expect at least CHANNEL_MAX_RETRIES connect attempts.
    expect(attempts).toBeGreaterThanOrEqual(CHANNEL_MAX_RETRIES);
    expect(exitSpy).not.toHaveBeenCalled();
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

    void main().catch(() => {});

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
    await vi.advanceTimersByTimeAsync(0);
  });

  it("reports again on a second outage once a recovery survived STABLE_CONNECTION_MS", async () => {
    // Kills a latch that is set and never cleared. Its anti-flap other half is
    // the connect-then-die spec above, where `onStable` never fires and the
    // report must stay at one.
    let attempt = 0;
    const healthy = new ControllableStream();
    stub.on("/api/events", () => {
      attempt++;
      // A first connection that dies at once, so the run HAS connected and
      // what follows is a real outage — not a never-connected start, whose
      // latch the first handshake resets on its own (the spec below).
      if (attempt === 1) {
        const s = new ControllableStream();
        setTimeout(() => s.error(new Error("stream died")), 0);
        return sseResponse(s);
      }
      // Six failures, then a stream held open long enough for onStable.
      if (attempt <= CHANNEL_MAX_RETRIES + 2) throw new Error("refused");
      if (attempt === CHANNEL_MAX_RETRIES + 3) return sseResponse(healthy);
      throw new Error("refused again");
    });

    void main().catch(() => {});
    // 2+4+8+16+30+30+30 = 120s of backoff before the eighth connect.
    await vi.advanceTimersByTimeAsync(125_000);
    expect(errorReportBodies(stub)).toHaveLength(1);

    // Hold it up past STABLE_CONNECTION_MS (60s) so onStable clears the latch.
    await vi.advanceTimersByTimeAsync(60_500);
    const stderrAfterRecovery: string[] = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(stderrAfterRecovery.filter((s) => /SSE connection restored/.test(s))).toHaveLength(1);
    // Nothing was latched when the run first connected, so the transition
    // line — written only to close a never-connected report — did not fire.
    expect(stderrAfterRecovery.filter((s) => /SSE connection established/.test(s))).toHaveLength(0);

    // No explicit `end()`: the inactivity watchdog shares the 60s deadline and
    // cancels this quiet stream immediately after `onStable`, which is exactly
    // the second outage this spec needs.
    await vi.advanceTimersByTimeAsync(200_000);
    await vi.advanceTimersByTimeAsync(0);

    const reports = errorReportBodies(stub);
    const stderrCalls: string[] = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(reports).toHaveLength(2);
    // The per-failure lines resume after the latch clears.
    expect(stderrCalls.filter((s) => /SSE connection failed/.test(s)).length).toBeGreaterThan(
      CHANNEL_MAX_RETRIES,
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("reports the first real loss after a never-connected start, even inside STABLE_CONNECTION_MS", async () => {
    // Tandem was not running when the monitor armed: six refused connects set
    // the once-per-outage latch with a report the monitor swallows
    // (`everConnected` false). Then the server appears and dies on every
    // connect before it can survive 60s, so `onStable` never fires. Without a
    // reset on the never→connected transition the latch is still set and
    // `retries` still past the threshold, so this — the first outage the user
    // can feel — reports nothing: no POST, no notice, no stderr line.
    let attempt = 0;
    stub.on("/api/events", () => {
      attempt++;
      if (attempt <= CHANNEL_MAX_RETRIES + 1) throw new Error("refused");
      const s = new ControllableStream();
      setTimeout(() => {
        s.push(
          sseFrame(
            {
              id: `evt_${attempt}`,
              type: "chat:message",
              timestamp: 1,
              payload: { messageId: "m", text: "hi", replyTo: null, anchor: null },
            },
            `evt_${attempt}`,
          ),
        );
        s.error(new Error("stream died"));
      }, 0);
      return sseResponse(s);
    });

    void main().catch(() => {});
    // 2+4+8+16+30+30 = 90s before the first connect, then a fresh ladder
    // (2+4+8+16+30 = 60s) before the connected-then-lost report.
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.advanceTimersByTimeAsync(0);

    const reports = errorReportBodies(stub);
    const stdoutCalls: string[] = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const stderrCalls: string[] = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    // One swallowed never-connected report, then one real one.
    expect(reports).toHaveLength(2);
    expect(stdoutCalls.filter((s) => /retrying in the background/.test(s))).toHaveLength(1);
    // The transition is announced once, and only because a report was latched.
    expect(stderrCalls.filter((s) => /SSE connection established/.test(s))).toHaveLength(1);
    expect(exitSpy).not.toHaveBeenCalled();
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

    void main().catch(() => {});
    await vi.advanceTimersByTimeAsync(200_000);
    await vi.advanceTimersByTimeAsync(0);

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
