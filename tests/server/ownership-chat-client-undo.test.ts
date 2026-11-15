/**
 * A client connection's changes to the chat map are undone (#2358, the posts
 * PR, R4; Ruling 8). Ships dark: flag on except where a test says otherwise.
 *
 * Each case drives a REAL Hocuspocus connection to CTRL_ROOM, as
 * `license-armed-editing.test.ts` connects: the browser-shaped client writes
 * to its own copy of the chat map, the provider sends the update, and the
 * server applies it with the `Connection` as the transaction origin. The
 * undo is wired through the same function `src/server/index.ts` wires
 * (`setChatClientWritesUndone(undoClientChatWrites)`).
 *
 * After each write: every row is as it was before it (and a client-added
 * user row keeps only its own and the fixed fields), in the live doc and
 * after `saveCtrlSession` then `restoreCtrlDoc`; then M is unhandled (handed
 * to its owner once, then to the next owner after a lapse, cursor and
 * cursor-less in separate runs) wherever the forgery would have hidden it,
 * and handled where the undone write deleted the server reply that handled it.
 *
 * The one case not sent through the provider is the pending-struct forgery
 * (security review H1): a provider never sends an update it cannot integrate
 * itself, so that update is applied with a `Connection`-shaped origin, which
 * is exactly what Hocuspocus 2.15.3 passes (`MessageReceiver.apply`).
 *
 * Platform: loopback WebSocket on an ephemeral port; the CTRL session file in
 * vitest's throwaway app-data dir. Nothing is gated.
 */

import net from "node:net";
import { HocuspocusProvider, type HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import type { Hocuspocus } from "@hocuspocus/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { z } from "zod";
import { setChatClientWritesUndone } from "../../src/server/chat-client-writes.js";
import { setChatRowsDeletedListener } from "../../src/server/chat-row-deletions.js";
import { CHAT_FIELD_CATEGORY } from "../../src/server/events/observers/chat-client-undo.js";
import {
  attachCtrlObservers,
  resetForTesting as resetEventsForTesting,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import {
  ownershipChatSide,
  registerAwarenessTools,
  resetInbox,
} from "../../src/server/mcp/awareness.js";
import { settledChatIds } from "../../src/server/mcp/chat-handled.js";
import { deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  checkInboxOutputShape,
  checkInboxOwnershipShape,
} from "../../src/server/mcp/output-schemas.js";
import {
  __resetLocalPeriodForTests,
  __setHonourLocalPeriodRecordsForTests,
  isLocalPeriodChat,
} from "../../src/server/models/local-period.js";
import { restoreCtrlDoc, saveCtrlSession } from "../../src/server/session/manager.js";
import {
  DEFAULT_GRACE_MS,
  forgetChatMessageOwners,
  getOwnerRecord,
  noteTransportChanged,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setOwnershipChatSide,
  setOwnershipSeqSource,
  setTransportView,
  type TransportViewEntry,
  undoClientChatWrites,
} from "../../src/server/sessions/ownership.js";
import {
  getOrCreateDocument,
  installHocuspocusLifecycle,
  resetHocuspocusLifecycleForTesting,
  startHocuspocus,
} from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_CHAT } from "../../src/shared/constants.js";
import { withInternal, withMcp } from "../../src/shared/origins.js";
import type { ChatMessage } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";

class LoopbackOriginWebSocket extends WebSocket {
  constructor(url: string | URL) {
    super(url, [], { headers: { Origin: "http://127.0.0.1" } });
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Who answers chat, for #2419's classing (R4.6's test): "local" classes a new row local-period. */
const answerer = vi.hoisted(() => ({ local: false }));
vi.mock("../../src/server/models/chat-answerer.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/server/models/chat-answerer.js")>();
  return {
    ...real,
    chatAnswerer: () => (answerer.local ? "local" : real.chatAnswerer()),
  };
});

const GEN = "gen-chat-undo";
const A = "claude:undo-a";
const B = "claude:undo-b";
const inboxSchema = z.object({ ...checkInboxOutputShape, ...checkInboxOwnershipShape });

let hp: Hocuspocus;
let port: number;
let provider: HocuspocusProvider;
let clientDoc: Y.Doc;
let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs = A;
let run = 0;
let clock = 10_000;

/** Server-side reads re-fetch the room every time (the load swaps the doc). */
const serverChat = () => getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT);
const clientChat = () => clientDoc.getMap(Y_MAP_CHAT);
const serverRows = () => JSON.stringify(serverChat().toJSON());
const key = (name: string) => `undo${run}-${name}`;

beforeAll(async () => {
  installHocuspocusLifecycle({
    shouldKeepDocument: (name) => name === CTRL_ROOM,
    onDocSwapped: (name) => {
      if (name === CTRL_ROOM) attachCtrlObservers();
    },
    onDocUnloaded: () => {},
    expectedGenerationToken: () => GEN,
  });
  port = await freePort();
  hp = await startHocuspocus(port);
  clientDoc = new Y.Doc();
  provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: CTRL_ROOM,
    document: clientDoc,
    token: GEN,
    WebSocketPolyfill: LoopbackOriginWebSocket as unknown as typeof globalThis.WebSocket,
  } as HocuspocusProviderConfiguration);
  await waitFor(() => provider.isSynced, "the CTRL provider to sync");
});

afterAll(async () => {
  provider.destroy();
  await hp.destroy();
  resetHocuspocusLifecycleForTesting();
  resetEventsForTesting();
});

async function setWorld(flag: "1" | ""): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  callingAs = A;
  resetInbox();
  resetOwnershipForTests();
  view = [];
  setTransportView(() => view);
  for (const id of [A, B]) {
    view.push({ ownerId: id, openStreams: 0 });
    noteTransportRegistered(id, { recordKind: "claude" });
  }
  // The lines of `src/server/index.ts`.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipChatSide(ownershipChatSide);
  setChatRowsDeletedListener(forgetChatMessageOwners);
  setChatClientWritesUndone(undoClientChatWrites);
  setCtrlMode("tandem");
  await close?.();
  ({ client, close } = await setupMcpServer([registerAwarenessTools], {
    dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }),
  }));
}

beforeEach(async () => {
  await setWorld("1");
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setChatRowsDeletedListener(undefined);
  setChatClientWritesUndone(undefined);
  withInternal(getOrCreateDocument(CTRL_ROOM), () => serverChat().clear());
  await waitFor(() => clientChat().size === 0, "the client to see the clear");
  resetOwnershipForTests();
  resetInbox();
  vi.unstubAllEnvs();
});

/** Server-written rows, then wait for the client to have them. */
async function seed(rows: Record<string, ChatMessage>): Promise<void> {
  withMcp(getOrCreateDocument(CTRL_ROOM), () => {
    for (const [k, v] of Object.entries(rows)) serverChat().set(k, v);
  });
  await waitFor(
    () => Object.keys(rows).every((k) => clientChat().has(k)),
    "the client to see the seeded rows",
  );
}

const userRow = (k: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: k,
  author: "user",
  text: `text of ${k}`,
  timestamp: clock++,
  read: false,
  ...extra,
});
const claudeRow = (k: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: k,
  author: "claude",
  text: `reply ${k}`,
  timestamp: clock++,
  read: true,
  ...extra,
});

/**
 * The client writes; then wait until the server has applied it AND its
 * answer has reached the client (one server round trip): the undo arrives
 * as a server update, so the client's copy converges on the server's.
 */
async function clientWrites(write: (chat: Y.Map<unknown>) => void): Promise<void> {
  clientDoc.transact(() => write(clientChat()));
  const target = () => JSON.stringify(clientChat().toJSON());
  await waitFor(
    () => target() === serverRows(),
    "the client and the server to converge after the write",
  );
  // Event-bounded, not timed (review round 1, item 13): the client holds
  // the forged value until the server's answer arrives, so convergence means
  // the undo (or, flag off, the server's apply) has landed.
}

/** The rows after a save and a restore into a fresh doc. */
async function persistedRows(): Promise<string> {
  await saveCtrlSession(getOrCreateDocument(CTRL_ROOM));
  const { loadCtrlSession } = await import("../../src/server/session/manager.js");
  const saved = (await loadCtrlSession()) as string;
  const fresh = new Y.Doc();
  restoreCtrlDoc(fresh, saved);
  // `restoreCtrlDoc` drops `delivered`; compare like with like.
  const rows = fresh.getMap(Y_MAP_CHAT).toJSON() as Record<string, ChatMessage>;
  for (const r of Object.values(rows)) delete (r as { delivered?: true }).delivered;
  return JSON.stringify(rows);
}

function withoutDelivered(json: string): string {
  const rows = JSON.parse(json) as Record<string, ChatMessage>;
  for (const r of Object.values(rows)) delete (r as { delivered?: true }).delivered;
  return JSON.stringify(rows);
}

async function pollChat(
  owner: string,
  cursor?: string,
): Promise<{ ids: string[]; cursor: string }> {
  callingAs = owner;
  const result = await client.callTool({
    name: "tandem_checkInbox",
    arguments: cursor === undefined ? {} : { cursor },
  });
  expect(parseResult(result).error, JSON.stringify(result)).toBe(false);
  const inbox = inboxSchema.parse((result as { structuredContent: unknown }).structuredContent);
  return { ids: inbox.chatMessages.map((m) => String(m.id)), cursor: inbox.cursor };
}

/** M is unhandled: handed to its owner A once, then (after A lapses) to B. */
async function assertUnhandled(m: string, path: "cursor" | "cursor-less"): Promise<void> {
  expect(settledChatIds(serverChat()).has(m)).toBe(false);
  const first = await pollChat(A, path === "cursor" ? "start" : undefined);
  expect(first.ids, "handed to its owner").toContain(m);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  view = view.filter((e) => e.ownerId !== A);
  noteTransportChanged(A);
  vi.advanceTimersByTime(DEFAULT_GRACE_MS + 1);
  vi.useRealTimers();
  expect(getOwnerRecord(A)).toBeUndefined();
  const next = await pollChat(B, path === "cursor" ? "start" : undefined);
  expect(next.ids, "handed to the next owner after the lapse").toContain(m);
}

/** M is handled: no poll hands it. */
async function assertHandled(m: string): Promise<void> {
  expect(settledChatIds(serverChat()).has(m)).toBe(true);
  // Two consecutive cursor polls (the second with the first's cursor), and
  // two cursor-less ones (review round 1, item 11).
  const first = await pollChat(A, "start");
  expect(first.ids).not.toContain(m);
  expect((await pollChat(A, first.cursor)).ids).not.toContain(m);
  expect((await pollChat(B)).ids).not.toContain(m);
  expect((await pollChat(B)).ids).not.toContain(m);
}

interface Case {
  name: string;
  setup: () => Record<string, ChatMessage>;
  write: (chat: Y.Map<unknown>) => void;
  /** Whether M is handled once the write is undone. */
  handled: boolean;
}

const M = () => key("M");
const cases: Case[] = [
  {
    name: "a new Claude row with replyTo naming M",
    setup: () => ({ [M()]: userRow(M()) }),
    write: (chat) => chat.set(key("forged"), claudeRow(key("forged"), { replyTo: M() })),
    handled: false,
  },
  {
    name: "an existing user row turned Claude-authored with replyTo M",
    setup: () => ({ [M()]: userRow(M()), [key("u")]: userRow(key("u")) }),
    write: (chat) =>
      chat.set(key("u"), { ...(chat.get(key("u")) as object), author: "claude", replyTo: M() }),
    handled: false,
  },
  {
    name: "settles listing M added to a server-written final reply on another message",
    setup: () => ({
      [M()]: userRow(M()),
      [key("o")]: userRow(key("o")),
      [key("r")]: claudeRow(key("r"), { replyTo: key("o") }),
    }),
    write: (chat) => chat.set(key("r"), { ...(chat.get(key("r")) as object), settles: [M()] }),
    handled: false,
  },
  {
    name: "superseded on an acknowledgement row naming M",
    setup: () => ({
      [M()]: userRow(M()),
      [key("ack")]: claudeRow(key("ack"), { replyTo: M(), inProgress: true }),
    }),
    write: (chat) =>
      chat.set(key("ack"), { ...(chat.get(key("ack")) as object), superseded: true }),
    handled: false,
  },
  {
    name: "the removal of inProgress from a server-written acknowledgement of M",
    setup: () => ({
      [M()]: userRow(M()),
      [key("ack")]: claudeRow(key("ack"), { replyTo: M(), inProgress: true }),
    }),
    write: (chat) => {
      const { inProgress: _p, ...rest } = chat.get(key("ack")) as ChatMessage;
      chat.set(key("ack"), rest);
    },
    handled: false,
  },
  {
    name: "read: true on M",
    setup: () => ({ [M()]: userRow(M()) }),
    write: (chat) => chat.set(M(), { ...(chat.get(M()) as object), read: true }),
    handled: false,
  },
  {
    name: "delivered on M",
    setup: () => ({ [M()]: userRow(M()) }),
    write: (chat) => chat.set(M(), { ...(chat.get(M()) as object), delivered: true }),
    handled: false,
  },
  {
    name: "agentIdentity added to a server-written final reply to M",
    setup: () => ({
      [M()]: userRow(M()),
      [key("r")]: claudeRow(key("r"), { replyTo: M() }),
    }),
    write: (chat) =>
      chat.set(key("r"), {
        ...(chat.get(key("r")) as object),
        agentIdentity: { kind: "local", label: "x" },
      }),
    handled: true,
  },
  {
    name: "a server-written reply row deleted",
    setup: () => ({
      [M()]: userRow(M(), { read: true }),
      [key("r")]: claudeRow(key("r"), { replyTo: M() }),
    }),
    write: (chat) => chat.delete(key("r")),
    handled: true,
  },
  {
    name: "a user row added under an existing row's key",
    setup: () => ({
      [M()]: userRow(M()),
      [key("r")]: claudeRow(key("r"), { replyTo: key("o") }),
    }),
    write: (chat) => chat.set(key("r"), userRow(key("r"))),
    handled: false,
  },
  {
    name: "a user row added with read: true",
    setup: () => ({ [M()]: userRow(M()) }),
    write: (chat) => chat.set(key("n"), userRow(key("n"), { read: true })),
    handled: false,
  },
  {
    name: "a user row added with replyTo",
    setup: () => ({ [M()]: userRow(M()) }),
    write: (chat) => chat.set(key("n"), userRow(key("n"), { replyTo: M() })),
    handled: false,
  },
  {
    name: "a row whose value is not a plain object",
    setup: () => ({ [M()]: userRow(M()) }),
    write: (chat) => chat.set(key("n"), "not an object"),
    handled: false,
  },
];

describe("R4: each client write is undone (flag on)", () => {
  for (const c of cases) {
    for (const path of ["cursor", "cursor-less"] as const) {
      it(`${c.name} (${path})`, async () => {
        await seed(c.setup());
        const before = serverRows();
        await clientWrites(c.write);
        const after = JSON.parse(serverRows()) as Record<string, ChatMessage>;
        const expected = JSON.parse(before) as Record<string, ChatMessage>;
        // A client-added user row keeps only its own and the fixed fields.
        const added = Object.keys(after).filter((k) => !(k in expected));
        for (const k of added) {
          expect(after[k]?.author).toBe("user");
          expect(after[k]?.read).toBe(false);
          for (const field of Object.keys(after[k] as object)) {
            expect(CHAT_FIELD_CATEGORY[field as keyof ChatMessage]).not.toBe("server-only");
          }
          delete after[k];
        }
        expect(JSON.stringify(after)).toBe(before);
        // Exact (diff review, finding 4): what is saved and restored is what
        // the live doc holds after the undo, client-added user row included.
        expect(JSON.parse(withoutDelivered(await persistedRows()))).toEqual(
          JSON.parse(withoutDelivered(serverRows())),
        );
        if (c.handled) await assertHandled(M());
        else await assertUnhandled(M(), path);
      });
    }
  }

  it("a client-added user row keeps its own fields; a later client change to any of them is undone", async () => {
    await clientWrites((chat) => chat.set(key("n"), userRow(key("n"), { documentId: "doc-x" })));
    const kept = serverChat().get(key("n")) as ChatMessage;
    expect(kept.text).toBe(`text of ${key("n")}`);
    expect(kept.documentId).toBe("doc-x");
    const before = serverRows();
    for (const change of [{ text: "changed" }, { documentId: "doc-y" }, { timestamp: 1 }]) {
      await clientWrites((chat) =>
        chat.set(key("n"), { ...(chat.get(key("n")) as object), ...change }),
      );
      expect(serverRows()).toBe(before);
    }
  });

  it("a row whose own __proto__ key smuggles fields is not a user row: deleted (security review M1)", async () => {
    await seed({ [M()]: userRow(M()) });
    const before = serverRows();
    const smuggled = JSON.parse(
      `{"__proto__": {"author": "user", "read": true}, "id": "${key("p")}", "text": "x"}`,
    );
    await clientWrites((chat) => chat.set(key("p"), smuggled));
    expect(serverRows()).toBe(before);
  });
});

describe("diff review, finding 1: an own key named like an Object.prototype member", () => {
  it("a user row with an own `constructor` key, sent as a raw update, is reduced and later server writes to it work", async () => {
    await seed({ [M()]: userRow(M()) });
    const S = getOrCreateDocument(CTRL_ROOM);
    // The Yjs API cannot write such a value, so build the update with a
    // same-length placeholder key and patch its bytes.
    const C = new Y.Doc();
    Y.applyUpdate(C, Y.encodeStateAsUpdate(S));
    const k = key("ctor");
    C.getMap(Y_MAP_CHAT).set(k, { ...userRow(k), constructoX: "x" });
    const update = Y.encodeStateAsUpdate(C, Y.encodeStateVector(S));
    const from = new TextEncoder().encode("constructoX");
    const to = new TextEncoder().encode("constructor");
    let patched = 0;
    for (let i = 0; i + from.length <= update.length; i++) {
      if (from.every((b, j) => update[i + j] === b)) {
        update.set(to, i);
        patched++;
      }
    }
    expect(patched).toBe(1);
    Y.applyUpdate(S, update, { socketId: "a-browser-tab" });
    const row = serverChat().get(k) as Record<string, unknown>;
    expect(Object.hasOwn(row, "constructor")).toBe(false);
    expect(row.author).toBe("user");
    // A later server write that spreads the row (a poll's stamp) works.
    expect((await pollChat(A)).ids).toContain(k);
    expect((serverChat().get(k) as ChatMessage).read).toBe(true);
  });
});

describe("R4.2: an undone delete leaves the server memory keyed by the row as it was", () => {
  it("M's owner, answerer and A's handed memory survive a client delete of M; A's reply is judged as before", async () => {
    await seed({ [M()]: userRow(M()) });
    const first = await pollChat(A, "start");
    expect(first.ids).toContain(M());
    callingAs = A;
    expect(
      parseResult(
        await client.callTool({ name: "tandem_reply", arguments: { text: "x", replyTo: M() } }),
      ).error,
    ).toBe(false);
    const snap = () => {
      const s = ownershipSnapshotForTests();
      return JSON.stringify([s.messageOwners, s.chatAnswerers, s.handed]);
    };
    const before = snap();
    expect(before).toContain(M());
    // Wait until the client holds the server's current M (the poll's and the
    // reply's stamps), so its delete hits the live item (diff review,
    // finding 2), and watch that the server really saw a client delete.
    await waitFor(
      () => JSON.stringify(clientChat().get(M())) === JSON.stringify(serverChat().get(M())),
      "the client to hold the server's M",
    );
    const seen: string[] = [];
    const watch = (e: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
      const origin = txn.origin as { socketId?: unknown } | null;
      if (typeof origin?.socketId !== "string") return;
      for (const [k, change] of e.changes.keys) seen.push(`${change.action}:${k}`);
    };
    serverChat().observe(watch);
    await clientWrites((chat) => chat.delete(M()));
    serverChat().unobserve(watch);
    expect(seen, "the server saw the client's delete").toContain(`delete:${M()}`);
    expect(serverChat().has(M())).toBe(true);
    expect(snap()).toBe(before);
    callingAs = A;
    expect(
      parseResult(
        await client.callTool({ name: "tandem_reply", arguments: { text: "y", replyTo: M() } }),
      ).error,
    ).toBe(false);
  });

  it("a reply row R not yet confirmed: a client deletes R; R's replier is still A, and A's confirming poll still settles the batch on R", async () => {
    await seed({ [key("m1")]: userRow(key("m1")), [key("m3")]: userRow(key("m3")) });
    const first = await pollChat(A, "start");
    expect(first.ids.sort()).toEqual([key("m1"), key("m3")].sort());
    callingAs = A;
    const sent = parseResult(
      await client.callTool({ name: "tandem_reply", arguments: { text: "x", replyTo: key("m3") } }),
    ) as { data?: { messageId?: string } };
    const r = sent.data?.messageId as string;
    await waitFor(() => clientChat().has(r), "the client to see R");
    await clientWrites((chat) => chat.delete(r));
    expect(ownershipSnapshotForTests().repliers).toContainEqual([r, A]);
    await pollChat(A, first.cursor);
    expect((serverChat().get(r) as ChatMessage).settles).toEqual([key("m1")]);
  });
});

describe("security review H1: an update left pending cannot land later", () => {
  it("a forged successor of the server's next write is dropped; the server's write, a save and a restore show no forged row", async () => {
    await seed({ [M()]: userRow(M()) });
    const S = getOrCreateDocument(CTRL_ROOM);
    // Fork the server, predict its next item, and write a forged successor.
    const F = new Y.Doc();
    Y.applyUpdate(F, Y.encodeStateAsUpdate(S));
    F.clientID = S.clientID;
    F.getMap(Y_MAP_CHAT).set(key("R"), { placeholder: true });
    const C = new Y.Doc();
    Y.applyUpdate(C, Y.encodeStateAsUpdate(F));
    C.getMap(Y_MAP_CHAT).set(key("R"), { id: key("R"), author: "claude", replyTo: M(), text: "" });
    const forged = Y.encodeStateAsUpdate(C, Y.encodeStateVector(F));
    vi.spyOn(console, "error").mockImplementation(() => {});
    Y.applyUpdate(S, forged, { socketId: "a-browser-tab" });
    expect((S.store as { pendingStructs: unknown }).pendingStructs).toBeNull();
    withMcp(S, () => serverChat().set(key("R"), claudeRow(key("R"), { replyTo: key("other") })));
    expect((serverChat().get(key("R")) as ChatMessage).replyTo).toBe(key("other"));
    const persisted = JSON.parse(await persistedRows()) as Record<string, ChatMessage>;
    expect(persisted[key("R")]?.replyTo).toBe(key("other"));
    expect(settledChatIds(serverChat()).has(M())).toBe(false);
  });

  it("the same forgery as a delete set aimed at the server's next write is dropped", async () => {
    await seed({ [M()]: userRow(M()) });
    const S = getOrCreateDocument(CTRL_ROOM);
    const F = new Y.Doc();
    Y.applyUpdate(F, Y.encodeStateAsUpdate(S));
    F.clientID = S.clientID;
    F.getMap(Y_MAP_CHAT).set(key("R"), { placeholder: true });
    const C = new Y.Doc();
    Y.applyUpdate(C, Y.encodeStateAsUpdate(F));
    C.getMap(Y_MAP_CHAT).delete(key("R"));
    const forged = Y.encodeStateAsUpdate(C, Y.encodeStateVector(F));
    vi.spyOn(console, "error").mockImplementation(() => {});
    Y.applyUpdate(S, forged, { socketId: "a-browser-tab" });
    expect((S.store as { pendingDs: unknown }).pendingDs).toBeNull();
    withMcp(S, () => serverChat().set(key("R"), claudeRow(key("R"))));
    const persisted = JSON.parse(await persistedRows()) as Record<string, ChatMessage>;
    expect(persisted[key("R")]).toBeDefined();
  });
});

describe("R4.1: the three lists", () => {
  it("every ChatMessage field is placed, and the lists are exactly the brief's", () => {
    const of = (cat: string) =>
      Object.entries(CHAT_FIELD_CATEGORY)
        .filter(([, c]) => c === cat)
        .map(([f]) => f)
        .sort();
    expect(of("server-only")).toEqual(
      [
        "settles",
        "superseded",
        "inProgress",
        "agentIdentity",
        "chatNotice",
        "delivered",
        "greeting",
        "localRun",
        "replyTo",
      ].sort(),
    );
    expect(of("fixed")).toEqual(["author", "read"]);
    expect(of("client")).toEqual(["anchor", "documentId", "id", "text", "timestamp"]);
  });
});

describe("flag off: client writes are untouched (master's behaviour)", () => {
  it("a forged Claude row and read: true stand", async () => {
    await setWorld("");
    await seed({ [M()]: userRow(M()) });
    await clientWrites((chat) => {
      chat.set(key("forged"), claudeRow(key("forged"), { replyTo: M() }));
      chat.set(M(), { ...(chat.get(M()) as object), read: true });
    });
    expect((serverChat().get(key("forged")) as ChatMessage).replyTo).toBe(M());
    expect((serverChat().get(M()) as ChatMessage).read).toBe(true);
  });
});

describe("R4.6 and R4.2: classing and pushes (review round 1, item 8)", () => {
  afterEach(() => {
    answerer.local = false;
    __setHonourLocalPeriodRecordsForTests(null);
    __resetLocalPeriodForTests();
  });

  it("a row restored after a client delete keeps #2419's class", async () => {
    __setHonourLocalPeriodRecordsForTests(true);
    answerer.local = true;
    await seed({ [M()]: userRow(M()) });
    answerer.local = false;
    expect(isLocalPeriodChat(M()), "classed local-period at its add").toBe(true);
    await clientWrites((chat) => chat.delete(M()));
    expect(serverChat().has(M())).toBe(true);
    expect(isLocalPeriodChat(M()), "the restored row keeps its class").toBe(true);
  });

  it("the undo's own write pushes no chat:message; a client's own user row does", async () => {
    await seed({ [M()]: userRow(M()) });
    const seen: TandemEvent[] = [];
    const cb = (e: TandemEvent) => seen.push(e);
    subscribe(cb, "internal");
    try {
      await clientWrites((chat) => chat.delete(M()));
      await clientWrites((chat) => chat.set(key("forged"), claudeRow(key("forged"))));
      expect(serverChat().has(M())).toBe(true);
      expect(seen.filter((e) => e.type === "chat:message")).toEqual([]);
      // The positive twin: a legitimate user row from the tab is pushed.
      await clientWrites((chat) => chat.set(key("mine"), userRow(key("mine"))));
      expect(
        seen
          .filter((e) => e.type === "chat:message")
          .map((e) => (e.payload as { messageId?: string }).messageId),
      ).toEqual([key("mine")]);
    } finally {
      unsubscribe(cb);
    }
  });
});

describe("flag off: more client writes untouched (review round 1, item 9)", () => {
  it("a deleted row and a non-object row stand; pending data a client leaves is kept, as on master", async () => {
    await setWorld("");
    await seed({ [M()]: userRow(M()), [key("r")]: claudeRow(key("r"), { replyTo: M() }) });
    await clientWrites((chat) => {
      chat.delete(key("r"));
      chat.set(key("junk"), "not an object");
    });
    expect(serverChat().has(key("r"))).toBe(false);
    expect(serverChat().get(key("junk"))).toBe("not an object");
    const S = getOrCreateDocument(CTRL_ROOM);
    const F = new Y.Doc();
    Y.applyUpdate(F, Y.encodeStateAsUpdate(S));
    F.clientID = S.clientID;
    F.getMap(Y_MAP_CHAT).set(key("next"), { placeholder: true });
    const C = new Y.Doc();
    Y.applyUpdate(C, Y.encodeStateAsUpdate(F));
    C.getMap(Y_MAP_CHAT).set(key("next"), { author: "claude", replyTo: M(), text: "" });
    Y.applyUpdate(S, Y.encodeStateAsUpdate(C, Y.encodeStateVector(F)), { socketId: "a-tab" });
    expect(
      (S.store as { pendingStructs: unknown }).pendingStructs,
      "not dropped flag-off",
    ).not.toBeNull();
    // Leave no pending data for the next test.
    (S.store as { pendingStructs: unknown }).pendingStructs = null;
  });
});
