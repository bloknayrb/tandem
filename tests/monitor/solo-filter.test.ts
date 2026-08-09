import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectAndStream, getCachedMode } from "../../src/monitor/index.js";
import {
  ControllableStream,
  createFetchStub,
  installMonitorFakeTimers,
  sseFrame,
  sseResponse,
} from "./fetch-harness.js";

describe("solo-mode event filtering", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stream: ControllableStream;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    installMonitorFakeTimers();
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

    // A WAKE-WORTHY non-chat event, deliberately. This pushed `document:opened`
    // until the emit gate started dropping non-wake-worthy types — at which
    // point the assertion went hollow: stdout would be empty in Tandem mode
    // too, so the test would have gone on passing with the Solo gate deleted.
    // The vehicle for "X is suppressed" must be something that is otherwise
    // emitted (lesson 96).
    stream.push(
      sseFrame(
        {
          id: "e1",
          type: "annotation:created",
          timestamp: 1,
          payload: { annotationId: "a1", fileName: "a.md" },
        },
        "e1",
      ),
    );
    stream.end();
    await promise.catch(() => {});

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  // The Solo->Tandem release wake. The release route flips mode server-side and
  // fires this microseconds later in the SAME handler, but the consumer's gate
  // reads `cachedMode` (fire-and-forget refresh + a 2s TTL early-return), so the
  // cache still says "solo" and the wake — the one event WS-A2's release exists to
  // deliver — was suppressed AND checkpointed past, so never replayed.
  //
  // Any Solo session that saw ANY non-chat event has a warm "solo" cache, and
  // accept/dismiss and document:* still flow (the server hold is deliberately
  // narrow), so this was the common case, not an edge.
  it("delivers the Solo->Tandem release wake even with a stale solo cache", async () => {
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "solo" }), { status: 200 }));
    const promise = connectAndStream(
      undefined,
      () => {},
      () => {},
    );

    // Warm the cache to "solo" — exactly the state the release lands in.
    await getCachedMode();

    stream.push(
      sseFrame(
        {
          id: "w1",
          type: "annotation:created",
          timestamp: 1,
          payload: {
            annotationId: "wake_abc123",
            annotationType: "comment",
            content: "Solo mode ended. Call tandem_checkInbox…",
            textSnippet: "",
          },
        },
        "w1",
      ),
    );
    stream.end();
    await promise.catch(() => {});

    expect(stdoutSpy).toHaveBeenCalled();
  });

  // The exemption must be exactly the disjoint `wake_` namespace and nothing
  // wider — a real user comment in Solo must still be suppressed.
  it("still suppresses a real annotation:created in solo", async () => {
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "solo" }), { status: 200 }));
    const promise = connectAndStream(
      undefined,
      () => {},
      () => {},
    );
    await getCachedMode();

    stream.push(
      sseFrame(
        {
          id: "a1",
          type: "annotation:created",
          timestamp: 1,
          payload: {
            annotationId: "ann_real",
            annotationType: "comment",
            content: "private thought",
            textSnippet: "hello",
          },
        },
        "a1",
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

  it("delivers non-chat wake-worthy events when mode is tandem", async () => {
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
          type: "annotation:created",
          timestamp: 1,
          payload: { annotationId: "a2", fileName: "a.md" },
        },
        "e2",
      ),
    );
    stream.end();
    await promise.catch(() => {});

    expect(stdoutSpy).toHaveBeenCalled();
  });

  // The counterpart, and the reason the two tests above no longer use
  // `document:*`: silence there is the EMIT gate, not the Solo gate. Without
  // this test nothing distinguishes the two causes, and "suppressed in Solo"
  // would be indistinguishable from "never printed at all".
  it("prints nothing for document:* even in tandem — not wake-worthy", async () => {
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    const promise = connectAndStream(
      undefined,
      () => {},
      () => {},
    );

    for (const type of ["document:opened", "document:closed", "document:switched"] as const) {
      stream.push(
        sseFrame(
          { id: type, type, timestamp: 1, payload: { fileName: "a.md", format: "md" } },
          type,
        ),
      );
    }
    stream.end();
    await promise.catch(() => {});

    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
