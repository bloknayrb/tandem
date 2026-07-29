/**
 * The channel/monitor heartbeat must never author Claude's presence.
 *
 * `/api/channel-awareness` is POSTed by the channel shim and plugin monitor on
 * every SSE event they receive (`sse-consumer.ts` fires it on RECEIPT, not on
 * Claude doing anything). It used to write `ClaudeAwareness` into the
 * document's awareness map, which drives the status pill's `· {status}` suffix
 * and the chat panel's thinking line.
 *
 * That made the pill report a model that might not exist. A channel shim whose
 * host never negotiated the `claude/channel` capability still connects and
 * still receives SSE, so it kept stamping `status: "processing: …"` and then
 * the 3s auto-clear `status: "idle"` — refreshed on every document touch, from
 * a process with nothing on the other end. Users saw "AI connected · idle"
 * while chat messages went nowhere.
 *
 * The heartbeat is still recorded, for diagnostics only.
 */

import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPushConsumerLiveness,
  resetPushConsumerLivenessForTests,
} from "../../src/server/events/push-liveness.js";
import { startMcpServerHttp } from "../../src/server/mcp/server.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_AWARENESS, Y_MAP_CLAUDE } from "../../src/shared/constants.js";
import { allocPort } from "../helpers/alloc-port.js";

const DOC_ID = "push-liveness-doc";

let httpServer: Server;
let port: number;

async function postHeartbeat(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/channel-awareness`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: `127.0.0.1:${port}` },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  resetPushConsumerLivenessForTests();
  port = await allocPort();
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
});

afterEach(() => {
  return new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("channel/monitor heartbeat does not author Claude's presence", () => {
  it("leaves the document's ClaudeAwareness untouched", async () => {
    const doc = getOrCreateDocument(DOC_ID);
    const awareness = doc.getMap(Y_MAP_AWARENESS);
    expect(awareness.get(Y_MAP_CLAUDE)).toBeUndefined();

    const res = await postHeartbeat({
      documentId: DOC_ID,
      status: "processing: annotation:created",
      active: true,
    });
    expect(res.status).toBe(200);

    expect(awareness.get(Y_MAP_CLAUDE)).toBeUndefined();
  });

  // The exact shape of the reported symptom: the shim's 3s auto-clear. This is
  // the write that produced "AI connected · idle" from a dead process.
  it("does not write an idle status on the shim's auto-clear", async () => {
    const doc = getOrCreateDocument(DOC_ID);
    const awareness = doc.getMap(Y_MAP_AWARENESS);

    await postHeartbeat({ documentId: DOC_ID, status: "idle", active: false });

    expect(awareness.get(Y_MAP_CLAUDE)).toBeUndefined();
  });

  it("still rejects a malformed heartbeat", async () => {
    const res = await postHeartbeat({ documentId: DOC_ID, active: true });
    expect(res.status).toBe(400);
  });

  // The two cases above assert absence from an EMPTY baseline, which catches a
  // straight re-add of the deleted code but not the thing the user actually
  // reported: a stale value being displayed. That needs the key to hold a value.
  // Seeded on its own document id, because DOC_ID is shared with the tests above
  // and one of them opens by asserting the key is undefined.
  it("does not overwrite or downgrade Claude's real presence", async () => {
    const seededId = "push-liveness-seeded-doc";
    const doc = getOrCreateDocument(seededId);
    const awareness = doc.getMap(Y_MAP_AWARENESS);
    const real = {
      status: "reviewing the intro",
      timestamp: Date.now(),
      active: true,
      focusParagraph: 3,
      focusOffset: 42,
    };
    awareness.set(Y_MAP_CLAUDE, real);

    // Both shapes the shim sends: the per-event stamp and the 3s auto-clear.
    await postHeartbeat({
      documentId: seededId,
      status: "processing: annotation:created",
      active: true,
    });
    await postHeartbeat({ documentId: seededId, status: "idle", active: false });

    expect(awareness.get(Y_MAP_CLAUDE)).toEqual(real);
  });
});

describe("push-consumer liveness recording", () => {
  it("starts empty so 'never attached' is distinguishable from 'quiet'", () => {
    expect(getPushConsumerLiveness()).toEqual({ lastEventAt: null, eventCount: 0 });
  });

  it("counts heartbeats", async () => {
    await postHeartbeat({ documentId: DOC_ID, status: "processing: x", active: true });
    await postHeartbeat({ documentId: DOC_ID, status: "idle", active: false });

    const live = getPushConsumerLiveness();
    expect(live.eventCount).toBe(2);
    expect(typeof live.lastEventAt).toBe("number");
  });

  // A document id is NOT opaque: `docIdFromPath` builds it as
  // `<basename-slug>-<hash>`, so retaining one would put a filename into every
  // /health response for the life of the process — sourced from an unvalidated
  // body on a loopback-auth-exempt route, to answer a question the counters
  // already answer. Nothing ever read it.
  it("retains no document identifier", async () => {
    await postHeartbeat({ documentId: DOC_ID, status: "processing: x", active: true });
    expect(Object.keys(getPushConsumerLiveness()).sort()).toEqual(["eventCount", "lastEventAt"]);
    expect(JSON.stringify(getPushConsumerLiveness())).not.toContain(DOC_ID);
  });

  it("counts a doc-less heartbeat", async () => {
    await postHeartbeat({ documentId: null, status: "idle", active: false });
    expect(getPushConsumerLiveness().eventCount).toBe(1);
  });

  it("answers { ok: true } with no `written` field", async () => {
    // The handler writes nothing now, so `written` could only ever have meant
    // "your body carried a string documentId". docs/mcp-tools.md always
    // documented this response as `{ ok: true }`.
    const res = await postHeartbeat({ documentId: DOC_ID, status: "idle", active: false });
    expect(await res.json()).toEqual({ ok: true });
  });
});
