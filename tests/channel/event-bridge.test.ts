/**
 * Pinning tests for src/channel/event-bridge.ts.
 *
 * Written ahead of the #282 extraction so refactor regressions surface
 * immediately. Focused on observable behaviors that must survive the move
 * to the shared SSE consumer:
 *   - MCP notifications dispatched per parsed event (formatEventContent +
 *     formatEventMeta payloads)
 *   - eventId advance order (only after successful notification)
 *   - solo-mode suppression for non-chat events
 *   - awareness POSTs (debounced flush + auto-clear)
 *   - retry loop reports CHANNEL_CONNECT_FAILED + exits 1 after exhaustion
 *
 * Reuses the monitor's fetch-harness for stream control + fetch stubbing.
 * `vi.resetModules()` between tests defeats the channel's module-level mode
 * cache so per-test mode stubs are observed without TTL bleed.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_MAX_RETRIES } from "../../src/shared/constants.js";
import {
  ControllableStream,
  createFetchStub,
  installMonitorFakeTimers,
  sseFrame,
  sseResponse,
} from "../monitor/fetch-harness.js";

interface MockServer {
  notification: ReturnType<typeof vi.fn>;
}

function mockMcpServer(): MockServer {
  return {
    notification: vi.fn().mockResolvedValue(undefined),
  };
}

/** Dynamic import w/ fresh module state so the mode cache TTL doesn't bleed. */
async function loadStartEventBridge(): Promise<(mcp: Server, tandemUrl: string) => Promise<void>> {
  vi.resetModules();
  const mod = await import("../../src/channel/event-bridge.js");
  return mod.startEventBridge;
}

const URL = "http://127.0.0.1:3479";

interface Harness {
  stub: ReturnType<typeof createFetchStub>;
  mcp: MockServer;
  exitSpy: ReturnType<typeof vi.spyOn>;
  awarenessCalls: Array<{ documentId: string | null; status: string; active: boolean }>;
  errorReports: Array<{ error: string; message: string }>;
}

function setupHarness(modeBody: { mode: "tandem" | "solo" } = { mode: "tandem" }): Harness {
  installMonitorFakeTimers();
  const stub = createFetchStub();
  stub.install();
  const awarenessCalls: Harness["awarenessCalls"] = [];
  const errorReports: Harness["errorReports"] = [];
  stub.on("/api/mode", () => new Response(JSON.stringify(modeBody), { status: 200 }));
  stub.on("/api/channel-awareness", (_url, init) => {
    awarenessCalls.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("", { status: 200 });
  });
  stub.on("/api/channel-error", (_url, init) => {
    errorReports.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("", { status: 200 });
  });
  const mcp = mockMcpServer();
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  return { stub, mcp, exitSpy, awarenessCalls, errorReports };
}

function teardownHarness(h: Harness): void {
  h.stub.restore();
  vi.useRealTimers();
  h.exitSpy.mockRestore();
}

describe("event-bridge: per-event MCP notification delivery", () => {
  let h: Harness;
  let stream: ControllableStream;

  beforeEach(() => {
    h = setupHarness({ mode: "tandem" });
    stream = new ControllableStream();
    h.stub.on("/api/events", () => sseResponse(stream));
  });

  afterEach(() => {
    teardownHarness(h);
  });

  it("posts an MCP notification for each parsed event with formatted content + meta", async () => {
    const start = await loadStartEventBridge();
    const promise = start(h.mcp as unknown as Server, URL).catch(() => {});

    stream.push(
      sseFrame(
        {
          id: "evt_chat",
          type: "chat:message",
          timestamp: 1,
          payload: { messageId: "m1", text: "hello", replyTo: null, anchor: null },
        },
        "evt_chat",
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    stream.end();
    await vi.advanceTimersByTimeAsync(200_000);
    await promise;

    const notif = h.mcp.notification.mock.calls[0]?.[0];
    expect(notif).toBeDefined();
    expect(notif.method).toBe("notifications/claude/channel");
    expect(notif.params.content).toMatch(/User says.*hello/);
    expect(notif.params.meta.event_type).toBe("chat:message");
    expect(notif.params.meta.message_id).toBe("m1");
  });

  it("includes document_id in meta when present on the event", async () => {
    const start = await loadStartEventBridge();
    const promise = start(h.mcp as unknown as Server, URL).catch(() => {});

    stream.push(
      sseFrame(
        {
          id: "evt_open",
          type: "document:opened",
          timestamp: 1,
          documentId: "doc-abc",
          payload: { fileName: "a.md", format: "md" },
        },
        "evt_open",
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    stream.end();
    await vi.advanceTimersByTimeAsync(200_000);
    await promise;

    const notif = h.mcp.notification.mock.calls[0]?.[0];
    expect(notif.params.meta.document_id).toBe("doc-abc");
    expect(notif.params.meta.event_type).toBe("document:opened");
  });
});

describe("event-bridge: solo-mode suppression", () => {
  let h: Harness;
  let stream: ControllableStream;

  beforeEach(() => {
    h = setupHarness({ mode: "solo" });
    stream = new ControllableStream();
    h.stub.on("/api/events", () => sseResponse(stream));
  });

  afterEach(() => {
    teardownHarness(h);
  });

  it("suppresses non-chat events when mode is solo", async () => {
    const start = await loadStartEventBridge();
    const promise = start(h.mcp as unknown as Server, URL).catch(() => {});

    stream.push(
      sseFrame(
        {
          id: "evt_open",
          type: "document:opened",
          timestamp: 1,
          payload: { fileName: "a.md", format: "md" },
        },
        "evt_open",
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    stream.end();
    await vi.advanceTimersByTimeAsync(200_000);
    await promise;

    const channelNotifs = h.mcp.notification.mock.calls.filter(
      (c) => c[0]?.method === "notifications/claude/channel",
    );
    expect(channelNotifs).toHaveLength(0);
  });

  it("ALWAYS delivers chat:message regardless of mode", async () => {
    const start = await loadStartEventBridge();
    const promise = start(h.mcp as unknown as Server, URL).catch(() => {});

    stream.push(
      sseFrame(
        {
          id: "evt_chat",
          type: "chat:message",
          timestamp: 1,
          payload: { messageId: "m1", text: "hello", replyTo: null, anchor: null },
        },
        "evt_chat",
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    stream.end();
    await vi.advanceTimersByTimeAsync(200_000);
    await promise;

    const channelNotifs = h.mcp.notification.mock.calls.filter(
      (c) => c[0]?.method === "notifications/claude/channel",
    );
    expect(channelNotifs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("event-bridge: SSE resume + eventId advance", () => {
  let h: Harness;

  beforeEach(() => {
    h = setupHarness({ mode: "tandem" });
  });

  afterEach(() => {
    teardownHarness(h);
  });

  function captureHeaders(out: Array<Record<string, string>>) {
    return (init: RequestInit | undefined) => {
      const hdrs: Record<string, string> = {};
      const raw = init?.headers;
      if (raw instanceof Headers) {
        raw.forEach((v, k) => {
          hdrs[k.toLowerCase()] = v;
        });
      } else if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw as Record<string, string>)) {
          hdrs[k.toLowerCase()] = String(v);
        }
      }
      out.push(hdrs);
    };
  }

  it("sends Last-Event-ID on reconnect matching the last delivered event", async () => {
    const stream1 = new ControllableStream();
    const stream2 = new ControllableStream();
    let attempt = 0;
    const headersSeen: Array<Record<string, string>> = [];
    const cap = captureHeaders(headersSeen);

    h.stub.on("/api/events", (_url, init) => {
      attempt++;
      cap(init);
      if (attempt === 1) return sseResponse(stream1);
      if (attempt === 2) return sseResponse(stream2);
      throw new Error("network down");
    });

    const start = await loadStartEventBridge();
    const promise = start(h.mcp as unknown as Server, URL).catch(() => {});

    stream1.push(
      sseFrame(
        {
          id: "evt_first",
          type: "chat:message",
          timestamp: 1,
          payload: { messageId: "m1", text: "hi", replyTo: null, anchor: null },
        },
        "evt_first",
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    stream1.end();
    await vi.advanceTimersByTimeAsync(5_000);
    stream2.end();
    await vi.advanceTimersByTimeAsync(200_000);
    await promise;

    expect(headersSeen.length).toBeGreaterThanOrEqual(2);
    expect(headersSeen[0]!["last-event-id"]).toBeUndefined();
    expect(headersSeen[1]!["last-event-id"]).toBe("evt_first");
  });

  it("does NOT advance eventId when mcp.notification throws (regression fence)", async () => {
    const stream = new ControllableStream();
    let attempts = 0;
    const headersSeen: Array<Record<string, string>> = [];
    const cap = captureHeaders(headersSeen);

    h.stub.on("/api/events", (_url, init) => {
      attempts++;
      cap(init);
      if (attempts === 1) return sseResponse(stream);
      throw new Error("done");
    });

    h.mcp.notification.mockRejectedValueOnce(new Error("transport broken"));

    const start = await loadStartEventBridge();
    const promise = start(h.mcp as unknown as Server, URL).catch(() => {});

    stream.push(
      sseFrame(
        {
          id: "evt_dropped",
          type: "chat:message",
          timestamp: 1,
          payload: { messageId: "m1", text: "hi", replyTo: null, anchor: null },
        },
        "evt_dropped",
      ),
    );
    await vi.advanceTimersByTimeAsync(200_000);
    await promise;

    expect(headersSeen.length).toBeGreaterThanOrEqual(2);
    expect(headersSeen[1]!["last-event-id"]).not.toBe("evt_dropped");
  });
});

describe("event-bridge: awareness debounce + auto-clear", () => {
  let h: Harness;
  let stream: ControllableStream;

  beforeEach(() => {
    h = setupHarness({ mode: "tandem" });
    stream = new ControllableStream();
    h.stub.on("/api/events", () => sseResponse(stream));
  });

  afterEach(() => {
    teardownHarness(h);
  });

  it("debounces awareness: a burst of events yields a single active=true POST", async () => {
    const start = await loadStartEventBridge();
    const promise = start(h.mcp as unknown as Server, URL).catch(() => {});

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

    const active = h.awarenessCalls.filter((c) => c.active === true);
    expect(active.length).toBe(1);
    expect(active[0]!.status).toMatch(/processing/);

    stream.end();
    await vi.advanceTimersByTimeAsync(200_000);
    await promise;
  });

  it("auto-clears awareness after the clear timer (idle/active=false)", async () => {
    const start = await loadStartEventBridge();
    const promise = start(h.mcp as unknown as Server, URL).catch(() => {});

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
    expect(h.awarenessCalls.some((c) => c.active === true)).toBe(true);

    await vi.advanceTimersByTimeAsync(3_500); // past auto-clear
    const idle = h.awarenessCalls.filter((c) => c.active === false);
    expect(idle.length).toBeGreaterThanOrEqual(1);
    expect(idle[0]!.status).toBe("idle");

    stream.end();
    await vi.advanceTimersByTimeAsync(200_000);
    await promise;
  });
});

describe("event-bridge: retry exhaustion -> CHANNEL_CONNECT_FAILED", () => {
  let h: Harness;

  beforeEach(() => {
    h = setupHarness({ mode: "tandem" });
  });

  afterEach(() => {
    teardownHarness(h);
  });

  it("POSTs CHANNEL_CONNECT_FAILED after exhausting CHANNEL_MAX_RETRIES and exits 1", async () => {
    let attempts = 0;
    h.stub.on("/api/events", () => {
      attempts++;
      throw new Error("refused");
    });

    const start = await loadStartEventBridge();
    const promise = start(h.mcp as unknown as Server, URL).catch(() => {});
    await vi.advanceTimersByTimeAsync(300_000);
    await promise;

    expect(attempts).toBeGreaterThanOrEqual(CHANNEL_MAX_RETRIES);
    expect(h.errorReports.length).toBeGreaterThanOrEqual(1);
    expect(h.errorReports[0]!.error).toBe("CHANNEL_CONNECT_FAILED");
    expect(h.exitSpy).toHaveBeenCalledWith(1);
  });
});
