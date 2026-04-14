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
