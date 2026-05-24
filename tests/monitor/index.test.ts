/**
 * Pinning tests for src/monitor/index.ts.
 *
 * Written ahead of the #282 extraction so refactor regressions surface
 * immediately. The richer behavior coverage lives in the existing
 * sse-parsing / retry / mode-cache / solo-filter / shutdown / timeouts
 * suites. This file focuses on the contract that must survive when
 * the SSE consumer moves to src/shared/sse-consumer.ts:
 *   - per-event stdout delivery (newlines collapsed, formatEventContent)
 *   - eventId order: stdout.write must precede onEventId
 *   - solo-mode suppression of non-chat events
 *   - awareness POSTs flow through the shared awareness machinery
 *   - retry exhaustion writes MONITOR_CONNECT_FAILED + emits the stdout
 *     "monitor disconnected" notice
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_MAX_RETRIES } from "../../src/shared/constants.js";
import {
  ControllableStream,
  createFetchStub,
  installMonitorFakeTimers,
  sseFrame,
  sseResponse,
} from "./fetch-harness.js";

describe("monitor: per-event stdout delivery", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stream: ControllableStream;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
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

  it("writes formatEventContent + newline to stdout per delivered event", async () => {
    const { connectAndStream } = await import("../../src/monitor/index.js");
    const promise = connectAndStream(undefined, () => {});

    stream.push(
      sseFrame(
        {
          id: "evt_chat",
          type: "chat:message",
          timestamp: 1,
          payload: { messageId: "m1", text: "hello world", replyTo: null, anchor: null },
        },
        "evt_chat",
      ),
    );
    stream.end();
    await promise.catch(() => {});

    const writes = stdoutSpy.mock.calls.map((c) => String(c[0]));
    const matched = writes.find((w) => w.includes("hello world"));
    expect(matched).toBeDefined();
    expect(matched!.endsWith("\n")).toBe(true);
  });

  it("collapses embedded newlines so each event remains a single stdout line", async () => {
    const { connectAndStream } = await import("../../src/monitor/index.js");
    const promise = connectAndStream(undefined, () => {});

    stream.push(
      sseFrame(
        {
          id: "evt_multi",
          type: "chat:message",
          timestamp: 1,
          payload: { messageId: "m1", text: "line1\nline2\nline3", replyTo: null, anchor: null },
        },
        "evt_multi",
      ),
    );
    stream.end();
    await promise.catch(() => {});

    const writes = stdoutSpy.mock.calls.map((c) => String(c[0]));
    const matched = writes.find((w) => w.includes("line1"));
    expect(matched).toBeDefined();
    // No internal newlines (only the trailing one).
    expect(matched!.slice(0, -1).includes("\n")).toBe(false);
  });

  it("eventId advances ONLY after stdout.write completes (order regression fence)", async () => {
    stdoutSpy.mockImplementationOnce(() => {
      throw new Error("EPIPE");
    });
    const { connectAndStream } = await import("../../src/monitor/index.js");
    const onEventId = vi.fn();
    const promise = connectAndStream(undefined, onEventId);

    stream.push(
      sseFrame(
        {
          id: "evt_will_fail",
          type: "chat:message",
          timestamp: 1,
          payload: { messageId: "m1", text: "hi", replyTo: null, anchor: null },
        },
        "evt_will_fail",
      ),
    );
    await expect(promise).rejects.toThrow("EPIPE");
    expect(onEventId).not.toHaveBeenCalledWith("evt_will_fail");
  });
});

describe("monitor: solo-mode suppression", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stream: ControllableStream;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "solo" }), { status: 200 }));
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

  it("suppresses non-chat events when mode is solo", async () => {
    const { connectAndStream, getCachedMode } = await import("../../src/monitor/index.js");
    const onEventId = vi.fn();
    const promise = connectAndStream(undefined, onEventId);
    await getCachedMode(); // pre-warm cache so getModeSync sees 'solo'

    stream.push(
      sseFrame(
        {
          id: "evt_open",
          type: "document:opened",
          timestamp: 1,
          payload: { fileName: "x.md", format: "md" },
        },
        "evt_open",
      ),
    );
    stream.end();
    await promise.catch(() => {});

    expect(stdoutSpy).not.toHaveBeenCalled();
    // Suppressed events still advance eventId so reconnect doesn't re-deliver
    expect(onEventId).toHaveBeenCalledWith("evt_open");
  });
});

describe("monitor: mode is stale-preserving across /api/mode failure", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stream: ControllableStream;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let modeShouldFail: boolean;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    stream = new ControllableStream();
    modeShouldFail = false;
    stub.on("/api/events", () => sseResponse(stream));
    // First call succeeds with "tandem"; once modeShouldFail flips, /api/mode
    // hard-fails. The directive: a transient failure must NOT flip the mode.
    stub.on("/api/mode", () => {
      if (modeShouldFail) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ mode: "tandem" }), { status: 200 });
    });
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

  it("keeps delivering non-chat events after /api/mode starts failing (mode stays 'tandem', NOT flipped to solo)", async () => {
    const { connectAndStream, getCachedMode, getModeSync } = await import(
      "../../src/monitor/index.js"
    );
    // Observe the real mode "tandem" first.
    await getCachedMode();
    expect(getModeSync()).toBe("tandem");

    const promise = connectAndStream(undefined, () => {});

    // /api/mode now fails on every subsequent fetch. The background
    // refresh on the non-chat hot path will fail repeatedly.
    modeShouldFail = true;

    // Push a non-chat event past the mode-cache TTL so refreshMode fires.
    await vi.advanceTimersByTimeAsync(2_500);
    stream.push(
      sseFrame(
        {
          id: "evt_open",
          type: "document:opened",
          timestamp: 1,
          payload: { fileName: "x.md", format: "md" },
        },
        "evt_open",
      ),
    );
    await vi.advanceTimersByTimeAsync(50);

    // Mode preserved as "tandem" — the non-chat event was NOT suppressed.
    const writes = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(writes).toMatch(/User opened document: x\.md/);
    expect(getModeSync()).toBe("tandem");

    stream.end();
    await promise.catch(() => {});
    expect(getModeSync()).toBe("tandem"); // never flipped to "solo"/default
  });
});

describe("monitor: awareness POSTs", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stream: ControllableStream;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let awarenessCalls: Array<{ documentId: string | null; status: string; active: boolean }>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    stream = new ControllableStream();
    awarenessCalls = [];
    stub.on("/api/events", () => sseResponse(stream));
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    stub.on("/api/channel-awareness", (_url, init) => {
      awarenessCalls.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("", { status: 200 });
    });
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
  });

  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
    stdoutSpy.mockRestore();
  });

  it("debounces awareness: a burst of events yields a single active=true POST", async () => {
    const { connectAndStream } = await import("../../src/monitor/index.js");
    const promise = connectAndStream(undefined, () => {});

    for (let i = 0; i < 3; i++) {
      stream.push(
        sseFrame(
          {
            id: `evt_${i}`,
            type: "chat:message",
            timestamp: i,
            documentId: "doc-x",
            payload: { messageId: `m${i}`, text: "x", replyTo: null, anchor: null },
          },
          `evt_${i}`,
        ),
      );
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(700);

    const active = awarenessCalls.filter((c) => c.active === true);
    expect(active.length).toBe(1);
    expect(active[0]!.status).toMatch(/processing/);

    stream.end();
    await promise.catch(() => {});
  });

  it("auto-clears awareness after AWARENESS_CLEAR_MS (idle/active=false)", async () => {
    const { connectAndStream } = await import("../../src/monitor/index.js");
    const promise = connectAndStream(undefined, () => {});

    stream.push(
      sseFrame(
        {
          id: "evt_1",
          type: "chat:message",
          timestamp: 1,
          documentId: "doc-x",
          payload: { messageId: "m1", text: "x", replyTo: null, anchor: null },
        },
        "evt_1",
      ),
    );
    await vi.advanceTimersByTimeAsync(600); // past debounce
    expect(awarenessCalls.some((c) => c.active === true)).toBe(true);

    await vi.advanceTimersByTimeAsync(3_500); // past auto-clear
    const idle = awarenessCalls.filter((c) => c.active === false);
    expect(idle.length).toBeGreaterThanOrEqual(1);
    expect(idle[0]!.status).toBe("idle");

    stream.end();
    await promise.catch(() => {});
  });
});

describe("monitor: retry exhaustion -> MONITOR_CONNECT_FAILED + stdout notice", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorReports: Array<{ error: string; message: string }>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    errorReports = [];
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));
    stub.on("/api/channel-error", (_url, init) => {
      errorReports.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("", { status: 200 });
    });
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
  });

  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("reports MONITOR_CONNECT_FAILED + writes stdout notice + exits 1", async () => {
    let attempts = 0;
    stub.on("/api/events", () => {
      attempts++;
      throw new Error("refused");
    });

    const { main } = await import("../../src/monitor/index.js");
    const mainPromise = main().catch(() => {});
    await vi.advanceTimersByTimeAsync(200_000);
    await mainPromise;

    expect(attempts).toBeGreaterThanOrEqual(CHANNEL_MAX_RETRIES);
    expect(errorReports.length).toBeGreaterThanOrEqual(1);
    expect(errorReports[0]!.error).toBe("MONITOR_CONNECT_FAILED");
    expect(exitSpy).toHaveBeenCalledWith(1);

    const stdoutWrites = stdoutSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stdoutWrites).toMatch(/disconnected/i);
  });
});
