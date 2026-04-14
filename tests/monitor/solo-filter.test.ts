import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectAndStream, getCachedMode } from "../../src/monitor/index.js";
import { ControllableStream, createFetchStub, sseFrame, sseResponse } from "./fetch-harness.js";

describe("solo-mode event filtering", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stream: ControllableStream;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    stub = createFetchStub();
    stub.install();
    stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));
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
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "solo" }), { status: 200 }));
    const promise = connectAndStream(
      undefined,
      () => {},
      () => {},
    );

    // Pre-warm the mode cache so getModeSync() sees "solo" when the hot path
    // checks it. The hot path now reads synchronously (fire-and-forget refresh),
    // so the cache must be seeded before the first event is processed.
    await getCachedMode();

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
    stream.end();
    await promise.catch(() => {});

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("ALWAYS delivers chat:message events regardless of mode", async () => {
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "solo" }), { status: 200 }));
    const promise = connectAndStream(
      undefined,
      () => {},
      () => {},
    );

    stream.push(
      sseFrame(
        {
          id: "c1",
          type: "chat:message",
          timestamp: 1,
          payload: { messageId: "m", text: "hi", replyTo: null, anchor: null },
        },
        "c1",
      ),
    );
    stream.end();
    await promise.catch(() => {});

    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("delivers all event types when mode is tandem", async () => {
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    const promise = connectAndStream(
      undefined,
      () => {},
      () => {},
    );

    stream.push(
      sseFrame(
        {
          id: "e2",
          type: "document:opened",
          timestamp: 1,
          payload: { fileName: "a.md", format: "md" },
        },
        "e2",
      ),
    );
    stream.end();
    await promise.catch(() => {});

    expect(stdoutSpy).toHaveBeenCalled();
  });
});
