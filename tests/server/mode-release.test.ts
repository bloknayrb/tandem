import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addDoc,
  getOpenDocs,
  removeDoc,
  setActiveDocId,
} from "../../src/server/documents/registry.js";
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

function setMode(mode: string | undefined) {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => {
    const aw = ctrl.getMap(Y_MAP_USER_AWARENESS);
    if (mode === undefined) aw.delete(Y_MAP_MODE);
    else aw.set(Y_MAP_MODE, mode);
  });
}

const DOC_ID = "mode-release-doc";

function seedHeldDoc() {
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
  subscribe(cb);
  return { events, stop: () => unsubscribe(cb) };
}

beforeEach(() => {
  resetForTesting();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  setMode(undefined);
});

afterEach(() => {
  resetForTesting();
  setMode(undefined);
});

describe("handleModeRelease (WS-A2)", () => {
  it("flips mode to Tandem, clears markers across the doc, and wakes the monitor once", () => {
    const doc = seedHeldDoc();
    setMode("solo");
    const { events, stop } = collect();

    const { res, captured } = mockRes();
    handleModeRelease(mockReq(), res);
    stop();

    // Mode is now Tandem.
    expect(readModeState()).toBe("tandem");

    // Both markers cleared, rev bumped.
    const a1 = doc.getMap(Y_MAP_ANNOTATIONS).get("a1") as Record<string, unknown>;
    const r1 = doc.getMap(Y_MAP_ANNOTATION_REPLIES).get("r1") as Record<string, unknown>;
    expect(a1.heldInSolo).toBeUndefined();
    expect(r1.heldInSolo).toBeUndefined();
    expect(a1.rev as number).toBeGreaterThan(1);
    expect(r1.rev as number).toBeGreaterThan(1);

    // Response reports the release count.
    expect(captured.body.data.released).toBe(2);

    // Exactly one synthetic wake, with a disjoint wake_ id (no dedup poison).
    const wakes = events.filter(
      (e) => e.type === "annotation:created" && e.payload.annotationId.startsWith("wake_"),
    );
    expect(wakes).toHaveLength(1);
  });

  it("wakes even when mode already reads Tandem at entry, as long as held content is released (race-immunity regression)", () => {
    // Simulates the real client flow: its CRDT mode-broadcast lands mode=Tandem
    // in CTRL_ROOM before this HTTP round-trip, so a prior-mode read would see
    // "tandem" and (under the old gate) wrongly suppress the wake. The gate is
    // now the marker-clear count, so the wake fires because content was released.
    seedHeldDoc();
    setMode("tandem");
    const { events, stop } = collect();

    const { res, captured } = mockRes();
    handleModeRelease(mockReq(), res);
    stop();

    expect(captured.body.data.released).toBe(2);
    const wakes = events.filter(
      (e) => e.type === "annotation:created" && e.payload.annotationId.startsWith("wake_"),
    );
    expect(wakes).toHaveLength(1);
  });

  it("is idempotent — a repeat release finds nothing held and fires no second wake", () => {
    seedHeldDoc();
    setMode("solo");
    const { events, stop } = collect();

    const first = mockRes();
    handleModeRelease(mockReq(), first.res);
    expect(first.captured.body.data.released).toBe(2);

    // Second call: markers already cleared, mode already Tandem → releases 0.
    const second = mockRes();
    handleModeRelease(mockReq(), second.res);
    expect(second.captured.body.data.released).toBe(0);
    stop();

    // Exactly ONE wake across both calls — no duplicate on the repeat.
    const wakes = events.filter(
      (e) => e.type === "annotation:created" && e.payload.annotationId.startsWith("wake_"),
    );
    expect(wakes).toHaveLength(1);
  });

  it("rejects a non-loopback origin (origin-allowlist gate)", () => {
    seedHeldDoc();
    setMode("solo");
    const req = {
      headers: { origin: "https://evil.example.com" },
      socket: { remoteAddress: "127.0.0.1" },
      body: {},
    } as unknown as Request;
    const { res, captured } = mockRes();
    handleModeRelease(req, res);
    expect(captured.status).toBe(403);
    // Mode NOT flipped — the gate returned before any mutation.
    expect(readModeState()).toBe("solo");
  });
});
