import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectAndStream } from "../../src/monitor/index.js";
import {
  ControllableStream,
  createFetchStub,
  installMonitorFakeTimers,
  sseFrame,
  sseResponse,
} from "./fetch-harness.js";

describe("SSE parsing error isolation", () => {
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

  it("advances past a malformed-JSON frame WITHOUT updating lastEventId", async () => {
    const onEventId = vi.fn();
    const promise = connectAndStream(undefined, onEventId);

    // Frame 1: malformed JSON, but has an id
    stream.push(`id: evt_bad\ndata: {not json\n\n`);
    // Frame 2: valid frame, should get through
    stream.push(
      sseFrame(
        {
          id: "evt_ok",
          type: "chat:message",
          timestamp: 1,
          payload: { messageId: "m", text: "hi", replyTo: null, anchor: null },
        },
        "evt_ok",
      ),
    );
    stream.end();

    await promise.catch(() => {}); // "SSE stream ended" is expected
    // onEventId should have been called for evt_ok but NOT evt_bad
    expect(onEventId).toHaveBeenCalledWith("evt_ok");
    expect(onEventId).not.toHaveBeenCalledWith("evt_bad");
  });

  it("logs the specific parse error message (not just 'malformed')", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onEventId = vi.fn();
    const promise = connectAndStream(undefined, onEventId);

    stream.push(`id: evt_bad\ndata: {not json\n\n`);
    stream.end();
    await promise.catch(() => {});

    const msgs = errSpy.mock.calls.map((c) => c.join(" "));
    expect(msgs.some((m) => m.includes("JSON") || m.includes("parse"))).toBe(true);
    errSpy.mockRestore();
  });

  it("handles a frame split across multiple chunks (decoder.decode stream: true)", async () => {
    const onEventId = vi.fn();
    const promise = connectAndStream(undefined, onEventId);

    const payload = JSON.stringify({
      id: "split",
      type: "chat:message",
      timestamp: 1,
      payload: { messageId: "m", text: "hi", replyTo: null, anchor: null },
    });
    const frame = `id: split\ndata: ${payload}\n\n`;
    stream.push(frame.slice(0, 15));
    stream.push(frame.slice(15, 40));
    stream.push(frame.slice(40));
    stream.end();

    await promise.catch(() => {});
    expect(onEventId).toHaveBeenCalledWith("split");
  });
});

describe("SSE buffer overflow", () => {
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

  it("throws when the buffer grows past 1MB without a frame boundary", async () => {
    const promise = connectAndStream(
      undefined,
      () => {},
      () => {},
    );
    stream.push("data: " + "x".repeat(1_100_000));
    await expect(promise).rejects.toThrow(/SSE buffer exceeded/);
  });

  it("allows a single 900KB event that ends with a proper boundary", async () => {
    const onEventId = vi.fn();
    const promise = connectAndStream(undefined, onEventId, () => {});

    const payload = JSON.stringify({
      id: "big",
      type: "chat:message",
      timestamp: 1,
      payload: { messageId: "m", text: "x".repeat(900_000), replyTo: null, anchor: null },
    });
    stream.push(`id: big\ndata: ${payload}\n\n`);
    stream.end();
    await promise.catch(() => {});

    expect(onEventId).toHaveBeenCalledWith("big");
  });
});

describe("EPIPE on stdout.write", () => {
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

  it("does NOT call onEventId when stdout.write throws (regression fence for #288)", async () => {
    // Regression fence: if a future refactor moves `onEventId(eventId)` above
    // the write or drops the order guarantee, lastEventId would advance past
    // an event that never reached the plugin host — the server would have no
    // way to replay it on reconnect.
    stdoutSpy.mockImplementationOnce(() => {
      throw new Error("EPIPE");
    });
    const onEventId = vi.fn();
    const promise = connectAndStream(undefined, onEventId);

    stream.push(
      sseFrame(
        {
          id: "e1",
          type: "chat:message",
          timestamp: 1,
          payload: { messageId: "m", text: "hi", replyTo: null, anchor: null },
        },
        "e1",
      ),
    );

    await expect(promise).rejects.toThrow("EPIPE");
    expect(onEventId).not.toHaveBeenCalledWith("e1");
  });
});

describe("installStdoutErrorHandler (async EPIPE)", () => {
  it("logs stderr and exits 1 when stdout emits 'error' (async EPIPE)", async () => {
    // The PR's headline fix: process.stdout.write does NOT synchronously throw
    // on EPIPE. Node emits an 'error' event asynchronously when the plugin-host
    // read end closes mid-stream. Without a listener, writes keep advancing
    // lastEventId past events that never arrived. This test fences that the
    // handler (a) logs to stderr so support has a trail, and (b) exits 1 so
    // the plugin host respawns us with a fresh stdout.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const mod = await import("../../src/monitor/index.js");
    const err = new Error("EPIPE");

    mod._monitorTestExports.onStdoutError(err);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("stdout error"), err);
    expect(exitSpy).toHaveBeenCalledWith(1);

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("SSE resume behavior", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
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

  it("resume: Last-Event-ID header on reconnect matches the last delivered id", async () => {
    const stream1 = new ControllableStream();
    const stream2 = new ControllableStream();
    let attempts = 0;
    const headersSeen: Array<Record<string, string>> = [];

    stub.on("/api/events", (_url, init) => {
      attempts++;
      const hdrs: Record<string, string> = {};
      const raw = init?.headers;
      if (raw && typeof raw === "object") {
        if (raw instanceof Headers) {
          raw.forEach((v, k) => {
            hdrs[k.toLowerCase()] = v;
          });
        } else {
          for (const [k, v] of Object.entries(raw as Record<string, string>)) {
            hdrs[k.toLowerCase()] = String(v);
          }
        }
      }
      headersSeen.push(hdrs);
      if (attempts === 1) return sseResponse(stream1);
      return sseResponse(stream2);
    });

    let lastId: string | undefined;
    const p1 = connectAndStream(undefined, (id) => {
      lastId = id;
    });
    stream1.push(
      sseFrame(
        {
          id: "e7",
          type: "document:opened",
          timestamp: 1,
          payload: { fileName: "a.md", format: "md" },
        },
        "e7",
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    stream1.end();
    await p1.catch(() => {});

    expect(lastId).toBe("e7");

    const p2 = connectAndStream(lastId, () => {});
    stream2.end();
    await p2.catch(() => {});

    expect(headersSeen).toHaveLength(2);
    expect(headersSeen[0]["last-event-id"]).toBeUndefined();
    expect(headersSeen[1]["last-event-id"]).toBe("e7");
  });
});
