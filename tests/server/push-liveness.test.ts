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
});

describe("push-consumer liveness recording", () => {
  it("starts empty so 'never attached' is distinguishable from 'quiet'", () => {
    expect(getPushConsumerLiveness()).toEqual({
      lastEventAt: null,
      lastDocumentId: null,
      eventCount: 0,
    });
  });

  it("counts heartbeats and remembers the document", async () => {
    await postHeartbeat({ documentId: DOC_ID, status: "processing: x", active: true });
    await postHeartbeat({ documentId: DOC_ID, status: "idle", active: false });

    const live = getPushConsumerLiveness();
    expect(live.eventCount).toBe(2);
    expect(live.lastDocumentId).toBe(DOC_ID);
    expect(typeof live.lastEventAt).toBe("number");
  });

  // A doc-less heartbeat (a chat event, or the shutdown clear) must still count
  // as liveness without wiping the last-known document.
  it("counts a doc-less heartbeat without clearing lastDocumentId", async () => {
    await postHeartbeat({ documentId: DOC_ID, status: "processing: x", active: true });
    await postHeartbeat({ documentId: null, status: "idle", active: false });

    const live = getPushConsumerLiveness();
    expect(live.eventCount).toBe(2);
    expect(live.lastDocumentId).toBe(DOC_ID);
  });
});
