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

  it("writes a payload-free wake line per delivered event, never the content", async () => {
    // ADR-049 decision 2. Each stdout line becomes an unsolicited
    // `<task_notification>` turn, so the message body must not appear on it.
    // The negative half is the point of the test: before #1354 this asserted
    // the OPPOSITE — that "hello world" reached stdout.
    //
    // Asserted as the WHOLE line, not as a set of absences. An earlier version
    // of this test listed the fixture's own literals (`"hello world"`, `"m1"`)
    // and nothing else, which meant a line that appended `payload.content` or
    // `textSnippet` — the exact leak reason 1 in `run.ts` calls the sharpest
    // case — passed it green. Absence assertions can only refuse what the
    // fixture happens to contain; an equality assertion refuses everything.
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

    const writes: string[] = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const matched = writes.find((w) => w.includes("chat:message"));
    expect(matched).toBe("Tandem: chat:message — call tandem_checkInbox for details\n");
  });

  it("carries no payload field of any wake-worthy event, not just the ones a fixture happens to have", async () => {
    // Every string in these fixtures is a unique sentinel, so the assertion is
    // "none of the payload reached stdout" rather than "these two literals did
    // not". `annotation:created` is the important one and had NO coverage on
    // this path at all: it is the only wake-worthy type carrying both
    // `content` (the annotation body) and `textSnippet` (a verbatim document
    // slice), and `.docx` import puts third-party Word comment text in
    // `content`. `documentId` is included because `docIdFromPath` builds it as
    // `<basename-slug>-<hash>` — ADR-049 refuses it by name for that reason.
    const { connectAndStream } = await import("../../src/monitor/index.js");
    const promise = connectAndStream(undefined, () => {});

    const sentinels = [
      "SENTINEL_annotationId",
      "SENTINEL_content",
      "SENTINEL_snippet",
      "SENTINEL_replyText",
      "SENTINEL_messageId",
      "SENTINEL_text",
      "SENTINEL_textSnapshot",
      "SENTINEL_docid",
    ];

    stream.push(
      sseFrame(
        {
          id: "evt_ann",
          type: "annotation:created",
          timestamp: 1,
          documentId: "SENTINEL_docid",
          payload: {
            annotationId: "SENTINEL_annotationId",
            annotationType: "comment",
            content: "SENTINEL_content",
            textSnippet: "SENTINEL_snippet",
            hasSuggestedText: true,
          },
        },
        "evt_ann",
      ),
    );
    stream.push(
      sseFrame(
        {
          id: "evt_reply",
          type: "annotation:reply",
          timestamp: 2,
          documentId: "SENTINEL_docid",
          payload: {
            annotationId: "SENTINEL_annotationId",
            replyId: "r1",
            replyText: "SENTINEL_replyText",
            replyAuthor: "user",
            textSnippet: "SENTINEL_snippet",
          },
        },
        "evt_reply",
      ),
    );
    stream.push(
      sseFrame(
        {
          id: "evt_chat2",
          type: "chat:message",
          timestamp: 3,
          documentId: "SENTINEL_docid",
          payload: {
            messageId: "SENTINEL_messageId",
            text: "SENTINEL_text",
            replyTo: null,
            anchor: { from: 0, to: 4, textSnapshot: "SENTINEL_textSnapshot" },
          },
        },
        "evt_chat2",
      ),
    );
    stream.end();
    await promise.catch(() => {});

    const all = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    for (const sentinel of sentinels) {
      expect(all, `${sentinel} reached stdout`).not.toContain(sentinel);
    }
    // And the wakes themselves did happen — otherwise the loop above passes
    // for the uninteresting reason that nothing was written at all.
    expect(all).toContain("Tandem: annotation:created — call tandem_checkInbox for details\n");
    expect(all).toContain("Tandem: annotation:reply — call tandem_checkInbox for details\n");
    expect(all).toContain("Tandem: chat:message — call tandem_checkInbox for details\n");
  });

  it("keeps a multi-line message body to exactly one stdout line, carrying none of it", async () => {
    // The line protocol is one notification per line, so a body containing
    // newlines must not become three notifications. Since #1354 the body is not
    // emitted at all, which makes that structural — but the invariant is worth
    // a fence: a future change that reintroduces any payload must not
    // reintroduce the line split with it.
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

    const writes: string[] = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const matched = writes.find((w) => w.includes("chat:message"));
    expect(matched).toBeDefined();
    // No internal newlines (only the trailing one).
    expect(matched!.slice(0, -1).includes("\n")).toBe(false);
    expect(writes.join("")).not.toContain("line2");
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
          id: "evt_ann",
          type: "annotation:created",
          timestamp: 1,
          payload: { annotationId: "a1", fileName: "x.md" },
        },
        "evt_ann",
      ),
    );
    await vi.advanceTimersByTimeAsync(50);

    // Mode preserved as "tandem" — the non-chat event was NOT suppressed.
    // Asserted on the event type, not the filename: the wake line carries no
    // payload since #1354, and the filename was payload.
    //
    // Must be a wake-worthy non-chat type. The `document:opened` this used to
    // push satisfies "non-chat" but is no longer emitted at all, so the
    // assertion would have been measuring the emit gate while claiming to
    // measure the Solo one.
    const writes = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(writes).toContain("annotation:created");
    expect(writes).not.toContain("x.md");
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

  // Tandem was never running, so say nothing on stdout — stdout is what the
  // model reads, and the line claims events stopped flowing when none ever did.
  //
  // The original argument was population-based (the host armed this monitor in
  // EVERY session, so a never-connected run was usually unrelated work) and
  // #1354 inverted that premise: arming now follows a Tandem skill dispatch.
  // The contract is unchanged, on grounds that never depended on population —
  // nothing was lost, any `tandem_*` call reports the real problem far better,
  // and a monitor that exits is never respawned (spike F9), so this line would
  // outlive its own truth. See the long note in `src/monitor/run.ts`.
  it("reports MONITOR_CONNECT_FAILED and exits 1 but stays SILENT when it never connected", async () => {
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

    const stdoutWrites = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(stdoutWrites).not.toMatch(/disconnected/i);
  });

  // The case the notice exists for, and the guard against "fixed" becoming
  // "deleted": the stream WAS up and went away, so events really did stop
  // arriving and the user needs to know.
  it("writes the stdout notice when a live stream is lost", async () => {
    const live = new ControllableStream();
    let attempts = 0;
    stub.on("/api/events", () => {
      attempts++;
      if (attempts === 1) return sseResponse(live); // first handshake succeeds
      throw new Error("refused");
    });

    const { main } = await import("../../src/monitor/index.js");
    const mainPromise = main().catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    live.error(new Error("connection reset"));
    await vi.advanceTimersByTimeAsync(200_000);
    await mainPromise;

    expect(attempts).toBeGreaterThan(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stdoutWrites = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(stdoutWrites).toMatch(/disconnected/i);
  });
});
