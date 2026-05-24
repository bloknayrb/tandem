import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectAndStream } from "../../src/monitor/index.js";
import {
  ControllableStream,
  createFetchStub,
  installMonitorFakeTimers,
  sseFrame,
  sseResponse,
} from "./fetch-harness.js";

describe("getCachedMode stale-preserving", () => {
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

  // --- Cold-start behavior: no successful fetch has ever landed. ---
  // The documented cold-start default is TANDEM_MODE_DEFAULT ("tandem").

  it("returns the cold-start default 'tandem' when /api/mode throws on a true cold start (network error)", async () => {
    stub.on("/api/mode", () => {
      throw new Error("ECONNREFUSED");
    });
    const { getCachedMode } = await import("../../src/monitor/index.js");
    const mode = await getCachedMode();
    expect(mode).toBe("tandem");
  });

  it("returns the cold-start default 'tandem' when /api/mode returns 500 on a true cold start", async () => {
    stub.on("/api/mode", () => new Response("err", { status: 500 }));
    const { getCachedMode } = await import("../../src/monitor/index.js");
    const mode = await getCachedMode();
    expect(mode).toBe("tandem");
  });

  it("uses the cold-start default for non-JSON / unrecognized / missing mode on cold start", async () => {
    const { getCachedMode } = await import("../../src/monitor/index.js");
    // non-JSON HTML
    stub.on(
      "/api/mode",
      () =>
        new Response("<html><body>proxy error</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    expect(await getCachedMode()).toBe("tandem");
    // unrecognized enum value
    stub.on(
      "/api/mode",
      () => new Response(JSON.stringify({ mode: "enterprise" }), { status: 200 }),
    );
    expect(await getCachedMode()).toBe("tandem");
    // missing mode field
    stub.on("/api/mode", () => new Response(JSON.stringify({}), { status: 200 }));
    expect(await getCachedMode()).toBe("tandem");
    // non-string mode
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: 42 }), { status: 200 }));
    expect(await getCachedMode()).toBe("tandem");
  });

  it("retries /api/mode on next call if previous call failed (does not poison cache timestamp)", async () => {
    let callCount = 0;
    stub.on("/api/mode", () => {
      callCount++;
      if (callCount === 1) throw new Error("transient");
      return new Response(JSON.stringify({ mode: "solo" }), { status: 200 });
    });
    const { getCachedMode } = await import("../../src/monitor/index.js");
    const first = await getCachedMode();
    expect(first).toBe("tandem"); // cold-start failure → cold-start default
    const second = await getCachedMode();
    expect(second).toBe("solo"); // retry succeeded, real mode observed
    expect(callCount).toBe(2); // cache was not poisoned by the failure
  });

  // --- Stale-preserving behavior: a real mode was observed first. ---
  // A subsequent failure must NEVER change the cached mode.

  it("preserves a previously-observed 'tandem' across a /api/mode failure (does NOT flip to solo or default)", async () => {
    let shouldFail = false;
    stub.on("/api/mode", () => {
      if (shouldFail) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ mode: "tandem" }), { status: 200 });
    });
    const { getCachedMode } = await import("../../src/monitor/index.js");
    expect(await getCachedMode()).toBe("tandem");

    // Move past the TTL so the next call actually re-fetches, then fail.
    shouldFail = true;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await getCachedMode()).toBe("tandem"); // stale-preserved, NOT "solo"/default
  });

  it("preserves a previously-observed 'solo' across a /api/mode failure (does NOT flip to default)", async () => {
    let shouldFail = false;
    stub.on("/api/mode", () => {
      if (shouldFail) return new Response("err", { status: 503 });
      return new Response(JSON.stringify({ mode: "solo" }), { status: 200 });
    });
    const { getCachedMode } = await import("../../src/monitor/index.js");
    expect(await getCachedMode()).toBe("solo");

    shouldFail = true;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await getCachedMode()).toBe("solo"); // stale-preserved, NOT the cold-start default "tandem"
  });

  it("only changes mode when the server reports a new mode (user toggled)", async () => {
    let serverMode: "tandem" | "solo" = "tandem";
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: serverMode }), { status: 200 }));
    const { getCachedMode } = await import("../../src/monitor/index.js");
    expect(await getCachedMode()).toBe("tandem");

    serverMode = "solo"; // user toggled
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await getCachedMode()).toBe("solo");
  });

  it("propagates the preserved mode to getModeSync after a mid-session failure", async () => {
    let shouldFail = false;
    stub.on("/api/mode", () => {
      if (shouldFail) throw new Error("refused");
      return new Response(JSON.stringify({ mode: "tandem" }), { status: 200 });
    });
    const mod = await import("../../src/monitor/index.js");
    await mod.getCachedMode();
    expect(mod.getModeSync()).toBe("tandem");

    shouldFail = true;
    await vi.advanceTimersByTimeAsync(2_500);
    await mod.getCachedMode();
    expect(mod.getModeSync()).toBe("tandem"); // hot path still sees the real mode
  });
});

describe("startup cache warm", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));
    stub.on("/api/channel-error", () => new Response("", { status: 200 }));
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
    exitSpy.mockRestore();
  });

  it("main() calls /api/mode once before attempting SSE connection", async () => {
    const { main } = await import("../../src/monitor/index.js");

    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "solo" }), { status: 200 }));
    stub.on("/api/events", () => {
      throw new Error("skip SSE for this test");
    });

    const mainPromise = main().catch(() => {});
    // Yield once to let the startup warm-up fetch resolve.
    await vi.advanceTimersByTimeAsync(1);

    const modeCalls = stub.calls.filter((c) => c.url.includes("/api/mode"));
    expect(modeCalls.length).toBeGreaterThanOrEqual(1);

    // Advance through full retry exhaustion
    await vi.advanceTimersByTimeAsync(5 * 30_000 + 5_000);
    await mainPromise;
  });
});

describe("background mode refresh", () => {
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

  it("event delivery is not blocked by a slow /api/mode response", async () => {
    let modeResolve: ((r: Response) => void) | undefined;
    stub.on(
      "/api/mode",
      () =>
        new Promise<Response>((resolve) => {
          modeResolve = resolve;
        }),
    );

    const stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));

    const promise = connectAndStream(
      undefined,
      () => {},
      () => {},
    );
    stream.push(
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

    // Advance time but DO NOT resolve /api/mode
    await vi.advanceTimersByTimeAsync(100);
    // stdout should already have the formatted event (cached default is
    // "tandem", non-blocking). Match the full formatter prefix from
    // formatEventContent so a regression that drops the "User opened
    // document:" prefix or the filename cannot sneak past.
    const stdoutWrites = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stdoutWrites).toMatch(/User opened document: a\.md/);

    // Now resolve mode and end the stream
    modeResolve?.(new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    stream.end();
    await promise.catch(() => {});
  });

  it("keeps cachedMode unchanged across many refreshMode failures, rate-limited", async () => {
    let modeCallCount = 0;
    let modeShouldFail = false;
    stub.on("/api/mode", () => {
      modeCallCount++;
      if (modeShouldFail) return new Response("err", { status: 500 });
      return new Response(JSON.stringify({ mode: "tandem" }), { status: 200 });
    });

    const mod = await import("../../src/monitor/index.js");
    await mod.getCachedMode();
    expect(mod.getModeSync()).toBe("tandem");
    const successCalls = modeCallCount;

    // Switch /api/mode into failure mode, then stream 10 non-chat events past
    // the TTL to exercise refreshMode repeatedly.
    modeShouldFail = true;
    const stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));
    const p = connectAndStream(undefined, () => {});

    for (let i = 0; i < 10; i++) {
      stream.push(
        sseFrame(
          {
            id: `e${i}`,
            type: "document:opened",
            timestamp: i,
            payload: { fileName: "x.md", format: "md" },
          },
          `e${i}`,
        ),
      );
      await vi.advanceTimersByTimeAsync(2500);
    }
    stream.end();
    await p.catch(() => {});

    // Stale cache preserved despite repeated refresh failures.
    expect(mod.getModeSync()).toBe("tandem");
    // Rate-limiter should keep failure fetches well below 10 (one per ~2s window).
    const failureCalls = modeCallCount - successCalls;
    expect(failureCalls).toBeLessThanOrEqual(12);
  });

  it("intermittent /api/mode during startup does not spam refreshes", async () => {
    let modeCallCount = 0;
    stub.on("/api/mode", () => {
      modeCallCount++;
      if (modeCallCount <= 5) return new Response("fail", { status: 503 });
      return new Response(JSON.stringify({ mode: "tandem" }), { status: 200 });
    });

    const mod = await import("../../src/monitor/index.js");
    await mod.getCachedMode();
    // Cold-start failure → documented cold-start default (TANDEM_MODE_DEFAULT).
    expect(mod.getModeSync()).toBe("tandem");
    expect(modeCallCount).toBe(1);

    const stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));
    const p = mod.connectAndStream(undefined, () => {});

    for (let i = 0; i < 10; i++) {
      stream.push(
        sseFrame(
          {
            id: `e${i}`,
            type: "document:opened",
            timestamp: i,
            payload: { fileName: "x.md", format: "md" },
          },
          `e${i}`,
        ),
      );
      await vi.advanceTimersByTimeAsync(500);
    }
    stream.end();
    await p.catch(() => {});

    // Rate-limiter holds refreshes to <= 6 (1 startup + at most one per 2s window over 5s).
    expect(modeCallCount).toBeLessThanOrEqual(6);
  });
});
