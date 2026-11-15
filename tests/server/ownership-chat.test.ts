/**
 * Chat owners and replies (#2358, the chat owners PR; ownership design §6.5,
 * §7.1–§7.3 as that PR's brief rules them). Ships dark: flag on for the whole
 * file except where a test says otherwise.
 *
 * Each user chat message has one owner. A poll hands a session only the chat
 * it owns or may take; a reply that names a message is accepted only from its
 * owner, or from a caller that may take it now; a change of a document's
 * holder re-owes the chat that follows the document; a lapse re-owes a
 * record's unanswered per-message messages; a tab close gives the holder its
 * document's unanswered chat.
 *
 * Everything goes through the real `tandem_checkInbox` and `tandem_reply`
 * tools, with **three registered records, A, B and C, each with its own
 * cursor**, and every seam `src/server/index.ts` wires (the sequence source,
 * the inbox handover, the chat side and the chat-row deletion listener).
 * Changes of ownership go through production paths: a take is `tandem_open`,
 * a write's claim `tandem_comment`, a poll's claim a poll, a tab close
 * `POST /api/close`, a lapse the grace. `setDocOwner` is used only for setup.
 *
 * Tests that need Tandem's Claude present use the presence seam; PR 3b makes
 * that branch reachable in production (Ruling 5).
 *
 * Platform: real files under `os.tmpdir()` joined with `path.join` for
 * `tandem_open`; fixtures elsewhere use synthetic paths. Nothing is gated.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { z } from "zod";
import { setChatRowsDeletedListener } from "../../src/server/chat-row-deletions.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { subscribe, unsubscribe } from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import { unwatchFile } from "../../src/server/file-watcher.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import {
  handOverDocumentInbox,
  onTandemReply,
  ownershipChatSide,
  registerAwarenessTools,
  resetInbox,
  setInboxResponseCorruptorForTests,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { decodeCursor, deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  checkInboxOutputShape,
  checkInboxOwnershipShape,
} from "../../src/server/mcp/output-schemas.js";
import { handleClose } from "../../src/server/mcp/routes/close.js";
import { handleOpen } from "../../src/server/mcp/routes/open.js";
import {
  __resetLocalPeriodForTests,
  __setHonourLocalPeriodRecordsForTests,
  loadLocalPeriodRecord,
} from "../../src/server/models/local-period.js";
import { clearCtrlChatDurably } from "../../src/server/session/manager.js";
import { DOC_OP_WAIT_MS, runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  DEFAULT_GRACE_MS,
  forgetChatMessageOwners,
  getDocOwner,
  getOwnerRecord,
  noteTransportChanged,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  inboxScopeOf as realScopeOf,
  resetOwnershipForTests,
  setChatOwnershipFaultForTests,
  setCompositeObserverForTests,
  setDocOwner,
  setInboxClaimCheckForTests,
  setInboxScopeReadForTests,
  setLossForTests,
  setOwnershipChatSide,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setTandemPresenceSource,
  setTransportView,
  setWakeObserverForTests,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_ANNOTATIONS, Y_MAP_CHAT } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import type { ChatMessage } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { makeRes } from "../helpers/route-recorder.js";

/** Set to make the next `resolveDeliveryRound` throw: a throw after the chat commit. */
const roundThrows = vi.hoisted(() => ({ next: false }));
vi.mock("../../src/server/events/delivery-state.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/server/events/delivery-state.js")>();
  return {
    ...real,
    resolveDeliveryRound: (...args: Parameters<typeof real.resolveDeliveryRound>) => {
      if (roundThrows.next) {
        roundThrows.next = false;
        throw new Error("after the chat commit");
      }
      return real.resolveDeliveryRound(...args);
    },
  };
});

const A = "claude:chat-a";
const B = "claude:chat-b";
const C = "claude:chat-c";
/** A caller with no record (`test:caller` is never registered here). */
const NOBODY = "test:caller";

const inboxSchema = z.object({ ...checkInboxOutputShape, ...checkInboxOwnershipShape });
type Inbox = z.infer<typeof inboxSchema>;

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs = A;
let run = 0;
let prefix = "";
let tmpDir = "";

const docId = (name: string) => `${prefix}-${name}`;
const key = (name: string) => `${prefix}-${name}`;

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 0 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

interface Doc {
  id: string;
  ydoc: Y.Doc;
}

function mkDoc(name: string, filePath = `/tmp/${docId(name)}.md`): Doc {
  const id = docId(name);
  const ydoc = getOrCreateDocument(id);
  if (ydoc.getXmlFragment("default").length === 0) {
    populateYDoc(ydoc, "Hello world, this is a test document.");
  }
  addDoc(id, { id, filePath, format: "md", readOnly: false, source: "file" });
  return { id, ydoc };
}

function realFile(name: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, "Hello world, this is a test document.\n");
  return filePath;
}

function comment(ydoc: Y.Doc, id: string): void {
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: `text of ${id}`,
      status: "pending",
      timestamp: 1000,
      rev: 1,
    }),
  );
}

const ctrl = () => getOrCreateDocument(CTRL_ROOM);
const chatMap = () => ctrl().getMap(Y_MAP_CHAT);
const row = (k: string) => chatMap().get(k) as ChatMessage | undefined;

let clock = 1_000;
/** An unread user chat message under key `k`, about `documentId` if given. */
function userChat(k: string, documentId?: string): string {
  withInternal(ctrl(), () =>
    chatMap().set(k, {
      id: k,
      author: "user",
      text: `text of ${k}`,
      timestamp: clock++,
      read: false,
      ...(documentId !== undefined ? { documentId } : {}),
    }),
  );
  return k;
}

function clearChat(): void {
  withInternal(ctrl(), () => {
    for (const k of [...chatMap().keys()]) chatMap().delete(k);
  });
}

async function as(owner: string, tool: string, args: Record<string, unknown> = {}) {
  callingAs = owner;
  return parseResult(await client.callTool({ name: tool, arguments: args })) as {
    error: boolean;
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
    data?: Record<string, unknown>;
  };
}

async function pollAs(owner: string, args: Record<string, unknown> = {}): Promise<Inbox> {
  callingAs = owner;
  const result = await client.callTool({ name: "tandem_checkInbox", arguments: args });
  expect(parseResult(result).error, JSON.stringify(result)).toBe(false);
  return inboxSchema.parse((result as { structuredContent: unknown }).structuredContent);
}

function reader(owner: string) {
  let cursor = "start";
  return {
    async poll(documentId?: string): Promise<Inbox> {
      const inbox = await pollAs(owner, {
        cursor,
        ...(documentId !== undefined ? { documentId } : {}),
      });
      cursor = inbox.cursor;
      return inbox;
    },
    get cursor() {
      return cursor;
    },
  };
}

const chatIds = (inbox: Inbox) => inbox.chatMessages.map((m) => String(m.id)).sort();

/** `owner`'s two consecutive cursor polls are not handed `k`; nor are a "start" and a cursor-less one. */
async function notHanded(owner: string, k: string, opts: { fresh?: boolean } = {}): Promise<void> {
  const r = reader(owner);
  for (const n of [1, 2]) expect(chatIds(await r.poll()), `${owner} poll ${n}`).not.toContain(k);
  if (opts.fresh) {
    expect(chatIds(await pollAs(owner, { cursor: "start" })), `${owner} "start"`).not.toContain(k);
    expect(chatIds(await pollAs(owner)), `${owner} cursor-less`).not.toContain(k);
  }
}

const reply = (owner: string, replyTo: string, extra: Record<string, unknown> = {}) =>
  as(owner, "tandem_reply", { text: `reply from ${owner}`, replyTo, ...extra });

const ownerOf = (id: string) => getDocOwner(id)?.ownerId;
const messageOwner = (k: string) =>
  ownershipSnapshotForTests().messageOwners.find(([mk]) => mk === k)?.[1];
const labelOf = (owner: string) => getOwnerRecord(owner)?.label as string;
/** Claude rows that name `k` in `replyTo`. */
const repliesTo = (k: string) =>
  [...chatMap().values()].filter(
    (v) => (v as ChatMessage).author === "claude" && (v as ChatMessage).replyTo === k,
  ) as ChatMessage[];

async function writeAs(owner: string, id: string): Promise<void> {
  const wrote = await as(owner, "tandem_comment", {
    from: 0,
    to: 5,
    text: "a note",
    documentId: id,
  });
  expect(wrote.error, JSON.stringify(wrote)).toBe(false);
}

async function openAs(owner: string, filePath: string): Promise<string> {
  const opened = await as(owner, "tandem_open", { filePath });
  expect(opened.error, JSON.stringify(opened)).toBe(false);
  return opened.data?.documentId as string;
}

async function userOpen(filePath: string): Promise<string> {
  const res = makeRes();
  await handleOpen(
    { body: { filePath }, socket: { remoteAddress: "127.0.0.1" }, headers: {} } as never,
    res as never,
  );
  expect(res._status, JSON.stringify(res._body)).toBe(200);
  return (res._body as { data: { documentId: string } }).data.documentId;
}

async function closeByRoute(id: string): Promise<void> {
  const res = makeRes();
  await handleClose(
    { body: { documentId: id }, socket: { remoteAddress: "127.0.0.1" }, headers: {} } as never,
    res as never,
  );
  expect(res._status, JSON.stringify(res._body)).toBe(200);
}

function entryOf(owner: string): TransportViewEntry {
  return view.find((e) => e.ownerId === owner) as TransportViewEntry;
}

/** Lapse `owner` through the grace; a record whose transport stays registered survives. */
function lapseByGrace(owner: string, how: "stream dropped" | "transport removed"): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  if (how === "transport removed") view = view.filter((e) => e.ownerId !== owner);
  else {
    const entry = entryOf(owner);
    entry.streamEver = true;
    entry.openStreams = 0;
  }
  noteTransportChanged(owner);
  vi.advanceTimersByTime(DEFAULT_GRACE_MS + 1);
  vi.useRealTimers();
}

function removeTransport(owner: string): void {
  view = view.filter((e) => e.ownerId !== owner);
  noteTransportChanged(owner);
}

function reattach(owner: string): void {
  const entry = entryOf(owner);
  entry.openStreams = 1;
  noteTransportChanged(owner);
}

async function buildWorld(flag: "1" | "" = "1"): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `chat${run}`;
  callingAs = A;
  resetInbox();
  resetOwnershipForTests();
  __resetLocalPeriodForTests();
  __setHonourLocalPeriodRecordsForTests(null);
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  clearChat();
  view = [];
  setTransportView(() => view);
  register(A);
  register(B);
  register(C);
  // The lines of `src/server/index.ts`.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setOwnershipChatSide(ownershipChatSide);
  setChatRowsDeletedListener(forgetChatMessageOwners);
  setCtrlMode("tandem");
  const front = mkDoc("front");
  setActiveDocId(front.id);
  ({ client, close } = await setupMcpServer(
    [registerAwarenessTools, registerDocumentTools, registerAnnotationTools],
    { dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }) },
  ));
  // The SDK client validates every structured response against the output
  // schema tools/list advertised (additionalProperties: false), as a real one does.
  await client.listTools();
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-chat-owners-"));
  await buildWorld();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  roundThrows.next = false;
  setInboxClaimCheckForTests(undefined);
  setInboxScopeReadForTests(undefined);
  setInboxResponseCorruptorForTests(undefined);
  setCompositeObserverForTests(undefined);
  setChatOwnershipFaultForTests(undefined);
  setWakeObserverForTests(undefined);
  setChatRowsDeletedListener(undefined);
  for (const [id, doc] of [...getOpenDocs()]) {
    unwatchFile(doc.filePath);
    removeDoc(id);
  }
  clearChat();
  resetOwnershipForTests();
  resetInbox();
  __resetLocalPeriodForTests();
  __setHonourLocalPeriodRecordsForTests(null);
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A holds `d1`, B holds `d2`, `d3` is unowned; one message on each and one doc-less. */
function worldOfFour() {
  const d1 = mkDoc("d1");
  const d2 = mkDoc("d2");
  const d3 = mkDoc("d3");
  setDocOwner(d1.id, { ownerId: A, kind: "opened" }, "take", A);
  setDocOwner(d2.id, { ownerId: B, kind: "opened" }, "take", B);
  const m1 = userChat(key("m1"), d1.id);
  const m2 = userChat(key("m2"), d2.id);
  const m3 = userChat(key("m3"), d3.id);
  const m0 = userChat(key("m0"));
  return { d1, d2, d3, m0, m1, m2, m3 };
}

// ---------------------------------------------------------------------------

describe("R3/R4: who is handed a message", () => {
  it("A is handed d1's, d3's and the doc-less message, and claims d3; B's two polls are handed d2's only", async () => {
    const { d1, d3, m0, m1, m2, m3 } = worldOfFour();
    const a = await reader(A).poll();
    expect(chatIds(a)).toEqual([m0, m1, m3].sort());
    expect(ownerOf(d3.id)).toBe(A);
    expect(a.ownership?.holding).toEqual([d1.id, d3.id].sort());
    expect(a.ownership?.changed).toContainEqual({
      documentId: d3.id,
      change: "gained",
      cause: "a poll of yours claimed it",
    });
    expect(messageOwner(m0)).toEqual({ ownerId: A, origin: "poll" });
    const b = reader(B);
    expect(chatIds(await b.poll())).toEqual([m2]);
    expect(chatIds(await b.poll()), "the second poll: nothing new").toEqual([]);
    expect(chatIds(await pollAs(B, { cursor: "start" }))).not.toContain(m0);
  });

  it("the reverse: B first is handed d2's, d3's and the doc-less one; A's two polls only d1's", async () => {
    const { d3, m0, m1, m2, m3 } = worldOfFour();
    expect(chatIds(await reader(B).poll())).toEqual([m0, m2, m3].sort());
    expect(ownerOf(d3.id)).toBe(B);
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([m1]);
    expect(chatIds(await a.poll()), "the second poll: nothing new").toEqual([]);
    for (const m of [m0, m3]) {
      expect(chatIds(await pollAs(A, { cursor: "start" }))).not.toContain(m);
    }
  });

  it("design R1.4: two terminals, Tandem's Claude off, one doc-less message: exactly one is handed it", async () => {
    const m = userChat(key("m"));
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    await notHanded(B, m, { fresh: true });
  });

  it("a message on a closed document is claimable per message, like a doc-less one", async () => {
    const m = userChat(key("m"), docId("closed-elsewhere"));
    expect(chatIds(await pollAs(B))).toEqual([m]);
    expect(messageOwner(m)).toEqual({ ownerId: B, origin: "poll" });
    await notHanded(A, m, { fresh: true });
    const refused = await reply(A, m);
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.message).toBe(
      `The terminal session ${labelOf(B)} answers this message. Do not reply to it.`,
    );
  });

  it("local-period chat: handed to nobody, owned by nobody, and a reply to it is refused", async () => {
    __setHonourLocalPeriodRecordsForTests(true);
    const m = userChat(key("local"));
    loadLocalPeriodRecord({ v: 1, open: false, owed: [], local: [m] });
    await notHanded(A, m, { fresh: true });
    await notHanded(B, m);
    const before = chatMap().size;
    const refused = await reply(A, m);
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.message).toBe(
      "A local model answers this message, not Claude. Nothing was sent. Do not reply to it.",
    );
    expect(refused.details).toEqual({ reason: "chat", holder: null });
    expect(chatMap().size).toBe(before);
    expect(ownershipSnapshotForTests().messageOwners).toEqual([]);
  });

  it("R4.1: a document whose scope read throws: its chat is not handed by that poll, and is by the next", async () => {
    const d3 = mkDoc("d3");
    const m = userChat(key("m3"), d3.id);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setInboxScopeReadForTests((id, caller, now) => {
      if (id === d3.id) throw new Error("scope read");
      return realScopeOf(id, caller, now);
    });
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([]);
    setInboxScopeReadForTests(undefined);
    expect(chatIds(await a.poll())).toEqual([m]);
    expect(ownerOf(d3.id)).toBe(A);
  });

  it("R4.2: an unowned document busy within the bound: its chat is handed to nobody; after the bound, claimed", async () => {
    const d3 = mkDoc("d3");
    const m = userChat(key("m3"), d3.id);
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    let release!: () => void;
    const op = runDocOp(d3.id, () => new Promise<void>((r) => (release = r)));
    const a = reader(A);
    const b = reader(B);
    for (const n of [1, 2]) {
      expect(chatIds(await a.poll()), `A poll ${n}`).toEqual([]);
      expect(chatIds(await b.poll()), `B poll ${n}`).toEqual([]);
    }
    vi.advanceTimersByTime(DOC_OP_WAIT_MS);
    expect(chatIds(await a.poll())).toEqual([m]);
    expect(ownerOf(d3.id)).toBe(A);
    release();
    await op;
  });

  it("R4.2: a per-message owner on a reopened, unowned, busy document is handed it and claims nothing", async () => {
    const file = realFile("pm.md");
    const id = await userOpen(file);
    await writeAs(A, id);
    const m = userChat(key("m"), id);
    await closeByRoute(id);
    expect(messageOwner(m)).toEqual({ ownerId: A, origin: "close", closedDocumentId: id });
    expect(await userOpen(file)).toBe(id);
    let release!: () => void;
    const op = runDocOp(id, () => new Promise<void>((r) => (release = r)));
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    expect(ownerOf(id)).toBeUndefined();
    release();
    await op;
  });

  it("R4.3: a document with both a comment and a chat message is claimed once", async () => {
    const d3 = mkDoc("d3");
    comment(d3.ydoc, "c3");
    const m = userChat(key("m3"), d3.id);
    const entries: string[] = [];
    setCompositeObserverForTests((step, id) => {
      if (step === "entry" && id === d3.id) entries.push(id);
    });
    const inbox = await reader(A).poll();
    expect(chatIds(inbox)).toEqual([m]);
    expect(entries).toHaveLength(1);
    expect(ownerOf(d3.id)).toBe(A);
  });

  for (const how of ["cursor", "cursor-less"] as const) {
    it(`R4.3/R4.4: a claim refused at commit (${how}) leaves the message unread, undelivered, unregistered and owed to a fresh reader`, async () => {
      const d3 = mkDoc("d3");
      const m = userChat(key("m3"), d3.id);
      setInboxClaimCheckForTests((check, id) => !(check === "unowned" && id === d3.id));
      const inbox = how === "cursor" ? await reader(A).poll() : await pollAs(A);
      // The response carried it (accepted: two sessions may be handed it).
      expect(chatIds(inbox)).toEqual([m]);
      expect(ownerOf(d3.id)).toBeUndefined();
      expect(row(m)?.read).toBe(false);
      expect(row(m)?.delivered).toBeUndefined();
      expect(deliveryRegistry.lookup("c", m, 0)).toBeUndefined();
      setInboxClaimCheckForTests(undefined);
      expect(chatIds(await reader(B).poll())).toEqual([m]);
      expect(ownerOf(d3.id)).toBe(B);
    });
  }

  it("R4.4: a cursor-less poll that takes a doc-less message is not handed it again by its next cursor-less poll", async () => {
    const m = userChat(key("m"));
    expect(chatIds(await pollAs(A))).toEqual([m]);
    expect(chatIds(await pollAs(A))).toEqual([]);
    expect(messageOwner(m)?.ownerId).toBe(A);
  });

  it("R4.4: a validation failure sets no owner and leaves no entry; the next poll of either record may take it", async () => {
    const m = userChat(key("m"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    setInboxResponseCorruptorForTests(() => ({ broken: true }));
    callingAs = A;
    expect(
      parseResult(
        await client.callTool({ name: "tandem_checkInbox", arguments: { cursor: "start" } }),
      ).error,
    ).toBe(true);
    setInboxResponseCorruptorForTests(undefined);
    expect(ownershipSnapshotForTests().messageOwners).toEqual([]);
    expect(deliveryRegistry.lookup("c", m, 0)).toBeUndefined();
    expect(chatIds(await reader(B).poll())).toEqual([m]);
  });

  for (const how of ["cursor", "cursor-less"] as const) {
    it(`R4.4: a throw after the chat commit (${how}) drops the owner it set and owes the message again`, async () => {
      const m = userChat(key("m"));
      roundThrows.next = true;
      callingAs = A;
      const args = how === "cursor" ? { cursor: "start" } : {};
      expect(
        parseResult(await client.callTool({ name: "tandem_checkInbox", arguments: args })).error,
      ).toBe(true);
      expect(ownershipSnapshotForTests().messageOwners).toEqual([]);
      expect(row(m)?.read).toBe(false);
      expect(row(m)?.delivered).toBeUndefined();
      expect(chatIds(await reader(B).poll())).toEqual([m]);
    });
  }

  it("R4.5: A's acknowledgement does not hide B's message from B ('start' and a fresh cursor)", async () => {
    const m = userChat(key("m"));
    // B is handed M by a cursor poll and never passes that cursor back.
    expect(chatIds(await reader(B).poll())).toEqual([m]);
    expect(messageOwner(m)?.ownerId).toBe(B);
    const seq = deliveryRegistry.lookup("c", m, 0)?.seq as number;
    // A's chat mark (the global counter) passes M's sequence number.
    const a = reader(A);
    await a.poll();
    expect(decodeCursor(a.cursor).cursor.chat.mark as number).toBeGreaterThanOrEqual(seq);
    // A acknowledges with that cursor.
    await a.poll();
    expect(row(m)?.read, "A's acknowledgement stamped nothing of B's").toBe(false);
    expect(chatIds(await pollAs(B, { cursor: "start" }))).toEqual([m]);
    expect(chatIds(await reader(B).poll())).toEqual([m]);
  });

  it("R4.6: a caller with no record is handed no chat, two consecutive polls", async () => {
    userChat(key("m"));
    const r = reader(NOBODY);
    for (const n of [1, 2]) {
      const inbox = await r.poll();
      expect(inbox.chatMessages, `poll ${n}`).toEqual([]);
      expect(inbox.summary).not.toContain("The user sees nothing in chat until you reply");
    }
  });

  it("R4.7: a named poll of d1 hands a doc-less message and one on unowned d3, and claims d3 below its chat entries", async () => {
    const { d1, d3, m0, m3 } = worldOfFour();
    const before = deliveryRegistry.counter;
    const inbox = await reader(A).poll(d1.id);
    expect(chatIds(inbox)).toEqual(expect.arrayContaining([m0, m3]));
    const entry = getDocOwner(d3.id);
    expect(entry?.ownerId).toBe(A);
    expect(entry?.sinceSeq).toBe(before);
    expect(deliveryRegistry.lookup("c", m3, 0)?.seq as number).toBeGreaterThan(
      entry?.sinceSeq as number,
    );
  });

  it("R4.8: two records with the same holdings and none of the chat get byte-identical cursors", async () => {
    const { d2 } = worldOfFour();
    // A and C hold nothing chat-wise relevant: make A hold nothing too.
    setDocOwner(docId("d1"), { ownerId: B, kind: "opened" }, "take", B);
    setDocOwner(docId("d3"), { ownerId: B, kind: "opened" }, "take", B);
    withInternal(ctrl(), () => chatMap().delete(key("m0")));
    expect(ownerOf(d2.id)).toBe(B);
    const a = await reader(A).poll();
    const c = await reader(C).poll();
    expect(a.chatMessages).toEqual([]);
    expect(a.cursor).toBe(c.cursor);
  });

  it("R4.9: 300 messages B owns add nothing to A's cursor", async () => {
    const r = reader(A);
    await r.poll();
    const without = decodeCursor((await r.poll()).cursor).cursor;
    for (let i = 0; i < 300; i++) userChat(key(`b${i}`));
    expect((await pollAs(B)).chatMessages).toHaveLength(300);
    const withThem = decodeCursor((await r.poll()).cursor).cursor;
    expect(withThem.chat.held).toEqual(without.chat.held);
    expect(withThem.docs).toEqual(without.docs);
    expect(withThem.handOut).toBeUndefined();
  });
});

describe("R3.3/R3.5: owners and held state", () => {
  it("a lapsed record with its transport registered re-arms its grace when a poll hands it an unhandled doc-less message", async () => {
    lapseByGrace(A, "stream dropped");
    expect(getOwnerRecord(A)?.lapsed).toBe(true);
    expect(getOwnerRecord(A)?.graceTimer).toBeUndefined();
    userChat(key("m"));
    expect(chatIds(await pollAs(A))).toHaveLength(1);
    expect(getOwnerRecord(A)?.graceTimer).toBeDefined();
  });

  it("an already-lapsed record owning an unhandled message is kept when its transport goes; one owning only a handled one is deleted at once", async () => {
    lapseByGrace(A, "stream dropped");
    lapseByGrace(B, "stream dropped");
    const ma = userChat(key("ma"));
    expect(chatIds(await pollAs(A))).toEqual([ma]);
    const mb = userChat(key("mb"));
    expect(chatIds(await pollAs(B))).toEqual([mb]);
    expect((await reply(B, mb)).error).toBe(false);
    removeTransport(A);
    removeTransport(B);
    expect(getOwnerRecord(A), "A owns an unhandled message: kept").toBeDefined();
    expect(getOwnerRecord(A)?.graceTimer).toBeDefined();
    expect(getOwnerRecord(B), "B's only message is handled: deleted").toBeUndefined();
    expect(messageOwner(mb)).toBeUndefined();
  });

  it("an acknowledged message is held state for nobody: an already-lapsed acknowledger is deleted when its transport goes", async () => {
    lapseByGrace(A, "stream dropped");
    const m = userChat(key("m"));
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    expect(messageOwner(m)).toEqual({ ownerId: A, origin: "acknowledgement" });
    removeTransport(A);
    expect(getOwnerRecord(A)).toBeUndefined();
    expect(messageOwner(m)).toBeUndefined();
  });

  it("R3.5a: deleting a record drops its owners and handed memory; a new record under its id is a stranger", async () => {
    const handled = userChat(key("h"));
    const open = userChat(key("o"));
    expect(chatIds(await pollAs(A))).toEqual([handled, open].sort());
    expect((await reply(A, handled)).error).toBe(false);
    lapseByGrace(A, "transport removed");
    // Its unhandled message was re-owed at the lapse, its handled one dropped with it.
    expect(getOwnerRecord(A)).toBeUndefined();
    const snap = ownershipSnapshotForTests();
    expect(snap.messageOwners).toEqual([]);
    expect(snap.handed.find(([o]) => o === A)).toBeUndefined();
    register(A);
    expect(chatIds(await pollAs(B))).toEqual([open]);
    const refused = await reply(A, open);
    expect(refused.message).toBe(
      `The terminal session ${labelOf(B)} answers this message. Do not reply to it.`,
    );
  });

  it("R3.3: one origin: a close-owned message keeps origin close after its owner acknowledges it", async () => {
    const file = realFile("o.md");
    const id = await userOpen(file);
    await writeAs(A, id);
    const m = userChat(key("m"), id);
    await closeByRoute(id);
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    expect(messageOwner(m)).toEqual({ ownerId: A, origin: "close", closedDocumentId: id });
  });

  it("R3.6: Clear chat empties the per-message state", async () => {
    userChat(key("m"));
    await pollAs(A);
    expect(ownershipSnapshotForTests().messageOwners).toHaveLength(1);
    await clearCtrlChatDurably(ctrl());
    const snap = ownershipSnapshotForTests();
    expect(snap.messageOwners).toEqual([]);
    expect(snap.handed).toEqual([]);
  });

  it("R3.7: a change of a message's owner queues no change notice", async () => {
    userChat(key("m"));
    const inbox = await reader(A).poll();
    expect(inbox.ownership?.changed).toEqual([]);
    expect(inbox.ownership?.holding).toEqual([]);
  });

  it("R6.4: every change of a message's owner reaches startOrWake once", async () => {
    const causes: string[] = [];
    setWakeObserverForTests((cause) => causes.push(cause));
    userChat(key("m1"));
    userChat(key("m2"));
    await pollAs(A); // two owners set
    lapseByGrace(A, "stream dropped"); // both unhandled: both dropped
    expect(causes.filter((c) => c === "message-owner")).toHaveLength(4);
  });
});

describe("R5: the reply gate", () => {
  it("X owns it: a final reply and an acknowledgement are accepted", async () => {
    const m = userChat(key("m"));
    await pollAs(A);
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    expect((await reply(A, m)).error).toBe(false);
    expect(repliesTo(m)).toHaveLength(2);
  });

  it("design R1.4: B, pushed a message A was handed, is refused for a reply and an acknowledgement; A's reply lands", async () => {
    const m = userChat(key("m"));
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    for (const extra of [{}, { inProgress: true }]) {
      const refused = await reply(B, m, extra);
      expect(refused.code).toBe("NOT_DOC_OWNER");
      expect(refused.details).toEqual({
        reason: "chat",
        holder: { label: labelOf(A), displayKind: "terminal" },
      });
    }
    expect((await reply(A, m)).error).toBe(false);
    expect(repliesTo(m).map((r) => r.text)).toEqual([`reply from ${A}`]);
  });

  it("design R2.2: a doc-less answer with no tab open is accepted, with no document stamped", async () => {
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);
    const m = userChat(key("m"));
    expect((await reply(A, m)).error).toBe(false);
    expect(repliesTo(m)[0]?.documentId).toBeUndefined();
  });

  it("design R2.2: a reply to a message on a non-active document X holds is accepted and stamped with that document", async () => {
    const d = mkDoc("held");
    setDocOwner(d.id, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d.id);
    expect((await reply(A, m)).error).toBe(false);
    expect(repliesTo(m)[0]?.documentId).toBe(d.id);
  });

  it("step 1: an explicit documentId that contradicts the message's, or any for a doc-less one: INVALID_ARGUMENT, nothing written", async () => {
    const d = mkDoc("d");
    const onD = userChat(key("ond"), d.id);
    const docless = userChat(key("docless"));
    const before = chatMap().size;
    for (const [m, documentId] of [
      [onD, docId("front")],
      [docless, d.id],
    ] as const) {
      const refused = await reply(A, m, { documentId });
      expect(refused.code).toBe("INVALID_ARGUMENT");
      expect(refused.message).toBe(
        "Nothing was sent: the documentId you passed is not the document of the chat message that replyTo names. Omit documentId when you reply to a chat message; the reply is filed with that message's own document.",
      );
    }
    expect(chatMap().size).toBe(before);
    expect(ownerOf(d.id)).toBeUndefined();
    expect(ownershipSnapshotForTests().messageOwners).toEqual([]);
  });

  it("an open unowned document B may claim: B's reply claims it; holding, changed (validated) and A's two polls agree", async () => {
    const d = mkDoc("u");
    const m = userChat(key("m"), d.id);
    expect((await reply(B, m)).error).toBe(false);
    expect(ownerOf(d.id)).toBe(B);
    const status = await as(B, "tandem_status", {});
    expect(JSON.stringify(status.data)).toContain(d.id);
    const b = await reader(B).poll();
    expect(b.ownership?.holding).toContain(d.id);
    expect(b.ownership?.changed).toContainEqual({
      documentId: d.id,
      change: "gained",
      cause: "a chat reply of yours claimed it",
    });
    await notHanded(A, m);
  });

  it("Ruling 4: a document that cannot be claimed now: A, handed M, is accepted as its per-message owner; C, never handed it, is refused with no holder", async () => {
    // A holds `u` and is handed M by a poll; the document then goes unowned
    // (setup) and a write that never settles holds its queue within the bound.
    const d = mkDoc("u");
    setDocOwner(d.id, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d.id);
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    setDocOwner(d.id, null, "lapse");
    let release!: () => void;
    const op = runDocOp(d.id, () => new Promise<void>((r) => (release = r)));
    expect((await reply(A, m)).error).toBe(false);
    expect(messageOwner(m)).toEqual({ ownerId: A, origin: "reply" });
    expect(ownerOf(d.id)).toBeUndefined();
    const m2 = userChat(key("m2"), d.id);
    const refused = await reply(C, m2);
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.details).toEqual({ reason: "chat", holder: null, documentId: d.id });
    expect(refused.message).toBe(
      "This message is not yours to answer right now: an operation on its document is still running. Nothing was sent. If a later tandem_checkInbox hands it to you, answer it then.",
    );
    expect(refused.message).not.toMatch(/another session/i);
    release();
    await op;
  });

  it("Ruling 4's blocking-loss arm (setLossForTests): handed, accepted as its owner; not handed, refused with no holder", async () => {
    const d = mkDoc("u");
    setDocOwner(d.id, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d.id);
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    setDocOwner(d.id, null, "lapse");
    // A loss stands on one record per document, so each arm gets its own.
    setLossForTests(d.id, A, "taken");
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    expect(messageOwner(m)).toEqual({ ownerId: A, origin: "acknowledgement" });
    expect(ownerOf(d.id)).toBeUndefined();
    const d2 = mkDoc("u2");
    setLossForTests(d2.id, C, "taken");
    const m2 = userChat(key("m2"), d2.id);
    expect((await reply(C, m2)).details).toEqual({
      reason: "chat",
      holder: null,
      documentId: d2.id,
    });
    expect(ownerOf(d2.id)).toBeUndefined();
  });

  it("claimable per message: B's reply before any poll makes B its owner; A's two polls are not handed it", async () => {
    const m = userChat(key("m"));
    expect((await reply(B, m)).error).toBe(false);
    expect(messageOwner(m)).toEqual({ ownerId: B, origin: "reply" });
    await notHanded(A, m);
  });

  it("R5.4: a caller with no record is refused every reply; a not-present Tandem's Claude is refused", async () => {
    const m = userChat(key("m"));
    const nobody = await reply(NOBODY, m);
    expect(nobody.code).toBe("INTERNAL_ERROR");
    expect(nobody.message).toBe(
      "tandem_reply refused: Tandem has no record for this session, so it cannot answer a chat message now. Nothing was sent. This is a fault in Tandem, not something to retry with different arguments.",
    );
    const tandem = await reply(TANDEM_OWNER_ID, m);
    expect(tandem.code).toBe("NOT_DOC_OWNER");
    expect(tandem.details).toEqual({ reason: "not-present", holder: null });
    expect(tandem.message).toBe(
      "Tandem's Claude is turned off or stopped, so it answers no chat now. Nothing was sent.",
    );
  });

  it("R5.5: a refused reply leaves no trace: no row, no stamp, no notify, no claim, no owner, no Y.Doc write", async () => {
    const d = mkDoc("u");
    const m = userChat(key("m"), d.id);
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    expect(row(m)?.read).toBe(false);
    const heard: unknown[] = [];
    const off = onTandemReply((id) => heard.push(id));
    const front = getOrCreateDocument(docId("front"));
    const writes: string[] = [];
    const onCtrl = () => writes.push("ctrl");
    const onFront = () => writes.push("front");
    const onD = () => writes.push("d");
    ctrl().on("update", onCtrl);
    front.on("update", onFront);
    d.ydoc.on("update", onD);
    const owners = ownershipSnapshotForTests().messageOwners;
    try {
      for (const extra of [{}, { inProgress: true }, { documentId: d.id }]) {
        expect((await reply(B, m, extra)).error).toBe(true);
      }
      expect(writes).toEqual([]);
      expect(heard).toEqual([]);
      expect(row(m)?.read).toBe(false);
      expect(repliesTo(m)).toEqual([]);
      expect(ownerOf(d.id)).toBe(A);
      expect(ownershipSnapshotForTests().messageOwners).toEqual(owners);
    } finally {
      off();
      ctrl().off("update", onCtrl);
      front.off("update", onFront);
      d.ydoc.off("update", onD);
    }
  });

  it("R5.1: a reply is accepted while its document's queue is held by a write that never settles", async () => {
    const d = mkDoc("held");
    setDocOwner(d.id, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d.id);
    let release!: () => void;
    const op = runDocOp(d.id, () => new Promise<void>((r) => (release = r)));
    expect((await reply(A, m)).error).toBe(false);
    expect(repliesTo(m)).toHaveLength(1);
    release();
    await op;
  });

  it("R5.1: tandem_reply's handler has no await between the gate and the append, and withTypingPresence runs it before its first await", () => {
    const awareness = fs.readFileSync("src/server/mcp/awareness.ts", "utf8");
    const start = awareness.indexOf('withErrorBoundary("tandem_reply"');
    const gate = awareness.indexOf("inboxOwnership.replyGate(", start);
    const append = awareness.indexOf("appendClaudeChatMessage(text,", start);
    const apply = awareness.indexOf("gate.apply()", start);
    const stamp = awareness.indexOf("markUserChatRead(replyTo)", start);
    expect(start).toBeGreaterThan(-1);
    expect(gate > start && append > gate && apply > append && stamp > apply).toBe(true);
    const between = awareness.slice(gate, stamp).replace(/\/\/.*$/gm, "");
    expect(between).not.toMatch(/\bawait\b|\.then\(/);
    const presence = fs.readFileSync("src/server/mcp/typing-presence.ts", "utf8");
    const wrapper = presence.slice(presence.indexOf("export async function withTypingPresence"));
    const firstAwait = wrapper.indexOf("await ");
    const firstCall = wrapper.indexOf("handler()");
    expect(firstCall).toBeGreaterThan(-1);
    expect(firstCall).toBeLessThan(firstAwait);
  });

  it("R5.6: the chat refusal names the holder by kind and label only", async () => {
    const m = userChat(key("m"));
    await pollAs(A);
    const refused = await reply(B, m);
    expect(refused.message).toBe(
      `The terminal session ${labelOf(A)} answers this message. Do not reply to it.`,
    );
    const text = JSON.stringify(refused);
    for (const leak of [A, B, "chat-a", "text of", m.replace(prefix, "")]) {
      if (leak !== m.replace(prefix, "")) expect(text).not.toContain(leak);
    }
    expect(text).not.toMatch(/Another session answers/);
  });

  it("R5.8 (a): A acknowledges M on D it holds; B's tandem_open takes D; M stays A's", async () => {
    const file = realFile("ack-a.md");
    const id = await userOpen(file);
    await writeAs(A, id);
    const m = userChat(key("m"), id);
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    expect(messageOwner(m)).toEqual({ ownerId: A, origin: "acknowledgement" });
    await openAs(B, getOpenDocs().get(id)?.filePath as string);
    expect(ownerOf(id)).toBe(B);
    await assertStaysA(m);
  });

  it("R5.8 (b): A acknowledges M on D; A lapses with its transport registered; B claims D by a write; M stays A's", async () => {
    const d = mkDoc("ack-b");
    await writeAs(A, d.id);
    const m = userChat(key("m"), d.id);
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    lapseByGrace(A, "stream dropped");
    expect(getOwnerRecord(A)).toBeDefined();
    expect(ownerOf(d.id)).toBeUndefined();
    await writeAs(B, d.id);
    reattach(A);
    await assertStaysA(m);
  });

  it("R5.8 (c): A acknowledges M on D; D's tab closes (nothing assigned); D reopens and B claims it; M stays A's", async () => {
    const file = realFile("ack-c.md");
    const id = await userOpen(file);
    await writeAs(A, id);
    const m = userChat(key("m"), id);
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    await closeByRoute(id);
    expect(messageOwner(m)?.origin).toBe("acknowledgement");
    expect(await userOpen(file)).toBe(id);
    await writeAs(B, id);
    await assertStaysA(m);
  });

  async function assertStaysA(m: string): Promise<void> {
    await notHanded(B, m);
    for (const who of [B, C]) {
      const refused = await reply(who, m);
      expect(refused.message, who).toBe(
        `The terminal session ${labelOf(A)} answers this message. Do not reply to it.`,
      );
    }
    expect((await reply(B, m, { inProgress: true })).code).toBe("NOT_DOC_OWNER");
    expect((await reply(A, m)).error).toBe(false);
    expect(repliesTo(m).filter((r) => r.inProgress !== true)).toHaveLength(1);
  }

  it("R5.8: Tandem's Claude acknowledges while present; once not present its reply is refused and others are told it answers", async () => {
    let present = true;
    setTandemPresenceSource(() => present);
    const m = userChat(key("m"));
    expect((await reply(TANDEM_OWNER_ID, m, { inProgress: true })).error).toBe(false);
    expect(messageOwner(m)).toEqual({ ownerId: TANDEM_OWNER_ID, origin: "acknowledgement" });
    present = false;
    expect((await reply(TANDEM_OWNER_ID, m)).details?.reason).toBe("not-present");
    expect((await reply(A, m)).message).toBe(
      "Tandem's Claude answers this message. Do not reply to it.",
    );
  });

  it("accepted loss: an acknowledger deleted before its final reply; its doc-less message is claimable again", async () => {
    const m = userChat(key("m"));
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    lapseByGrace(A, "transport removed");
    expect(getOwnerRecord(A)).toBeUndefined();
    expect(messageOwner(m)).toBeUndefined();
    register(A);
    expect((await reply(A, m)).error).toBe(false);
    expect(messageOwner(m)).toEqual({ ownerId: A, origin: "reply" });
  });
});

describe("R6: the chat half of a handover, and the tab close", () => {
  it("design R2.3: A owns a doc-less message by a poll and never answers; A lapses; B's next poll is handed it", async () => {
    const m = userChat(key("m"));
    expect(chatIds(await pollAs(A))).toEqual([m]);
    lapseByGrace(A, "transport removed");
    expect(chatIds(await reader(B).poll())).toEqual([m]);
  });

  it("A was handed M on D; B's tandem_open takes D: B's next poll is handed M, a fresh cursor of A is not", async () => {
    const file = realFile("take.md");
    const id = await userOpen(file);
    await writeAs(A, id);
    const m = userChat(key("m"), id);
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    await openAs(B, getOpenDocs().get(id)?.filePath as string);
    expect(chatIds(await reader(B).poll())).toEqual([m]);
    await notHanded(A, m);
  });

  for (const how of ["cursor-less", "fresh cursor"] as const) {
    it(`the write: a re-owe writes read:false with no delivered; B's next poll (${how}) is handed it`, async () => {
      const file = realFile("write.md");
      const id = await userOpen(file);
      await writeAs(A, id);
      const m = userChat(key("m"), id);
      expect(chatIds(await pollAs(A))).toEqual([m]);
      expect(row(m)?.read).toBe(true);
      await openAs(B, getOpenDocs().get(id)?.filePath as string);
      expect(row(m)?.read).toBe(false);
      expect(row(m)?.delivered).toBeUndefined();
      const inbox = how === "cursor-less" ? await pollAs(B) : await reader(B).poll();
      expect(chatIds(inbox)).toEqual([m]);
    });
  }

  it("the re-owe's own catch: a throw is logged, the change stands, and the composite's later steps run", async () => {
    const d = mkDoc("d");
    setDocOwner(d.id, { ownerId: A, kind: "opened" }, "take", A);
    userChat(key("m"), d.id);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setChatOwnershipFaultForTests((at) => {
      if (at === "re-owe") throw new Error("re-owe");
    });
    const steps: string[] = [];
    setCompositeObserverForTests((step) => steps.push(step));
    setDocOwner(d.id, { ownerId: B, kind: "opened" }, "take", B);
    expect(ownerOf(d.id)).toBe(B);
    expect(steps).toEqual(["handover", "loss", "entry", "notices", "publish", "wake"]);
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes("could not be marked unread again"))).toBe(true);
    expect(logged.join("\n")).not.toContain(A);
  });

  it("the restart residual: a message stamped read and never re-owed, then a restart, is handed to nobody", async () => {
    const d = mkDoc("d");
    setDocOwner(d.id, { ownerId: B, kind: "opened" }, "take", B);
    const m = userChat(key("m"), d.id);
    expect(chatIds(await pollAs(B))).toEqual([m]);
    // A simulated restart: the ownership module and the registry forget everything.
    resetOwnershipForTests();
    deliveryRegistry.reset();
    view = [];
    setTransportView(() => view);
    register(A);
    setOwnershipSeqSource(() => deliveryRegistry.counter);
    setOwnershipInboxHandover(handOverDocumentInbox);
    setOwnershipChatSide(ownershipChatSide);
    await writeAs(A, d.id);
    await notHanded(A, m);
  });

  it("design §7.2's last paragraph: A loses D to a take; its doc-less message is not re-owed and stays A's", async () => {
    const file = realFile("last.md");
    const id = await userOpen(file);
    await writeAs(A, id);
    const m2 = userChat(key("m2"));
    expect(chatIds(await pollAs(A))).toEqual([m2]);
    const before = JSON.stringify(row(m2));
    await openAs(B, getOpenDocs().get(id)?.filePath as string);
    expect(JSON.stringify(row(m2))).toBe(before);
    expect(messageOwner(m2)?.ownerId).toBe(A);
  });

  it("design R4.5 (chat): a handover of a quiet background document re-owes its chat", async () => {
    const d = mkDoc("quiet");
    setDocOwner(d.id, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d.id);
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([m]);
    await a.poll();
    await a.poll();
    setDocOwner(d.id, { ownerId: B, kind: "opened" }, "take", B);
    expect(chatIds(await reader(B).poll())).toEqual([m]);
  });

  it("R6.3 (i): A was handed M and has not answered; D closes; A is not handed it again but may answer; B is not handed it; a reopen and B's claim leave it A's", async () => {
    const file = realFile("close-i.md");
    const id = await userOpen(file);
    await writeAs(A, id);
    const m = userChat(key("m"), id);
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([m]);
    await closeByRoute(id);
    expect(messageOwner(m)).toEqual({ ownerId: A, origin: "close", closedDocumentId: id });
    for (const n of [1, 2]) expect(chatIds(await a.poll()), `poll ${n}`).toEqual([]);
    await notHanded(B, m);
    expect(await userOpen(file)).toBe(id);
    await writeAs(B, id);
    await notHanded(B, m);
    expect((await reply(A, m)).error).toBe(false);
  });

  it("R6.3 (i), cursor-less: a cursor-less poll of A that took M is not handed it again after the close", async () => {
    const file = realFile("close-il.md");
    const id = await userOpen(file);
    await writeAs(A, id);
    const m = userChat(key("m"), id);
    expect(chatIds(await pollAs(A))).toEqual([m]);
    await closeByRoute(id);
    expect(chatIds(await pollAs(A))).toEqual([]);
    expect(messageOwner(m)?.ownerId).toBe(A);
  });

  it("R6.3 (ii): A was never handed M; after the close A owns it and is handed it", async () => {
    const file = realFile("close-ii.md");
    const id = await userOpen(file);
    await writeAs(A, id);
    const m = userChat(key("m"), id);
    await closeByRoute(id);
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    await notHanded(B, m);
    expect((await reply(A, m)).error).toBe(false);
  });

  it("R6.3: an unowned document's close leaves its chat claimable per message", async () => {
    const file = realFile("close-u.md");
    const id = await userOpen(file);
    const m = userChat(key("m"), id);
    await closeByRoute(id);
    expect(messageOwner(m)).toBeUndefined();
    expect(chatIds(await reader(B).poll())).toEqual([m]);
    expect(messageOwner(m)?.ownerId).toBe(B);
  });

  it("R6.3: no overwrite: a second close of a reopened document leaves an earlier close's owner", async () => {
    const file = realFile("close-twice.md");
    const id = await userOpen(file);
    await writeAs(A, id);
    const m = userChat(key("m"), id);
    await closeByRoute(id);
    expect(await userOpen(file)).toBe(id);
    await writeAs(B, id);
    await closeByRoute(id);
    expect(messageOwner(m)).toEqual({ ownerId: A, origin: "close", closedDocumentId: id });
  });

  it("R6.3 with presence: an unowned document closed while Tandem's Claude is present gives it the chat", async () => {
    setTandemPresenceSource(() => true);
    const d = mkDoc("pres");
    const m = userChat(key("m"), d.id);
    await closeByRoute(d.id);
    expect(messageOwner(m)?.ownerId).toBe(TANDEM_OWNER_ID);
  });

  it("R6.3's seam: a throw in the chat half still lets the document's handover run", async () => {
    const d = mkDoc("fault");
    setDocOwner(d.id, { ownerId: A, kind: "opened" }, "take", A);
    comment(d.ydoc, "c1");
    const m = userChat(key("m"), d.id);
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setChatOwnershipFaultForTests((at) => {
      if (at === "close") throw new Error("close");
    });
    const before = deliveryRegistry.entriesIn(d.id).length;
    expect(before).toBeGreaterThan(0);
    await closeByRoute(d.id);
    expect(deliveryRegistry.entriesIn(d.id), "the handover retired the comment's entry").toEqual(
      [],
    );
    expect(messageOwner(m)).toBeUndefined();
  });

  it("R6.3: a lapsed holder whose move waits on the queue is given nothing at the close", async () => {
    const d = mkDoc("lapsed");
    setDocOwner(d.id, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d.id);
    let release!: () => void;
    const op = runDocOp(d.id, () => new Promise<void>((r) => (release = r)));
    lapseByGrace(A, "transport removed");
    expect(getOwnerRecord(A)?.lapsed).toBe(true);
    expect(ownerOf(d.id)).toBe(A);
    await closeByRoute(d.id);
    expect(messageOwner(m)).toBeUndefined();
    expect(chatIds(await reader(B).poll())).toEqual([m]);
    release();
    await op;
    await vi.waitFor(() => expect(getOwnerRecord(A)).toBeUndefined());
  });

  it("R6.5: a handled message's row is unchanged by a take, a lapse and a close", async () => {
    const file = realFile("handled.md");
    const id = await userOpen(file);
    await writeAs(A, id);
    const m = userChat(key("m"), id);
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    expect((await reply(A, m)).error).toBe(false);
    const before = JSON.stringify(row(m));
    await openAs(B, getOpenDocs().get(id)?.filePath as string);
    lapseByGrace(B, "stream dropped");
    await closeByRoute(id);
    expect(JSON.stringify(row(m))).toBe(before);
  });

  it("no chat:message event is pushed by a re-owe", async () => {
    const d = mkDoc("d");
    setDocOwner(d.id, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d.id);
    expect(chatIds(await pollAs(A))).toEqual([m]);
    const seen: TandemEvent[] = [];
    const cb = (e: TandemEvent) => seen.push(e);
    subscribe(cb, "internal");
    try {
      setDocOwner(d.id, { ownerId: B, kind: "opened" }, "take", B);
      expect(row(m)?.read).toBe(false);
      expect(seen.filter((e) => e.type === "chat:message")).toEqual([]);
    } finally {
      unsubscribe(cb);
    }
  });
});

describe("R8: the pickup row after a re-owe", () => {
  it("a re-owed message's row reads waiting, and one older than the stall threshold is stalled", async () => {
    const { chatPickup, isPickupStalled } = await import("../../src/client/panels/chat-pickup.js");
    const { DELIVERY_STALL_MS } = await import("../../src/shared/constants.js");
    const d = mkDoc("d");
    setDocOwner(d.id, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d.id);
    await pollAs(A);
    setDocOwner(d.id, { ownerId: B, kind: "opened" }, "take", B);
    const msg = row(m) as ChatMessage;
    const pickup = chatPickup([msg], msg.timestamp + DELIVERY_STALL_MS + 1);
    expect(pickup?.kind).toBe("waiting");
    expect(isPickupStalled(pickup)).toBe(true);
  });
});

describe("dark", () => {
  it("flag off: no owner, no scope, master's active-document stamp, and nothing recorded", async () => {
    await close?.();
    await buildWorld("");
    const d = mkDoc("held");
    const m = userChat(key("m"), d.id);
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    expect(chatIds(await reader(B).poll())).toEqual([m]);
    expect((await reply(B, m, { documentId: docId("front") })).error).toBe(false);
    expect(repliesTo(m)[0]?.documentId).toBe(docId("front"));
    const snap = ownershipSnapshotForTests();
    expect(snap.messageOwners).toEqual([]);
    expect(snap.handed).toEqual([]);
    expect(snap.records).toEqual([]);
  });
});
