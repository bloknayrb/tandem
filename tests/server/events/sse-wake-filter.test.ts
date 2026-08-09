import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _pushEventForTests, resetForTesting } from "../../../src/server/events/queue.js";
import { parseWakeFilter, sseHandler } from "../../../src/server/events/sse.js";
import type { TandemEvent } from "../../../src/server/events/types.js";
import { setCtrlMode } from "../../helpers/ctrl-mode.js";

/**
 * `/api/events?filter=wake` — ADR-047 decision 2.
 *
 * The filter does TWO things and the second is the one that matters: it narrows
 * event types (so tab churn doesn't wake an idle session) AND it strips the
 * payload (so a model cannot answer from a notification it has no way to know
 * was incomplete). A test suite that only checked the narrowing would pass on an
 * implementation that forwarded every message body verbatim.
 */

function makeReq(query: Record<string, unknown> = {}, lastEventId?: string) {
  const handlers: Record<string, () => void> = {};
  const req = {
    query,
    headers: lastEventId ? { "last-event-id": lastEventId } : {},
    on: (event: string, cb: () => void) => {
      handlers[event] = cb;
    },
  } as unknown as Request;
  return { req, close: () => handlers.close?.() };
}

function makeRes() {
  const writes: string[] = [];
  const json = vi.fn();
  const status = vi.fn(() => ({ json }) as unknown as Response);
  const res = {
    writeHead: vi.fn(),
    status,
    json,
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn(),
    writableEnded: false,
  } as unknown as Response;
  return { res, writes, status, json };
}

/** The parsed `data:` bodies, in order — comments and `id:` lines dropped. */
function dataFrames(writes: string[]): Array<Record<string, unknown>> {
  return writes
    .filter((w) => w.startsWith("data: "))
    .map((w) => JSON.parse(w.slice("data: ".length).trim()));
}

/**
 * Fixture timestamps must be LIVE, not a frozen epoch. `pushEvent` evicts
 * anything older than `CHANNEL_EVENT_BUFFER_AGE_MS` on every push, so a 2023
 * constant is dropped from the buffer before the replay path can ever see it —
 * which reads as "the filter removed it" and passes a narrowing test for the
 * wrong reason.
 */
const NOW = Date.now();

/**
 * `documentId` sits at the TOP LEVEL, because that is where a real event carries
 * it — `TandemEventBase` (`src/shared/events/types.ts`), set by every observer.
 * It is in no payload interface at all.
 *
 * This is not a cosmetic correction. With `documentId` nested inside `payload`,
 * the strip could be mutated into the denylist form `toWakeFrame`'s own docblock
 * forbids — `const {payload, ...rest} = event; return rest;` — and every
 * assertion below would still pass, because dropping `payload` would take the
 * misplaced id with it. Against a real event that mutant puts the
 * filename-derived document id on the wire. The most load-bearing claim in
 * ADR-047 decision 2 was guarded by a fixture that could not fail.
 */
const CHAT: TandemEvent = {
  id: "evt_chat_1",
  type: "chat:message",
  timestamp: NOW,
  documentId: "q4-layoffs-plan-1a2b3c",
  payload: { messageId: "msg_1", text: "the secret is hunter2", replyTo: null, anchor: null },
} as TandemEvent;

const DOC_SWITCH: TandemEvent = {
  id: "evt_doc_1",
  type: "document:switched",
  timestamp: NOW + 1,
  documentId: "q4-layoffs-plan-1a2b3c",
  payload: { fileName: "q4-layoffs-plan.md" },
} as TandemEvent;

const opened: Array<() => void> = [];
afterEach(() => {
  for (const close of opened.splice(0)) close();
  resetForTesting();
});

function connect(query: Record<string, unknown> = {}, lastEventId?: string) {
  setCtrlMode("tandem");
  const { req, close } = makeReq(query, lastEventId);
  const { res, writes } = makeRes();
  sseHandler(req, res);
  opened.push(close);
  return { writes, close };
}

describe("parseWakeFilter", () => {
  it("accepts only the exact string", () => {
    expect(parseWakeFilter("wake")).toBe("wake");
  });

  it("treats ABSENT as the full stream — every existing consumer", () => {
    expect(parseWakeFilter(undefined)).toBe("none");
  });

  it("treats a present-but-unrecognised filter as INVALID, not as absent", () => {
    // The distinction is the whole point. Folding these into "none" hands a
    // caller that asked to be NARROWED the opposite — full message bodies — and
    // per ADR-047 decision 2 that is what causes duplicate replies and answering
    // from a view the model cannot know is incomplete. Failing open on a typo in
    // a privacy narrowing is the wrong direction.
    //
    // `?filter=wake&filter=x` arrives as an array; `?filter[a]=b` as an object.
    for (const raw of [
      ["wake"],
      ["wake", "x"],
      { a: "wake" },
      "wake ",
      "WAKE",
      "wakeful",
      "",
      null,
      true,
    ]) {
      expect(parseWakeFilter(raw), `filter=${JSON.stringify(raw)}`).toBe("invalid");
    }
  });
});

describe("an unrecognised filter is refused, not silently widened", () => {
  it("400s instead of opening a full-payload stream", () => {
    setCtrlMode("tandem");
    const { req } = makeReq({ filter: "Wake" });
    const { res, writes, status } = makeRes();
    sseHandler(req, res);

    expect(status).toHaveBeenCalledWith(400);
    // And crucially: no stream was opened, so a subsequent event cannot reach a
    // consumer that thought it had asked to be narrowed.
    expect(res.writeHead).not.toHaveBeenCalled();
    _pushEventForTests(CHAT);
    expect(writes.join("")).toBe("");
    resetForTesting();
  });

  it("still gives an ABSENT filter the full, unstripped stream", () => {
    // The regression this pairs with: folding "absent" into the refusal would
    // break the channel shim and the plugin monitor, which send no filter at all.
    const { writes } = connect({});

    _pushEventForTests(CHAT);

    expect(writes.join("")).toContain("hunter2");
  });
});

describe("GET /api/events?filter=wake", () => {
  it("strips the payload from a wake frame", () => {
    const { writes } = connect({ filter: "wake" });

    _pushEventForTests(CHAT);

    expect(dataFrames(writes)).toEqual([
      { id: "evt_chat_1", type: "chat:message", timestamp: NOW },
    ]);
    // Said separately and bluntly: the message body must not appear anywhere in
    // the bytes on the wire, not merely be absent from a parsed field.
    expect(writes.join("")).not.toContain("hunter2");
  });

  it("drops document:* churn", () => {
    const { writes } = connect({ filter: "wake" });

    _pushEventForTests(DOC_SWITCH);

    expect(dataFrames(writes)).toEqual([]);
  });

  it("never puts a documentId on the wire", () => {
    // `docIdFromPath` is `<basename-slug>-<hash>`, so a document id is a
    // filename. This is the same rule push-liveness.ts follows.
    const { writes } = connect({ filter: "wake" });

    _pushEventForTests({
      id: "evt_ann_1",
      type: "annotation:created",
      timestamp: NOW + 2,
      documentId: "q4-layoffs-plan-1a2b3c",
      payload: {
        annotationId: "ann_1",
        annotationType: "comment",
        content: "please review the severance numbers",
        textSnippet: "severance",
      },
    } as TandemEvent);

    expect(writes.join("")).not.toContain("q4-layoffs-plan");
    expect(writes.join("")).not.toContain("severance");
    expect(dataFrames(writes)).toEqual([
      { id: "evt_ann_1", type: "annotation:created", timestamp: NOW + 2 },
    ]);
  });

  it("keeps the id: line so Last-Event-ID resumption still works", () => {
    const { writes } = connect({ filter: "wake" });

    _pushEventForTests(CHAT);

    expect(writes).toContain("id: evt_chat_1\n");
  });

  it("applies both the narrowing and the strip on the REPLAY path", () => {
    // The replay path is the riskier of the two: an unknown `lastEventId` comes
    // from a client-controlled header and falls back to the ENTIRE buffer, so a
    // filter applied only to live events would hand a reconnecting wake
    // consumer every payload in the buffer in one shot.
    const seed = connect();
    _pushEventForTests(CHAT);
    _pushEventForTests(DOC_SWITCH);
    seed.close();

    const { writes } = connect({ filter: "wake" }, "evt_unknown_id");

    expect(dataFrames(writes)).toEqual([
      { id: "evt_chat_1", type: "chat:message", timestamp: NOW },
    ]);
    expect(writes.join("")).not.toContain("hunter2");
  });
});

describe("GET /api/events with no filter — the regression guard", () => {
  it("still delivers whole events, payload intact", () => {
    // The channel shim and plugin monitor send no `filter` and parse full
    // events. If this ever fails, every shipped consumer broke.
    const { writes } = connect();

    _pushEventForTests(CHAT);

    expect(dataFrames(writes)).toEqual([CHAT]);
  });

  it("still delivers document:* lifecycle", () => {
    const { writes } = connect();

    _pushEventForTests(DOC_SWITCH);

    expect(dataFrames(writes)).toEqual([DOC_SWITCH]);
  });

  it("refuses a malformed filter rather than treating it as no filter", () => {
    // This assertion is INVERTED from what it used to be. The old behaviour —
    // `?filter=["wake","x"]` silently yielding the full stream — is the
    // fail-open the review caught: it hands full message bodies to a caller who
    // asked to be narrowed. It must never be silently reachable again.
    setCtrlMode("tandem");
    const { req } = makeReq({ filter: ["wake", "x"] });
    const { res, writes, status } = makeRes();
    sseHandler(req, res);

    expect(status).toHaveBeenCalledWith(400);
    _pushEventForTests(CHAT);
    expect(writes.join("")).not.toContain("hunter2");
    resetForTesting();
  });
});
