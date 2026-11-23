/**
 * The push stream under ownership (#2358 PR 4a, ships dark; ADR-054's
 * amendment of that name; ownership design §8.6, §9.1, R3.4).
 *
 * Two things land on `/api/events`:
 *
 * - **Narrowing.** Each stream's `X-Claude-Session-Id` is mapped, per event,
 *   to a record: Tandem's Claude's current session id to the `tandem` record
 *   while it is present, else to that spawn's `unbound-child` record (and an
 *   id an earlier child used, never through rule 2); a live `claude:<id>`
 *   record to itself; anything else, or no header, is unmapped and gets
 *   today's stream. A mapped stream gets an event whose document its record
 *   holds or nobody holds, a chat event whose message it owns or may claim,
 *   and every non-chat event with no document. Live and on replay, wake-mode
 *   streams included.
 * - **The `ownership-changed` nudge.** Whenever ownership asks for the
 *   `/api/wake` `ownership` frame, every stream, mapped or not, gets one
 *   `event: ownership-changed` frame with no `id:` and `data: {}`, coalesced,
 *   with the licence asked at the write.
 *
 * The world: `sseHandler` driven with a request and response stand-in (as
 * `events/sse-wake-filter.test.ts` does), events pushed through the real queue
 * (`_pushEventForTests`), ownership's frame sink set exactly as
 * `src/server/index.ts` sets it, the real waiting probe and chat side by
 * default (a stub chat side where a row needs a message's facts without CTRL
 * rows). A lapse is the grace on a real (short) timer.
 *
 * Platform: no files on disk (registry-only documents), no sockets.
 */

import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { addDoc, removeDoc } from "../../src/server/documents/registry-testing.js";
import { _pushEventForTests, resetForTesting } from "../../src/server/events/queue.js";
import {
  requestOwnershipChangedEvent,
  setOwnershipChangedDelayForTests,
  sseHandler,
} from "../../src/server/events/sse.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import { requestOwnershipFrame } from "../../src/server/events/wake-socket.js";
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
  inboxOwnership,
  noteTransportChanged,
  noteTransportRegistered,
  type OwnershipChatSide,
  pushStreamAdmits,
  resetOwnershipForTests,
  setDocOwner,
  setGraceMsForTests,
  setOpenDocumentIdsSource,
  setOwnershipChatSide,
  setOwnershipFrameSink,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setOwnSpawnSource,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { parseTandemEvent } from "../../src/shared/events/types.js";
import {
  OWNERSHIP_CHANGED_SSE_EVENT,
  OWNERSHIP_CHANGED_SSE_FRAME,
} from "../../src/shared/events/wake-scope.js";
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

/** Header values, and the records they name. */
const ID_A = "push-a";
const ID_B = "push-b";
const A = `claude:${ID_A}`;
const B = `claude:${ID_B}`;
const GRACE_MS = 20;
const FRAME_MS = 20;
/** Long enough for a grace and a coalescing window, several times over. */
const SETTLE_MS = 200;
const SECRET = "the secret is hunter2";

let view: TransportViewEntry[];
let run = 0;
let clock = 1_000;
let seq = 0;
const docIds: string[] = [];
const opened: Array<() => void> = [];

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
  const id = `push${run}-${name}`;
  const ydoc = getOrCreateDocument(id);
  if (ydoc.getXmlFragment("default").length === 0) {
    populateYDoc(ydoc, "Hello world, this is a test document.");
  }
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  docIds.push(id);
  return { id, ydoc };
}

function hold(documentId: string, ownerId: string): void {
  setDocOwner(documentId, { ownerId, kind: "claimed" }, "claim", ownerId);
}

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

interface Stream {
  writes: string[];
  ended: () => boolean;
  /** The ids of the events written, in order. */
  ids: () => string[];
  /** How many `ownership-changed` frames were written. */
  nudges: () => number;
}

/** Open an `/api/events` stream, sending `sessionId` as `X-Claude-Session-Id`. */
function connect(sessionId?: string, opts: { lastEventId?: string; wake?: boolean } = {}): Stream {
  const handlers: Record<string, () => void> = {};
  const headers: Record<string, string> = {};
  if (sessionId !== undefined) headers["x-claude-session-id"] = sessionId;
  if (opts.lastEventId !== undefined) headers["last-event-id"] = opts.lastEventId;
  const req = {
    query: opts.wake ? { filter: "wake" } : {},
    headers,
    on: (event: string, cb: () => void) => {
      handlers[event] = cb;
    },
  } as unknown as Request;
  const writes: string[] = [];
  let ended = false;
  const res = {
    writeHead: vi.fn(),
    status: vi.fn(() => ({ json: vi.fn() })),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      ended = true;
    }),
    get writableEnded() {
      return ended;
    },
  } as unknown as Response;
  sseHandler(req, res);
  opened.push(() => handlers.close?.());
  return {
    writes,
    ended: () => ended,
    ids: () => writes.filter((w) => w.startsWith("id: ")).map((w) => w.slice(4).trim()),
    nudges: () => writes.filter((w) => w === OWNERSHIP_CHANGED_SSE_FRAME).length,
  };
}

function annotationOn(documentId: string | undefined, id = `evt_${++seq}`): TandemEvent {
  return {
    id,
    type: "annotation:accepted",
    timestamp: Date.now(),
    ...(documentId !== undefined ? { documentId } : {}),
    payload: { annotationId: `ann_${seq}`, textSnippet: SECRET },
  } as TandemEvent;
}

function chat(messageId: string, documentId?: string): TandemEvent {
  return {
    id: `evt_${++seq}`,
    type: "chat:message",
    timestamp: Date.now(),
    ...(documentId !== undefined ? { documentId } : {}),
    payload: { messageId, text: SECRET, replyTo: null, anchor: null },
  } as TandemEvent;
}

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

beforeEach(() => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  run++;
  licence.refuse = false;
  resetForTesting();
  resetInbox();
  resetOwnershipForTests();
  setWaitingWrittenSinceForTests(undefined);
  setGraceMsForTests(GRACE_MS);
  setOwnershipChangedDelayForTests(FRAME_MS);
  view = [];
  setTransportView(() => view);
  setTandemPresenceSource(() => false);
  // The lines of `src/server/index.ts`.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setWaitingProbe(documentWaiting);
  setOpenDocumentIdsSource(() => getOpenDocs().keys());
  setOwnershipChatSide(ownershipChatSide);
  setOwnershipFrameSink(() => {
    requestOwnershipFrame();
    requestOwnershipChangedEvent();
  });
  setCtrlMode("tandem");
});

afterEach(() => {
  for (const close of opened.splice(0)) close();
  for (const id of docIds.splice(0)) removeDoc(id);
  resetOwnershipForTests();
  resetInbox();
  resetForTesting();
  setWaitingProbe(() => false);
  setOwnershipChangedDelayForTests(undefined);
  setWaitingWrittenSinceForTests(undefined);
  licence.refuse = false;
  vi.unstubAllEnvs();
});

describe("narrowing by document (ownership design §9.1)", () => {
  /** d1 held by A, d2 by B, d3 by nobody; one event on each, and one on none. */
  function world() {
    register(A);
    register(B);
    const d1 = mkDoc("a").id;
    const d2 = mkDoc("b").id;
    const d3 = mkDoc("free").id;
    hold(d1, A);
    hold(d2, B);
    const events = {
      a: annotationOn(d1),
      b: annotationOn(d2),
      free: annotationOn(d3),
      none: annotationOn(undefined),
    };
    return { d1, d2, d3, events };
  }

  function pushAll(events: Record<string, TandemEvent>): void {
    for (const e of Object.values(events)) _pushEventForTests(e);
  }

  it("a mapped stream gets its own documents, unowned ones and document-less events", () => {
    const { events } = world();
    const a = connect(ID_A);
    const b = connect(ID_B);
    pushAll(events);
    expect(a.ids()).toEqual([events.a.id, events.free.id, events.none.id]);
    expect(b.ids()).toEqual([events.b.id, events.free.id, events.none.id]);
    // Never the other record's content.
    expect(a.writes.join("")).not.toContain(events.b.id);
  });

  it("the header is case-folded as the records are", () => {
    const { events } = world();
    const a = connect(ID_A.toUpperCase());
    pushAll(events);
    expect(a.ids()).toEqual([events.a.id, events.free.id, events.none.id]);
  });

  it("an unmapped stream and a stream with no header get today's stream (R3.4)", () => {
    const { events } = world();
    const stranger = connect("push-nobody");
    const bare = connect();
    pushAll(events);
    const all = [events.a.id, events.b.id, events.free.id, events.none.id];
    expect(stranger.ids()).toEqual(all);
    expect(bare.ids()).toEqual(all);
    // Byte for byte: an unmapped stream's writes are a bare stream's.
    expect(stranger.writes).toEqual(bare.writes);
  });

  it("on replay too: a mapped stream's replay is narrowed, an unmapped one's is whole", () => {
    const { events } = world();
    pushAll(events);
    // An unknown id replays the whole buffer.
    const a = connect(ID_A, { lastEventId: "evt_unknown" });
    const bare = connect(undefined, { lastEventId: "evt_unknown" });
    expect(a.ids()).toEqual([events.a.id, events.free.id, events.none.id]);
    expect(bare.ids()).toEqual([events.a.id, events.b.id, events.free.id, events.none.id]);
  });

  it("a wake-mode stream is narrowed the same way", () => {
    const { events } = world();
    const a = connect(ID_A, { wake: true });
    pushAll(events);
    expect(a.ids()).toEqual([events.a.id, events.free.id, events.none.id]);
    // Still payload-free.
    expect(a.writes.join("")).not.toContain(SECRET);
  });

  it("the header is mapped per event: a stream opened before its record is narrowed once it exists", () => {
    register(B);
    const d2 = mkDoc("b").id;
    hold(d2, B);
    const early = connect("push-c");
    const first = annotationOn(d2);
    _pushEventForTests(first);
    register("claude:push-c");
    const second = annotationOn(d2);
    _pushEventForTests(second);
    expect(early.ids()).toEqual([first.id]);
  });

  it("once a record lapses away, its stream is unmapped again", async () => {
    const { d2 } = world();
    const a = connect(ID_A);
    drop(A);
    await settle();
    const later = annotationOn(d2);
    _pushEventForTests(later);
    expect(a.ids()).toEqual([later.id]);
  });

  it("flag off: every stream gets every event, byte for byte", () => {
    const { events } = world();
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const a = connect(ID_A);
    const bare = connect();
    pushAll(events);
    expect(a.ids()).toEqual([events.a.id, events.b.id, events.free.id, events.none.id]);
    expect(a.writes).toEqual(bare.writes);
  });
});

describe("narrowing chat (ownership design §7.1, §9.1)", () => {
  /** A stub chat side whose rows are `facts`. */
  function stubChat(
    facts: Record<string, { documentId?: string; documentOpen: boolean; localPeriod?: boolean }>,
  ): OwnershipChatSide {
    return {
      handledKeys: () => new Set<string>(),
      messagesOn: () => [],
      unhandledKeys: () => Object.keys(facts),
      message: (key) => {
        const f = facts[key];
        return f ? { ...f, localPeriod: f.localPeriod ?? false } : undefined;
      },
      reOwe: () => {},
      settleCandidates: () => [],
      addSettles: () => [],
      owedToFreshReader: () => [],
    };
  }

  it("a mapped stream gets chat it owns or may claim, and not another record's", () => {
    register(A);
    register(B);
    const d1 = mkDoc("a").id;
    const d2 = mkDoc("b").id;
    const d3 = mkDoc("free").id;
    hold(d1, A);
    hold(d2, B);
    setOwnershipChatSide(
      stubChat({
        "m-a": { documentId: d1, documentOpen: true },
        "m-b": { documentId: d2, documentOpen: true },
        "m-free-doc": { documentId: d3, documentOpen: true },
        "m-docless": { documentOpen: false },
        "m-b-own": { documentOpen: false },
      }),
    );
    // B owns `m-b-own` per message, as a poll's commit makes it.
    const out = { owners: [] as string[], handed: [] as string[] };
    inboxOwnership
      .begin({ ownerId: B }, [], performance.now())
      .commitChat(["m-b-own"], ["m-b-own"], out);
    expect(out.owners).toEqual(["m-b-own"]);

    const a = connect(ID_A);
    const bare = connect();
    const ev = {
      a: chat("m-a", d1),
      b: chat("m-b", d2),
      freeDoc: chat("m-free-doc", d3),
      docless: chat("m-docless"),
      bOwn: chat("m-b-own"),
      gone: chat("m-gone"),
    };
    for (const e of Object.values(ev)) _pushEventForTests(e);
    expect(a.ids()).toEqual([ev.a.id, ev.freeDoc.id, ev.docless.id]);
    expect(bare.ids()).toEqual(Object.values(ev).map((e) => e.id));
  });

  it("doc-less chat is Tandem's Claude's while it is present: a terminal's stream does not get it", () => {
    register(A);
    setTandemPresenceSource(() => true);
    setOwnershipChatSide(stubChat({ "m-docless": { documentOpen: false } }));
    const a = connect(ID_A);
    _pushEventForTests(chat("m-docless"));
    expect(a.ids()).toEqual([]);
  });
});

describe("Tandem's Claude's session id (ownership design §9.1 rule 1)", () => {
  const CHILD = "child-current";
  const OLD = "child-old";

  function world(present: { value: boolean }, spawn: { value: boolean }) {
    setTandemPresenceSource(() => present.value);
    setOwnSpawnSource(
      () => (spawn.value ? { n: 3, sessionId: CHILD } : null),
      (id) => id === CHILD || id === OLD,
    );
    register(A);
    const dT = mkDoc("tandem").id;
    const dA = mkDoc("a").id;
    const dFree = mkDoc("free").id;
    setDocOwner(dT, { ownerId: TANDEM_OWNER_ID, kind: "default" }, "claim", TANDEM_OWNER_ID);
    hold(dA, A);
    return { t: annotationOn(dT), a: annotationOn(dA), free: annotationOn(dFree) };
  }

  it("while present (bound): the tandem record's documents and unowned ones", () => {
    const ev = world({ value: true }, { value: true });
    const child = connect(CHILD);
    for (const e of Object.values(ev)) _pushEventForTests(e);
    expect(child.ids()).toEqual([ev.t.id, ev.free.id]);
  });

  it("while unbound: the spawn's unbound-child record, which holds nothing here", () => {
    const present = { value: true };
    const ev = world(present, { value: true });
    present.value = false;
    const child = connect(CHILD);
    for (const e of Object.values(ev)) _pushEventForTests(e);
    expect(child.ids()).toEqual([ev.free.id]);
  });

  it("with no spawn current, or an earlier child's id, unmapped, never through rule 2", () => {
    const spawn = { value: true };
    const ev = world({ value: true }, spawn);
    // A `claude:` record under the old child's id must not map its stream.
    register(`claude:${OLD}`);
    const old = connect(OLD);
    spawn.value = false;
    const child = connect(CHILD);
    for (const e of Object.values(ev)) _pushEventForTests(e);
    const all = [ev.t.id, ev.a.id, ev.free.id];
    expect(old.ids()).toEqual(all);
    expect(child.ids()).toEqual(all);
  });
});

describe("the ownership-changed nudge (ownership design §8.6, §9.1)", () => {
  it("a lapse to unowned with work waiting nudges every stream once, with no id and no payload", async () => {
    const d = mkDoc("lapse");
    userComment(d.ydoc, "c1");
    register(A);
    register(B);
    hold(d.id, A);
    const mapped = connect(ID_B);
    const unmapped = connect("push-nobody");
    const bare = connect();
    const wake = connect(ID_B, { wake: true });
    await settle();
    for (const s of [mapped, unmapped, bare, wake]) expect(s.nudges()).toBe(0);

    drop(A);
    await settle();
    for (const s of [mapped, unmapped, bare, wake]) {
      expect(s.nudges()).toBe(1);
      expect(s.ids()).toEqual([]);
      expect(s.writes.join("")).not.toContain(SECRET);
      expect(s.writes.join("")).not.toContain(d.id);
    }
    expect(OWNERSHIP_CHANGED_SSE_FRAME).toBe(`event: ${OWNERSHIP_CHANGED_SSE_EVENT}\ndata: {}\n\n`);
  });

  it("nothing waiting nudges nobody (anchor: the row above)", async () => {
    const d = mkDoc("empty");
    register(A);
    hold(d.id, A);
    const s = connect();
    drop(A);
    await settle();
    expect(s.nudges()).toBe(0);
  });

  it("coalesces a burst into one frame, then writes again after the window", async () => {
    const s = connect();
    for (let i = 0; i < 5; i++) requestOwnershipChangedEvent();
    await settle();
    expect(s.nudges()).toBe(1);
    requestOwnershipChangedEvent();
    await settle();
    expect(s.nudges()).toBe(2);
  });

  it("with no stream open a request arms nothing, and a stream opened later gets nothing for it", async () => {
    requestOwnershipChangedEvent();
    const s = connect();
    await settle();
    expect(s.nudges()).toBe(0);
  });

  it("a closed stream is not written to", async () => {
    const s = connect();
    for (const close of opened.splice(0)) close();
    requestOwnershipChangedEvent();
    await settle();
    expect(s.nudges()).toBe(0);
  });

  it("a licence refusal ends every stream and writes nothing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = connect();
    const b = connect(ID_A);
    requestOwnershipChangedEvent();
    licence.refuse = true;
    await settle();
    for (const s of [a, b]) {
      expect(s.ended()).toBe(true);
      expect(s.nudges()).toBe(0);
    }
    expect(errors.mock.calls.map((c) => c.join(" "))).toContain(
      "[SSE] Stream ended: AI features are unlicensed",
    );
    // Ended streams are forgotten: a later nudge writes nothing.
    licence.refuse = false;
    requestOwnershipChangedEvent();
    await settle();
    for (const s of [a, b]) expect(s.nudges()).toBe(0);
    errors.mockRestore();
  });

  it("flag off: a lapse with work waiting nudges nothing (anchor: the first row)", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const d = mkDoc("dark");
    userComment(d.ydoc, "c1");
    register(A);
    hold(d.id, A);
    const s = connect();
    drop(A);
    await settle();
    expect(s.nudges()).toBe(0);
  });

  it("what an older consumer sees: `{}` is no event, and the frame moves no Last-Event-ID", () => {
    expect(parseTandemEvent({})).toBeNull();
    expect(OWNERSHIP_CHANGED_SSE_FRAME).not.toMatch(/^id: /m);
  });
});

describe("pushStreamAdmits", () => {
  it("is true at its first line while ownership is off", () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    register(A);
    expect(pushStreamAdmits(ID_A, { chatMessageKey: "nothing" })).toBe(true);
  });
});
