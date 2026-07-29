/**
 * `getSubscriberCount()` must track a real consumer through connect and close.
 *
 * The function body is `return subscribers.size` — trivially correct on its own.
 * The risk it carries lives in `sse.ts`, where `subscribe(onEvent)` on connect is
 * paired with `unsubscribe(onEvent)` inside `cleanup()`. Drop that pairing and the
 * count ratchets upward forever: `tandem doctor` then reports phantom consumers,
 * `/health` shows a push path that looks attached when nothing is, and the
 * "`subscribers: 0` is a sound negative" guarantee the whole diagnostic rests on
 * quietly stops holding. Nothing would fail.
 *
 * Asserted as a DELTA rather than absolute 0→1→0: the queue's subscriber set is
 * module state shared with every other test in the process.
 */

import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { getSubscriberCount, subscribe, unsubscribe } from "../../src/server/events/queue.js";
import { sseHandler } from "../../src/server/events/sse.js";

/** Captures the `close` handler so the test can fire it like Express would. */
function makeReq(): { req: Request; close: () => void } {
  const handlers: Record<string, () => void> = {};
  const req = {
    headers: {},
    on: (event: string, cb: () => void) => {
      handlers[event] = cb;
    },
  } as unknown as Request;
  return {
    req,
    close: () => handlers.close?.(),
  };
}

function makeRes(): Response {
  return {
    writeHead: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(),
  } as unknown as Response;
}

describe("getSubscriberCount tracks the SSE fan-out", () => {
  it("rises on connect and returns to baseline on close", () => {
    const baseline = getSubscriberCount();

    const { req, close } = makeReq();
    sseHandler(req, makeRes());
    expect(getSubscriberCount()).toBe(baseline + 1);

    close();
    expect(getSubscriberCount()).toBe(baseline);
  });

  // The reason `subscribe` takes a kind at all. `local-model/collaborator.ts`
  // attaches to the same fan-out; it is dark behind BYO_MODELS_ENABLED today, but
  // on that flip an in-process listener would hold the count above zero forever —
  // making "nothing is attached" unreachable in `tandem doctor` and stamping every
  // comment `alreadyPushed` on the strength of a listener that never left the
  // machine. Both are the false signal #1242/#1243 exist to remove.
  it("does not count an in-process subscriber", () => {
    const baseline = getSubscriberCount();
    const inProcess = () => {};

    subscribe(inProcess); // default kind is "internal"
    expect(getSubscriberCount()).toBe(baseline);

    subscribe(inProcess, "internal");
    expect(getSubscriberCount()).toBe(baseline);

    unsubscribe(inProcess);
    expect(getSubscriberCount()).toBe(baseline);
  });

  it("counts each consumer independently", () => {
    const baseline = getSubscriberCount();

    const a = makeReq();
    const b = makeReq();
    sseHandler(a.req, makeRes());
    sseHandler(b.req, makeRes());
    expect(getSubscriberCount()).toBe(baseline + 2);

    a.close();
    expect(getSubscriberCount()).toBe(baseline + 1);
    b.close();
    expect(getSubscriberCount()).toBe(baseline);
  });
});
