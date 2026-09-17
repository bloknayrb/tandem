/**
 * #1769 hole 1 — `POST /api/mode/release` used to write `Y_MAP_MODE = "tandem"`
 * with no read of the current value.
 *
 * A Solo → Tandem → Solo toggle sequence inside the POST's latency therefore
 * left the room reading "tandem" while the user's toggle showed Solo, AND swept
 * every `heldInSolo` marker on the way — so the user's comments were delivered
 * to Claude while the UI still promised they were held. The route now VERIFIES
 * instead of writing: 409 `MODE_NOT_TANDEM` when the room does not read Tandem.
 *
 * Window writes go in as REMOTE origins (`{ socketId }`, the Hocuspocus
 * `Connection` shape) applied from a scratch doc that is synced FIRST — without
 * the sync each write is concurrent with `beforeEach`'s delete and the row
 * passes or fails by clientID coin flip. Assertions are `toBe("solo")` rather
 * than `not.toBe("tandem")` for the same reason: "indeterminate" must not read
 * as a pass.
 */

import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getOpenDocs } from "../../src/server/documents/registry.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { resetForTesting, subscribe, unsubscribe } from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import { handleModeRelease } from "../../src/server/mcp/routes/mode-release.js";
import { readModeState } from "../../src/server/mode.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";

function mockReq(): Request {
  return {
    headers: { origin: "http://127.0.0.1:5173" },
    socket: { remoteAddress: "127.0.0.1" },
    body: {},
  } as unknown as Request;
}

function mockRes(): { res: Response; captured: { status: number; body: any } } {
  const captured = { status: 200, body: undefined as any };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, captured };
}

/**
 * A browser window writing the mode over its CRDT socket. Sync-first so the
 * write is causally AFTER whatever the ctrl doc already holds, then applied with
 * a `Connection`-shaped origin so nothing here looks like a server-side write.
 */
function windowWritesMode(socketId: string, mode: string): void {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(ctrl));
  const before = Y.encodeStateVector(scratch);
  scratch.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, mode);
  Y.applyUpdate(ctrl, Y.encodeStateAsUpdate(scratch, before), { socketId });
}

function clearMode(): void {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE));
}

const DOC_ID = "mode-release-race-doc";

function seedHeldDoc(): Y.Doc {
  const doc = getOrCreateDocument(DOC_ID);
  addDoc(DOC_ID, {
    id: DOC_ID,
    filePath: `/tmp/${DOC_ID}.md`,
    format: "md",
    readOnly: false,
    source: "file",
  });
  setActiveDocId(DOC_ID);
  withInternal(doc, () => {
    doc.getMap(Y_MAP_ANNOTATIONS).set("a1", {
      id: "a1",
      author: "user",
      type: "comment",
      range: { from: 0, to: 5 },
      content: "held comment",
      status: "pending",
      timestamp: 1,
      rev: 1,
      heldInSolo: true,
    });
    doc.getMap(Y_MAP_ANNOTATION_REPLIES).set("r1", {
      id: "r1",
      annotationId: "a1",
      author: "user",
      text: "held reply",
      timestamp: 2,
      rev: 1,
      heldInSolo: true,
    });
  });
  return doc;
}

function collect(): { events: TandemEvent[]; stop: () => void } {
  const events: TandemEvent[] = [];
  const cb = (e: TandemEvent) => events.push(e);
  subscribe(cb, "external");
  return { events, stop: () => unsubscribe(cb) };
}

function wakesIn(events: TandemEvent[]): TandemEvent[] {
  return events.filter(
    (e) => e.type === "annotation:created" && e.payload.annotationId.startsWith("wake_"),
  );
}

function markers(doc: Y.Doc): Array<unknown> {
  return [
    (doc.getMap(Y_MAP_ANNOTATIONS).get("a1") as Record<string, unknown>).heldInSolo,
    (doc.getMap(Y_MAP_ANNOTATION_REPLIES).get("r1") as Record<string, unknown>).heldInSolo,
  ];
}

beforeEach(() => {
  resetForTesting();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  clearMode();
});

afterEach(() => {
  resetForTesting();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  clearMode();
});

describe("#1769 the release route never writes the mode key", () => {
  it("refuses with 409 when the user toggled back to Solo inside the POST's latency", () => {
    // Row A, red on master: the toggle sequence the client makes is Solo→Tandem
    // (which fires the POST) then Tandem→Solo before it lands.
    const doc = seedHeldDoc();
    windowWritesMode("A", "tandem");
    windowWritesMode("A", "solo");
    const { events, stop } = collect();

    const { res, captured } = mockRes();
    handleModeRelease(mockReq(), res);
    stop();

    expect(captured.status).toBe(409);
    expect(captured.body.error).toBe("MODE_NOT_TANDEM");
    expect(captured.body.data.released).toBe(0);
    // The room still holds the user's last toggle, and nothing was released.
    expect(readModeState()).toBe("solo");
    expect(markers(doc)).toEqual([true, true]);
    expect(wakesIn(events)).toHaveLength(0);
  });

  it("releases and wakes once when the room genuinely reads Tandem", () => {
    const doc = seedHeldDoc();
    windowWritesMode("A", "tandem");
    const { events, stop } = collect();

    const { res, captured } = mockRes();
    handleModeRelease(mockReq(), res);
    stop();

    expect(captured.status).toBe(200);
    expect(captured.body.data.released).toBe(2);
    expect(readModeState()).toBe("tandem");
    expect(markers(doc)).toEqual([undefined, undefined]);
    expect(wakesIn(events)).toHaveLength(1);
  });

  it("refuses when the mode key is absent (indeterminate fails closed)", () => {
    // Kills a gate written as `!== "solo"`: indeterminate is the restart state,
    // where the held markers are the ONLY thing withholding the user's comments.
    const doc = seedHeldDoc();
    const { events, stop } = collect();

    const { res, captured } = mockRes();
    handleModeRelease(mockReq(), res);
    stop();

    expect(captured.status).toBe(409);
    expect(captured.body.error).toBe("MODE_NOT_TANDEM");
    expect(readModeState()).toBe("indeterminate");
    expect(markers(doc)).toEqual([true, true]);
    expect(wakesIn(events)).toHaveLength(0);
  });
});
