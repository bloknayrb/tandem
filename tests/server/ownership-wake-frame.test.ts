/**
 * The `ownership` frame on `/api/wake` (#2358 PR 3b-2d, ships dark; ADR-054's
 * amendment of that name; ownership design §4.4, §8.6, §8.7).
 *
 * Step 5 of `setDocOwner` sends it when a change gives a document to a record
 * that is not Tandem's Claude and is not the caller, or leaves it unowned, with
 * work waiting on it; a release of per-message owners (a lapse, a deleted
 * record, the end of presence) sends it when a released message is now another
 * record's, claimable, or follows an unowned document. The wake socket's
 * writer coalesces requests into one frame, asks the licence when it writes,
 * and names three fields.
 *
 * The world: a real wake socket on a loopback HTTP server, with ownership's
 * frame sink set to its `requestOwnershipFrame` as `src/server/index.ts` sets
 * it, the real waiting probe (`documentWaiting`, so the Solo hold is the real
 * one) and the real chat side, except where a row swaps in a stub chat side to
 * give a record a per-message owner without an MCP poll. A lapse is the grace
 * on a real (short) timer. "No frame" is judged after a wait several times the
 * coalescing window; each such row's anchor is the positive row it differs
 * from, named in its title.
 *
 * Platform: no files on disk (registry-only documents), loopback only.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type * as Y from "yjs";
import { addDoc, removeDoc } from "../../src/server/documents/registry-testing.js";
import { _pushEventForTests } from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import {
  attachWakeSocket,
  requestOwnershipFrame,
  setOwnershipFrameDelayForTests,
  WAKE_CLOSE_LICENSE_REQUIRED,
} from "../../src/server/events/wake-socket.js";
import {
  documentWaiting,
  handOverDocumentInbox,
  ownershipChatSide,
  resetInbox,
  setWaitingWrittenSinceForTests,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  getDocOwner,
  inboxOwnership,
  noteTandemPresence,
  noteTransportChanged,
  noteTransportRegistered,
  type OwnershipChatSide,
  resetOwnershipForTests,
  setDocOwner,
  setGraceMsForTests,
  setOpenDocumentIdsSource,
  setOwnershipChatSide,
  setOwnershipFrameSink,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { OWNERSHIP_WAKE_FRAME_TYPE } from "../../src/shared/events/wake-scope.js";
import { LICENSE_REQUIRED } from "../../src/shared/license-copy.js";
import { withBrowser } from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";

const licence = vi.hoisted(() => ({ refuse: false }));
vi.mock("../../src/server/license/ai-refusal.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/server/license/ai-refusal.js")>();
  return {
    ...real,
    aiRefusal: () =>
      licence.refuse
        ? { error: "LICENSE_REQUIRED", message: "Tandem is not licensed.", kind: "unlicensed" }
        : real.aiRefusal(),
  };
});

const A = "claude:frame-a";
const B = "claude:frame-b";
const GRACE_MS = 20;
const FRAME_MS = 20;
/** Long enough for a grace, a coalescing window and a socket write, several times over. */
const SETTLE_MS = 200;

let server: Server;
let detach: () => void;
let url: string;
let view: TransportViewEntry[];
let run = 0;
const sockets: WebSocket[] = [];
const docIds: string[] = [];

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 0 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

/** `owner`'s transport goes; its grace (GRACE_MS, real time) lapses it. */
function drop(owner: string): void {
  view = view.filter((e) => e.ownerId !== owner);
  noteTransportChanged(owner);
}

function mkDoc(name: string): { id: string; ydoc: Y.Doc } {
  const id = `frame${run}-${name}`;
  const ydoc = getOrCreateDocument(id);
  if (ydoc.getXmlFragment("default").length === 0) {
    populateYDoc(ydoc, "Hello world, this is a test document.");
  }
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  docIds.push(id);
  return { id, ydoc };
}

let clock = 1_000;
const SECRET = "the secret is hunter2";

/** A user comment, written as the browser writes one. */
function userComment(ydoc: Y.Doc, id: string): void {
  withBrowser(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: SECRET,
      status: "pending",
      timestamp: clock++,
      rev: 1,
    }),
  );
}

/** An armed wake consumer, and every frame it has received. */
async function arm(): Promise<{ ws: WebSocket; frames: string[]; closed: Promise<number> }> {
  const ws = new WebSocket(`${url}/api/wake`);
  sockets.push(ws);
  const frames: string[] = [];
  ws.on("message", (d) => frames.push(String(d)));
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, frames, closed };
}

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

/** One frame, and it is the ownership frame and nothing more. */
function expectOneOwnershipFrame(frames: string[], ...absent: string[]): void {
  expect(frames).toHaveLength(1);
  const frame = JSON.parse(frames[0] as string) as Record<string, unknown>;
  expect(Object.keys(frame).sort()).toEqual(["id", "timestamp", "type"]);
  expect(frame.type).toBe(OWNERSHIP_WAKE_FRAME_TYPE);
  expect(typeof frame.id).toBe("string");
  expect(typeof frame.timestamp).toBe("number");
  for (const text of [SECRET, A, B, ...absent]) expect(frames[0]).not.toContain(text);
}

beforeEach(async () => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  run++;
  licence.refuse = false;
  resetInbox();
  resetOwnershipForTests();
  setWaitingWrittenSinceForTests(undefined);
  setGraceMsForTests(GRACE_MS);
  setOwnershipFrameDelayForTests(FRAME_MS);
  view = [];
  setTransportView(() => view);
  setTandemPresenceSource(() => false);
  // The lines of `src/server/index.ts`.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setWaitingProbe(documentWaiting);
  setOpenDocumentIdsSource(() => getOpenDocs().keys());
  setOwnershipChatSide(ownershipChatSide);
  setOwnershipFrameSink(requestOwnershipFrame);
  setCtrlMode("tandem");
  server = createServer((_req, res) => res.end("ok"));
  detach = attachWakeSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await Promise.all(
    sockets.splice(0).map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) return resolve();
          ws.once("close", () => resolve());
          ws.terminate();
        }),
    ),
  );
  detach();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const id of docIds.splice(0)) removeDoc(id);
  resetOwnershipForTests();
  resetInbox();
  setWaitingProbe(() => false);
  setOwnershipFrameDelayForTests(undefined);
  setWaitingWrittenSinceForTests(undefined);
  licence.refuse = false;
  vi.unstubAllEnvs();
});

describe("a document that goes unowned (the unscoped frame)", () => {
  it("a lapse to unowned with a user comment waiting writes one payload-free frame", async () => {
    const d = mkDoc("lapse");
    userComment(d.ydoc, "c1");
    register(A);
    const { frames } = await arm();
    // A's own claim wakes nobody: the caller is the new owner.
    setDocOwner(d.id, { ownerId: A, kind: "claimed" }, "claim", A);
    await settle();
    expect(frames).toEqual([]);

    drop(A);
    await settle();
    expect(getDocOwner(d.id)).toBeUndefined();
    expectOneOwnershipFrame(frames, d.id, "c1");
  });

  it("nothing waiting writes none (anchor: the lapse row above)", async () => {
    const d = mkDoc("empty");
    register(A);
    const { frames } = await arm();
    setDocOwner(d.id, { ownerId: A, kind: "claimed" }, "claim", A);
    drop(A);
    await settle();
    expect(getDocOwner(d.id)).toBeUndefined();
    expect(frames).toEqual([]);
  });

  it("a Solo-held comment is not waiting: no frame (anchor: the lapse row)", async () => {
    const d = mkDoc("solo");
    userComment(d.ydoc, "c1");
    register(A);
    const { frames } = await arm();
    setDocOwner(d.id, { ownerId: A, kind: "claimed" }, "claim", A);
    setCtrlMode("solo");
    drop(A);
    await settle();
    expect(getDocOwner(d.id)).toBeUndefined();
    expect(frames).toEqual([]);
  });

  it("a lapse of several documents writes one frame, not one per document", async () => {
    const d1 = mkDoc("burst1");
    const d2 = mkDoc("burst2");
    const d3 = mkDoc("burst3");
    for (const d of [d1, d2, d3]) userComment(d.ydoc, `c-${d.id}`);
    register(A);
    const { frames } = await arm();
    for (const d of [d1, d2, d3]) setDocOwner(d.id, { ownerId: A, kind: "claimed" }, "claim", A);
    drop(A);
    await settle();
    expectOneOwnershipFrame(frames, d1.id, d2.id, d3.id);
  });

  it("the end of presence with a comment waiting writes one frame (a failed bind's release)", async () => {
    // A failed bind makes Tandem's Claude not present (ownership design §8.7),
    // which reaches here as presence's end.
    const d = mkDoc("presence");
    userComment(d.ydoc, "c1");
    let present = true;
    setTandemPresenceSource(() => present);
    const { frames } = await arm();
    setDocOwner(d.id, { ownerId: TANDEM_OWNER_ID, kind: "claimed" }, "claim", TANDEM_OWNER_ID);
    present = false;
    noteTandemPresence(false);
    await settle();
    expect(getDocOwner(d.id)).toBeUndefined();
    expectOneOwnershipFrame(frames, d.id);
  });

  it("every armed socket gets the frame: unscoped until Phase 3", async () => {
    const d = mkDoc("two");
    userComment(d.ydoc, "c1");
    register(A);
    const one = await arm();
    const two = await arm();
    setDocOwner(d.id, { ownerId: A, kind: "claimed" }, "claim", A);
    drop(A);
    await settle();
    expectOneOwnershipFrame(one.frames, d.id);
    expectOneOwnershipFrame(two.frames, d.id);
  });
});

describe("a document given to another record", () => {
  it("a change to B by someone other than B, with work waiting, writes one frame", async () => {
    const d = mkDoc("give");
    userComment(d.ydoc, "c1");
    register(A);
    register(B);
    const { frames } = await arm();
    setDocOwner(d.id, { ownerId: A, kind: "claimed" }, "claim", A);
    await settle();
    expect(frames).toEqual([]);
    // No production writer does this before PR 5's Assign; step 5 is general.
    setDocOwner(d.id, { ownerId: B, kind: "assigned" }, "claim");
    await settle();
    expect(getDocOwner(d.id)?.ownerId).toBe(B);
    expectOneOwnershipFrame(frames, d.id);
  });

  it("B's own claim, take or poll wakes nobody (anchor: the row above)", async () => {
    const d = mkDoc("own");
    userComment(d.ydoc, "c1");
    register(A);
    register(B);
    const { frames } = await arm();
    setDocOwner(d.id, { ownerId: A, kind: "claimed" }, "claim", A);
    setDocOwner(d.id, { ownerId: B, kind: "claimed" }, "take", B);
    await settle();
    expect(getDocOwner(d.id)?.ownerId).toBe(B);
    expect(frames).toEqual([]);
  });

  it("a change to Tandem's Claude is the forward's, never a frame (anchor: the give row)", async () => {
    const d = mkDoc("tandem");
    userComment(d.ydoc, "c1");
    setTandemPresenceSource(() => true);
    const { frames } = await arm();
    setDocOwner(d.id, { ownerId: TANDEM_OWNER_ID, kind: "default" }, "presence");
    await settle();
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM_OWNER_ID);
    expect(frames).toEqual([]);
  });

  it("nothing waiting writes none (anchor: the give row)", async () => {
    const d = mkDoc("give-empty");
    register(A);
    register(B);
    const { frames } = await arm();
    setDocOwner(d.id, { ownerId: A, kind: "claimed" }, "claim", A);
    setDocOwner(d.id, { ownerId: B, kind: "assigned" }, "claim");
    await settle();
    expect(frames).toEqual([]);
  });
});

describe("a message whose owner goes", () => {
  /** A stub chat side over one doc-less message `m1`. */
  function stubChat(owed: { value: boolean }): OwnershipChatSide {
    return {
      handledKeys: () => new Set<string>(),
      messagesOn: () => [],
      unhandledKeys: () => ["m1"],
      message: (key) => (key === "m1" ? { documentOpen: false, localPeriod: false } : undefined),
      reOwe: () => {},
      settleCandidates: () => [],
      addSettles: () => [],
      owedToFreshReader: () => (owed.value ? ["m1"] : []),
    };
  }

  /** Give A the per-message owner of `m1`, as a poll's commit does. */
  function aOwnsM1(): void {
    const out = { owners: [] as string[], handed: [] as string[] };
    inboxOwnership.begin({ ownerId: A }, [], performance.now()).commitChat(["m1"], ["m1"], out);
    expect(out.owners).toEqual(["m1"]);
  }

  it("a lapse leaves a doc-less message claimable: one frame", async () => {
    setOwnershipChatSide(stubChat({ value: true }));
    register(A);
    aOwnsM1();
    const { frames } = await arm();
    drop(A);
    await settle();
    expectOneOwnershipFrame(frames, "m1");
  });

  it("a message nobody is owed writes none (anchor: the row above)", async () => {
    setOwnershipChatSide(stubChat({ value: false }));
    register(A);
    aOwnsM1();
    const { frames } = await arm();
    drop(A);
    await settle();
    expect(frames).toEqual([]);
  });

  it("chat held by presence alone is claimable at presence's end: one frame", async () => {
    setOwnershipChatSide(stubChat({ value: true }));
    let present = true;
    setTandemPresenceSource(() => present);
    const { frames } = await arm();
    present = false;
    noteTandemPresence(false);
    await settle();
    expectOneOwnershipFrame(frames, "m1");
  });
});

describe("the writer", () => {
  it("coalesces a burst of requests into one frame, then writes again after the window", async () => {
    const { frames } = await arm();
    for (let i = 0; i < 5; i++) requestOwnershipFrame();
    await settle();
    expect(frames).toHaveLength(1);
    requestOwnershipFrame();
    await settle();
    expect(frames).toHaveLength(2);
    expect(new Set(frames.map((f) => JSON.parse(f).id)).size).toBe(2);
  });

  it("a licence refusal closes the socket 4403 and writes nothing", async () => {
    const d = mkDoc("licence");
    userComment(d.ydoc, "c1");
    register(A);
    const { ws, frames, closed } = await arm();
    let reason = "";
    ws.once("close", (_code, r) => {
      reason = String(r);
    });
    setDocOwner(d.id, { ownerId: A, kind: "claimed" }, "claim", A);
    licence.refuse = true;
    drop(A);
    expect(await closed).toBe(WAKE_CLOSE_LICENSE_REQUIRED);
    expect(reason).toBe(LICENSE_REQUIRED);
    expect(frames).toEqual([]);
  });
});

describe("flag off", () => {
  it("writes nothing, and the event frames are master's, byte for byte", async () => {
    const d = mkDoc("dark");
    userComment(d.ydoc, "c1");
    register(A);
    setDocOwner(d.id, { ownerId: A, kind: "claimed" }, "claim", A);
    let present = true;
    setTandemPresenceSource(() => present);
    const { frames } = await arm();
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    // Every path that sends the frame flag on, run flag off.
    setDocOwner(d.id, null, "lapse");
    setDocOwner(d.id, { ownerId: B, kind: "assigned" }, "claim");
    present = false;
    noteTandemPresence(false);
    drop(A);
    await settle();
    expect(frames).toEqual([]);

    // A wake-worthy event still gets exactly the frame it got before.
    _pushEventForTests({
      id: "evt_dark_1",
      type: "chat:message",
      timestamp: 1234,
      payload: { messageId: "m1", text: SECRET },
    } as TandemEvent);
    await settle();
    expect(frames).toEqual(['{"id":"evt_dark_1","type":"chat:message","timestamp":1234}']);
  });
});
