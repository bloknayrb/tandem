import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectAndStream } from "../../src/monitor/index.js";
import {
  ControllableStream,
  createFetchStub,
  installMonitorFakeTimers,
  sseFrame,
  sseResponse,
} from "./fetch-harness.js";

describe("getCachedMode fail-closed", () => {
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

  it("returns 'solo' when /api/mode throws (network error)", async () => {
    stub.on("/api/mode", () => {
      throw new Error("ECONNREFUSED");
    });
    const { getCachedMode } = await import("../../src/monitor/index.js");
    const mode = await getCachedMode();
    expect(mode).toBe("solo");
  });

  it("returns 'solo' when /api/mode returns 500", async () => {
    stub.on("/api/mode", () => new Response("err", { status: 500 }));
    const { getCachedMode } = await import("../../src/monitor/index.js");
    const mode = await getCachedMode();
    expect(mode).toBe("solo");
  });

  it("retries /api/mode on next call if previous call failed (does not poison cache timestamp)", async () => {
    let callCount = 0;
    stub.on("/api/mode", () => {
      callCount++;
      if (callCount === 1) throw new Error("transient");
      return new Response(JSON.stringify({ mode: "tandem" }), { status: 200 });
    });
    const { getCachedMode } = await import("../../src/monitor/index.js");
    const first = await getCachedMode();
    expect(first).toBe("solo"); // failed call → fail closed
    const second = await getCachedMode();
    expect(second).toBe("tandem"); // retry succeeded
    expect(callCount).toBe(2); // cache was not poisoned
  });

  it("propagates fail-closed to getModeSync (hot path sees 'solo' after startup failure)", async () => {
    stub.on("/api/mode", () => {
      throw new Error("refused");
    });
    const mod = await import("../../src/monitor/index.js");
    await mod.getCachedMode();
    expect(mod.getModeSync()).toBe("solo");
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
    // stdout should already have the event (cached default is "tandem", non-blocking)
    expect(stdoutSpy).toHaveBeenCalled();

    // Now resolve mode and end the stream
    modeResolve?.(new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    stream.end();
    await promise.catch(() => {});
  });
});
