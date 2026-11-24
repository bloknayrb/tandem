/**
 * Release and Assign of a chat message (#2358 PR 5a-2, ADR-054; ownership
 * design §10.1, §10.2, §6.5, §7.1, §7.2): the message half of
 * `POST /api/ownership`, the message's loss record, the one controlled
 * overwrite of a per-message owner (the exception to the chat owners
 * amendment's R3.3), and a document's Release or Assign moving the messages
 * its close gave an owner.
 *
 * Everything an AI sees goes through the real `tandem_checkInbox` and
 * `tandem_reply` tools, with three registered records, A, B and C, each with
 * its own cursor, and the seams `src/server/index.ts` wires. The route's own
 * handler is called directly with an allowlisted origin and a loopback peer
 * (the gates and the flag-off registration are pinned through the real HTTP
 * server in `ownership-control-route.test.ts`). `setDocOwner` is used only
 * for setup.
 *
 * Platform: in-memory fixture documents with synthetic paths; nothing is
 * gated.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { setChatRowsDeletedListener } from "../../src/server/chat-row-deletions.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import {
  handOverDocumentInbox,
  ownershipChatSide,
  registerAwarenessTools,
  resetInbox,
  setWaitingWrittenSinceForTests,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  checkInboxOutputShape,
  checkInboxOwnershipShape,
} from "../../src/server/mcp/output-schemas.js";
import { handleClose } from "../../src/server/mcp/routes/close.js";
import { handleOwnershipControl } from "../../src/server/mcp/routes/ownership.js";
import { runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  captureCarriedOverChat,
  controlMessageOwner,
  DEFAULT_GRACE_MS,
  forgetChatMessageOwners,
  getDocOwner,
  getOwnerRecord,
  noteTransportChanged,
  noteTransportRegistered,
  type OwnershipChatSide,
  ownershipSnapshotForTests,
  pushStreamAdmits,
  resetOwnershipForTests,
  setChatOwnershipFaultForTests,
  setDocOwner,
  setOpenDocumentIdsSource,
  setOwnershipChatSide,
  setOwnershipFrameSink,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setStartOrWakeSink,
  setTandemPresenceSource,
  setTransportView,
  setWakeObserverForTests,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
  tandemWorkWaiting,
} from "../../src/server/sessions/ownership.js";
import {
  MESSAGE_REASSIGNED,
  MESSAGE_RELEASED,
} from "../../src/server/sessions/ownership-refusal.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_CHAT } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import type { ChatMessage } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { makeRes } from "../helpers/route-recorder.js";

/** Set to make the next `resolveDeliveryRound` throw: a throw after the chat commit (as in `ownership-chat.test.ts`). */
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

const A = "claude:msgctl-a";
const B = "claude:msgctl-b";
const C = "claude:msgctl-c";
const TANDEM = TANDEM_OWNER_ID;

const inboxSchema = z.object({ ...checkInboxOutputShape, ...checkInboxOwnershipShape });
type Inbox = z.infer<typeof inboxSchema>;

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs: string = A;
let run = 0;
let prefix = "";
let present = false;
let forwarded: string[] = [];
let frames = 0;

const docId = (name: string) => `${prefix}-${name}`;
const key = (name: string) => `${prefix}-${name}`;

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 0 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

function mkDoc(name: string): string {
  const id = docId(name);
  const ydoc = getOrCreateDocument(id);
  if (ydoc.getXmlFragment("default").length === 0) {
    populateYDoc(ydoc, "Hello world, this is a test document.");
  }
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return id;
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

type Result = {
  error: boolean;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

async function as(owner: string, tool: string, args: Record<string, unknown> = {}) {
  callingAs = owner;
  return parseResult(await client.callTool({ name: tool, arguments: args })) as Result;
}

async function pollAs(owner: string, args: Record<string, unknown> = {}): Promise<Inbox> {
  callingAs = owner;
  const result = await client.callTool({ name: "tandem_checkInbox", arguments: args });
  expect(parseResult(result).error, JSON.stringify(result)).toBe(false);
  return inboxSchema.parse((result as { structuredContent: unknown }).structuredContent);
}

const chatIds = (inbox: Inbox) => inbox.chatMessages.map((m) => String(m.id)).sort();

/** A fresh cursor reader's poll as `owner`. */
async function freshPoll(owner: string): Promise<string[]> {
  return chatIds(await pollAs(owner, { cursor: "start" }));
}

const reply = (owner: string, replyTo: string, extra: Record<string, unknown> = {}) =>
  as(owner, "tandem_reply", { text: `reply from ${owner}`, replyTo, ...extra });

const messageOwner = (k: string) =>
  ownershipSnapshotForTests().messageOwners.find(([mk]) => mk === k)?.[1];
const messageLoss = (k: string) =>
  ownershipSnapshotForTests().messageLosses.find(([mk]) => mk === k)?.[1];
const labelOf = (owner: string) => getOwnerRecord(owner)?.label as string;

/** Call `POST /api/ownership` through its own handler: an allowlisted origin, a loopback peer. */
async function control(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const res = makeRes();
  await handleOwnershipControl(
    {
      body,
      headers: { origin: "http://127.0.0.1:5173" },
      socket: { remoteAddress: "127.0.0.1" },
    } as never,
    Object.assign(res, { on: () => res }) as unknown as Response,
  );
  return { status: res._status, body: res._body };
}

const releaseMessage = (k: string) => control({ messageId: k, action: "release" });
const assignMessage = (k: string, owner: string) =>
  control({ messageId: k, action: "assign", ownerLabel: labelOf(owner) });

/** Make a record of Tandem's Claude exist (and so have a label), present. */
function tandemPresent(): void {
  present = true;
  setDocOwner(docId("front"), { ownerId: TANDEM, kind: "default" }, "presence");
}

async function closeByRoute(id: string): Promise<void> {
  const res = makeRes();
  await handleClose(
    { body: { documentId: id }, socket: { remoteAddress: "127.0.0.1" }, headers: {} } as never,
    res as never,
  );
  expect(res._status, JSON.stringify(res._body)).toBe(200);
}

function lapseByGrace(owner: string): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  view = view.filter((e) => e.ownerId !== owner);
  noteTransportChanged(owner);
  vi.advanceTimersByTime(DEFAULT_GRACE_MS + 1);
  vi.useRealTimers();
}

async function startTools(): Promise<void> {
  ({ client, close } = await setupMcpServer(
    [registerAwarenessTools, registerDocumentTools, registerAnnotationTools],
    { dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }) },
  ));
  await client.listTools();
}

async function buildWorld(flag: "1" | "" = "1"): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `msgctl${run}`;
  callingAs = A;
  present = false;
  forwarded = [];
  frames = 0;
  resetInbox();
  resetOwnershipForTests();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  clearChat();
  view = [];
  setTransportView(() => view);
  register(A);
  register(B);
  register(C);
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setOwnershipChatSide(ownershipChatSide);
  setChatRowsDeletedListener(forgetChatMessageOwners);
  setTandemPresenceSource(() => present);
  setOpenDocumentIdsSource(() => getOpenDocs().keys());
  setStartOrWakeSink((cause) => forwarded.push(cause));
  setOwnershipFrameSink(() => {
    frames++;
  });
  setCtrlMode("tandem");
  setActiveDocId(mkDoc("front"));
  await startTools();
}

beforeEach(async () => {
  // The fixture's rows carry small timestamps; the waiting rule's boot filter is off.
  setWaitingWrittenSinceForTests(undefined);
  await buildWorld();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setChatOwnershipFaultForTests(undefined);
  setWakeObserverForTests(undefined);
  setChatRowsDeletedListener(undefined);
  resetOwnershipForTests();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  clearChat();
  setWaitingWrittenSinceForTests(Date.now());
  vi.unstubAllEnvs();
});

/**
 * `owner` takes the claimable message `k` with a cursor-less poll, which
 * stamps it read at hand-out (so only a re-owe makes it owed to a fresh
 * reader again).
 */
async function takeByPoll(owner: string, k: string): Promise<void> {
  expect(chatIds(await pollAs(owner))).toContain(k);
  expect(messageOwner(k)?.ownerId).toBe(owner);
  expect(row(k)?.read).toBe(true);
}

describe("Release of a message (ownership design §10.2)", () => {
  it("drops the per-message owner, records a blocking released loss, re-owes it, and another session takes it", async () => {
    const m = userChat(key("m"));
    await takeByPoll(A, m);
    expect(row(m)?.read).toBe(true);
    const ack = await reply(A, m, { inProgress: true });
    expect(ack.error, JSON.stringify(ack)).toBe(false);

    const res = await releaseMessage(m);
    expect(res).toEqual({ status: 200, body: { data: { changed: true } } });
    expect(messageOwner(m)).toBeUndefined();
    expect(messageLoss(m)).toEqual({ ownerId: A, cause: "released" });
    // The chat handover (design §6.5): unread again, its acknowledgement superseded.
    expect(row(m)?.read).toBe(false);
    const acks = [...chatMap().values()].filter(
      (v) => (v as ChatMessage).replyTo === m && (v as ChatMessage).inProgress === true,
    ) as ChatMessage[];
    expect(acks.map((r) => r.superseded)).toEqual([true]);
    // Claimable by anyone else now, so attached sessions are nudged once.
    expect(frames).toBe(1);
    expect(forwarded).toEqual([]);

    // A is not handed it, and its reply is refused with the released copy.
    expect(await freshPoll(A)).not.toContain(m);
    const refused = await reply(A, m);
    expect(refused).toMatchObject({
      error: true,
      code: "NOT_DOC_OWNER",
      message: MESSAGE_RELEASED,
      details: { reason: "chat", holder: null },
    });
    const ackRefused = await reply(A, m, { inProgress: true });
    expect(ackRefused).toMatchObject({ code: "NOT_DOC_OWNER", message: MESSAGE_RELEASED });

    // B is handed it and takes it; the loss ends with that change of owner.
    await takeByPoll(B, m);
    expect(messageLoss(m)).toBeUndefined();
    expect((await reply(B, m)).error).toBe(false);
  });

  it("a message Tandem's Claude owns per message goes to other sessions, never back to it by presence", async () => {
    tandemPresent();
    present = false;
    const m = userChat(key("m"));
    await takeByPoll(A, m);
    present = true;
    expect((await assignMessage(m, TANDEM)).body).toEqual({ data: { changed: true } });
    expect(messageOwner(m)).toEqual({ ownerId: TANDEM, origin: "assign" });
    forwarded = [];
    frames = 0;

    expect((await releaseMessage(m)).body).toEqual({ data: { changed: true } });
    expect(messageLoss(m)).toEqual({ ownerId: TANDEM, cause: "released" });
    // Not Tandem's Claude's by presence: no forward, the frame for the others.
    expect(forwarded).toEqual([]);
    expect(frames).toBe(1);
    expect(await freshPoll(TANDEM)).not.toContain(m);
    await takeByPoll(B, m);
  });

  it("a message with no per-message owner is a no-op (changed: false), nothing written", async () => {
    const m = userChat(key("m"));
    expect(await releaseMessage(m)).toEqual({ status: 200, body: { data: { changed: false } } });
    tandemPresent();
    // Tandem's Claude's by presence: no per-message owner, so a no-op too.
    expect(await releaseMessage(m)).toEqual({ status: 200, body: { data: { changed: false } } });
    expect(ownershipSnapshotForTests().messageLosses).toEqual([]);
    expect(frames).toBe(0);
  });

  it("on an open document its holder holds: the message is claimable by others, not by that holder", async () => {
    // A holds D; D closes (A becomes the message's owner, origin close); D
    // reopens and A claims it again, so the message is A's per message on
    // an open document A holds.
    const d = mkDoc("d");
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d);
    await closeByRoute(d);
    expect(messageOwner(m)).toMatchObject({ ownerId: A, origin: "close" });
    mkDoc("d");
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);

    expect((await releaseMessage(m)).body).toEqual({ data: { changed: true } });
    // The table would give it back to A (D's holder); the loss skips A.
    expect(await freshPoll(A)).not.toContain(m);
    expect(await reply(A, m)).toMatchObject({ code: "NOT_DOC_OWNER", message: MESSAGE_RELEASED });
    await takeByPoll(B, m);
    expect(getDocOwner(d)?.ownerId).toBe(A);
  });

  it("a tab close never gives a released message back to the record it was released from", async () => {
    const d = mkDoc("d");
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d);
    await closeByRoute(d);
    mkDoc("d");
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);
    await releaseMessage(m);
    // A closes D again while it holds it: the close's owner would be A.
    await closeByRoute(d);
    expect(messageOwner(m)).toBeUndefined();
    expect(messageLoss(m)).toEqual({ ownerId: A, cause: "released" });
  });

  it("after a Release, the next owner's lapse ends the loss: the record it was released from may take it again", async () => {
    const m = userChat(key("m"));
    await takeByPoll(A, m);
    await releaseMessage(m);
    await takeByPoll(B, m);
    // B's lapse is a change of owner: no loss stands, and A may take it again.
    lapseByGrace(B);
    expect(messageOwner(m)).toBeUndefined();
    expect(messageLoss(m)).toBeUndefined();
    await takeByPoll(A, m);
  });

  it("a poll that took a released message and then failed puts the loss back: it never goes back to the released record", async () => {
    tandemPresent();
    present = false;
    const m = userChat(key("m"));
    await takeByPoll(A, m);
    present = true;
    await assignMessage(m, TANDEM);
    await releaseMessage(m);
    expect(messageLoss(m)).toEqual({ ownerId: TANDEM, cause: "released" });
    forwarded = [];

    // B's poll takes it, then throws after its chat commit: the take is undone.
    roundThrows.next = true;
    callingAs = B;
    expect(
      parseResult(
        await client.callTool({ name: "tandem_checkInbox", arguments: { cursor: "start" } }),
      ).error,
    ).toBe(true);
    expect(roundThrows.next).toBe(false);
    expect(messageOwner(m)).toBeUndefined();
    // Not a change of owner: the loss stands, so Tandem's Claude is not given it back by presence.
    expect(messageLoss(m)).toEqual({ ownerId: TANDEM, cause: "released" });
    expect(forwarded).toEqual([]);
    expect(await freshPoll(TANDEM)).not.toContain(m);
    await takeByPoll(B, m);
  });
});

describe("Assign of a message (ownership design §10.2; the exception to R3.3)", () => {
  it("overwrites another record's per-message owner, records a blocking assigned loss, re-owes it to the new owner", async () => {
    const m = userChat(key("m"));
    await takeByPoll(A, m);
    frames = 0;

    const res = await assignMessage(m, B);
    expect(res).toEqual({ status: 200, body: { data: { changed: true } } });
    expect(messageOwner(m)).toEqual({ ownerId: B, origin: "assign" });
    expect(messageLoss(m)).toEqual({ ownerId: A, cause: "assigned" });
    expect(row(m)?.read).toBe(false);
    expect(frames).toBe(1);

    expect(await freshPoll(B)).toContain(m);
    expect(await freshPoll(A)).not.toContain(m);
    // A's reply names B, the holder (design §5.3's chat copy).
    expect(await reply(A, m)).toMatchObject({
      code: "NOT_DOC_OWNER",
      details: { reason: "chat", holder: { label: labelOf(B), displayKind: "terminal" } },
    });
    expect((await reply(B, m)).error).toBe(false);
  });

  it("Assign to Tandem's Claude starts or wakes it for the message, even with another session connected (the user's choice)", async () => {
    tandemPresent();
    const m = userChat(key("m"));
    // A owns it per message (an acknowledgement of a doc-less message).
    present = false;
    await takeByPoll(A, m);
    present = true;
    forwarded = [];
    frames = 0;
    expect((await assignMessage(m, TANDEM)).body).toEqual({ data: { changed: true } });
    expect(messageOwner(m)).toEqual({ ownerId: TANDEM, origin: "assign" });
    expect(forwarded).toEqual(["message"]);
    expect(frames).toBe(0);
    expect(await freshPoll(TANDEM)).toContain(m);
  });

  it("Assign of a message Tandem's Claude owns by presence; when the assignee lapses it comes back to Tandem's Claude", async () => {
    tandemPresent();
    const m = userChat(key("m"));
    expect((await assignMessage(m, B)).body).toEqual({ data: { changed: true } });
    expect(messageLoss(m)).toEqual({ ownerId: TANDEM, cause: "assigned" });
    expect(await freshPoll(TANDEM)).not.toContain(m);
    expect(await freshPoll(B)).toContain(m);
    // B goes away: its unanswered message loses its owner, the loss ends with
    // that change, and the table gives it to Tandem's Claude again.
    lapseByGrace(B);
    expect(messageLoss(m)).toBeUndefined();
    expect(await freshPoll(TANDEM)).toContain(m);
  });

  it("Assign to the record that already holds the message is a no-op (Bryan's 'Do nothing'), per message or by presence", async () => {
    const m = userChat(key("m"));
    await takeByPoll(A, m);
    frames = 0;
    expect(await assignMessage(m, A)).toEqual({ status: 200, body: { data: { changed: false } } });
    expect(messageOwner(m)).toEqual({ ownerId: A, origin: "poll" });
    expect(row(m)?.read).toBe(true);

    tandemPresent();
    const n = userChat(key("n"));
    forwarded = [];
    expect(await assignMessage(n, TANDEM)).toEqual({
      status: 200,
      body: { data: { changed: false } },
    });
    expect(messageOwner(n)).toBeUndefined();
    expect(forwarded).toEqual([]);
    expect(frames).toBe(0);
  });

  it("unknown-owner and owner-detached, as for a document", async () => {
    const m = userChat(key("m"));
    expect(
      await control({ messageId: m, action: "assign", ownerLabel: "owner-zzzz" }),
    ).toMatchObject({ status: 404, body: { error: "unknown-owner" } });
    // Tandem's Claude not present cannot take a message.
    tandemPresent();
    present = false;
    expect(await assignMessage(m, TANDEM)).toMatchObject({
      status: 409,
      body: { error: "owner-detached" },
    });
    // A session in its grace cannot either.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    view = view.filter((e) => e.ownerId !== C);
    noteTransportChanged(C);
    vi.useRealTimers();
    expect(await assignMessage(m, C)).toMatchObject({
      status: 409,
      body: { error: "owner-detached" },
    });
    expect(messageOwner(m)).toBeUndefined();
  });
});

describe("which messages the message control takes", () => {
  it("404 unknown-message for an id with no user chat row", async () => {
    expect(await releaseMessage(key("none"))).toMatchObject({
      status: 404,
      body: { error: "unknown-message" },
    });
  });

  it("409 follows-document for a message that follows an open document, held or unowned", async () => {
    const d = mkDoc("d");
    const m = userChat(key("m"), d);
    expect(await assignMessage(m, B)).toMatchObject({
      status: 409,
      body: { error: "follows-document" },
    });
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);
    expect(await releaseMessage(m)).toMatchObject({
      status: 409,
      body: { error: "follows-document" },
    });
    expect(messageOwner(m)).toBeUndefined();
  });

  it("409 answered for a message a final reply answered", async () => {
    const m = userChat(key("m"));
    await takeByPoll(A, m);
    expect((await reply(A, m)).error).toBe(false);
    expect(await assignMessage(m, B)).toMatchObject({ status: 409, body: { error: "answered" } });
    expect(messageOwner(m)?.ownerId).toBe(A);
  });

  it("is synchronous: it answers while the message's document's queue is busy", async () => {
    const d = mkDoc("d");
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d);
    await closeByRoute(d);
    mkDoc("d");
    let release!: () => void;
    const held = runDocOp(d, () => new Promise<void>((r) => (release = r)));
    try {
      expect((await assignMessage(m, B)).body).toEqual({ data: { changed: true } });
      expect(messageOwner(m)).toEqual({ ownerId: B, origin: "assign" });
    } finally {
      release();
      await held;
    }
  });

  it("a failed chat re-owe answers 500 and changes nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const m = userChat(key("m"));
    await takeByPoll(A, m);
    setChatOwnershipFaultForTests((at) => {
      if (at === "re-owe") throw new Error("fault");
    });
    const res = await assignMessage(m, B);
    expect(res.status).toBe(500);
    expect(messageOwner(m)).toEqual({ ownerId: A, origin: "poll" });
    expect(messageLoss(m)).toBeUndefined();
    expect(frames).toBe(0);
  });
});

describe("a document's Release or Assign moves the messages its close gave an owner (design §7.2)", () => {
  /** A held D when it closed, so the message on D is A's (origin close); D is open again, held by B. */
  async function closedThenReclaimed(): Promise<{ d: string; m: string }> {
    const d = mkDoc("d");
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d);
    // A, D's holder, is handed it (cursor-less: stamped read), with no per-message owner.
    expect(chatIds(await pollAs(A))).toContain(m);
    expect(row(m)?.read).toBe(true);
    await closeByRoute(d);
    expect(messageOwner(m)).toMatchObject({ ownerId: A, origin: "close", closedDocumentId: d });
    mkDoc("d");
    setDocOwner(d, { ownerId: B, kind: "claimed" }, "claim", B);
    return { d, m };
  }

  it("Assign of the document: the message follows it to the new holder, re-owed, and the old owner is refused naming it", async () => {
    const { d, m } = await closedThenReclaimed();
    const res = await control({ documentId: d, action: "assign", ownerLabel: labelOf(C) });
    expect(res).toEqual({ status: 200, body: { data: { changed: true } } });
    expect(messageOwner(m)).toBeUndefined();
    // Moved with the document: no message loss (it was not the message's control).
    expect(messageLoss(m)).toBeUndefined();
    expect(row(m)?.read).toBe(false);
    expect(await freshPoll(C)).toContain(m);
    expect(await reply(A, m)).toMatchObject({
      code: "NOT_DOC_OWNER",
      details: { holder: { label: labelOf(C) } },
    });
  });

  it("Release of the document while Tandem's Claude is present: the message follows it to Tandem's Claude, which is woken", async () => {
    const { d, m } = await closedThenReclaimed();
    present = true;
    forwarded = [];
    const res = await control({ documentId: d, action: "release" });
    expect(res.body).toEqual({ data: { changed: true } });
    expect(getDocOwner(d)).toMatchObject({ ownerId: TANDEM, kind: "default" });
    expect(messageOwner(m)).toBeUndefined();
    expect(forwarded).toContain("message");
    expect(await freshPoll(TANDEM)).toContain(m);
  });

  it("Release of a document whose entry is stale (its record is gone) moves the close-given message too", async () => {
    const d = mkDoc("d");
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d);
    expect(chatIds(await pollAs(A))).toContain(m);
    await closeByRoute(d);
    expect(messageOwner(m)).toMatchObject({ ownerId: A, origin: "close", closedDocumentId: d });
    mkDoc("d");
    // An entry for a record that does not exist (the stale backstop's case).
    setDocOwner(d, { ownerId: "bridge:gone", kind: "opened" }, "take", "bridge:gone");
    present = true;
    forwarded = [];
    const res = await control({ documentId: d, action: "release" });
    expect(res.body).toEqual({ data: { changed: true } });
    expect(getDocOwner(d)).toMatchObject({ ownerId: TANDEM, kind: "default" });
    expect(messageOwner(m)).toBeUndefined();
    expect(row(m)?.read).toBe(false);
    expect(forwarded).toContain("message");
    expect(await freshPoll(TANDEM)).toContain(m);
  });

  it("a no-op document control (Assign to the holder) moves nothing", async () => {
    const { d, m } = await closedThenReclaimed();
    const res = await control({ documentId: d, action: "assign", ownerLabel: labelOf(B) });
    expect(res.body).toEqual({ data: { changed: false } });
    expect(messageOwner(m)).toMatchObject({ ownerId: A, origin: "close" });
  });

  it("a message whose close-given owner is the document's next holder only stops being owned per message: nothing re-owed", async () => {
    const { d, m } = await closedThenReclaimed();
    expect(row(m)?.read).toBe(true);
    frames = 0;
    const res = await control({ documentId: d, action: "assign", ownerLabel: labelOf(A) });
    expect(res.body).toEqual({ data: { changed: true } });
    expect(messageOwner(m)).toBeUndefined();
    expect(row(m)?.read).toBe(true);
  });

  it("Release of the document with Tandem's Claude not present: the message follows it unowned, the others are nudged, and the released holder cannot claim it", async () => {
    const { d, m } = await closedThenReclaimed();
    frames = 0;
    const res = await control({ documentId: d, action: "release" });
    expect(res.body).toEqual({ data: { changed: true } });
    expect(getDocOwner(d)).toBeUndefined();
    expect(messageOwner(m)).toBeUndefined();
    expect(messageLoss(m)).toBeUndefined();
    expect(frames).toBeGreaterThanOrEqual(1);
    // B was released from D (a blocking document loss): its poll reads
    // neither D nor the message that follows it.
    expect(await freshPoll(B)).not.toContain(m);
    // Anyone else may claim D through the message.
    expect(await freshPoll(C)).toContain(m);
  });
});

describe("a carried-over message (Bryan's pick 'Let Assign own them', 2026-11-23)", () => {
  /** A restored row: read and unhandled at boot, taken as carried over. */
  function carriedOverMessage(documentId?: string): string {
    const m = userChat(key("m"), documentId);
    withInternal(ctrl(), () => chatMap().set(m, { ...(row(m) as ChatMessage), read: true }));
    captureCarriedOverChat(() => [m]);
    expect(ownershipSnapshotForTests().carriedOver).toEqual([m]);
    return m;
  }

  it("before any control: handed to nobody, owned by nobody", async () => {
    const m = carriedOverMessage();
    expect(chatIds(await pollAs(A))).not.toContain(m);
    expect(messageOwner(m)).toBeUndefined();
  });

  it("Assign gives it an owner and ends its carried-over status: owed to the owner, others refused naming it, its acknowledgement and final reply accepted", async () => {
    const m = carriedOverMessage();
    const res = await assignMessage(m, B);
    expect(res).toEqual({ status: 200, body: { data: { changed: true } } });
    expect(messageOwner(m)).toEqual({ ownerId: B, origin: "assign" });
    expect(ownershipSnapshotForTests().carriedOver).toEqual([]);
    // Nobody held it, so no loss.
    expect(messageLoss(m)).toBeUndefined();
    // Owed: unread again, and the owner's poll is handed it; nobody else's is.
    expect(row(m)?.read).toBe(false);
    expect(await freshPoll(A)).not.toContain(m);
    expect(await freshPoll(B)).toContain(m);
    expect(await reply(A, m)).toMatchObject({
      code: "NOT_DOC_OWNER",
      details: { reason: "chat", holder: { label: labelOf(B) } },
    });
    expect((await reply(B, m, { inProgress: true })).error).toBe(false);
    expect((await reply(B, m)).error).toBe(false);
    // The final reply made B its answerer, as for any owned message.
    expect(ownershipSnapshotForTests().chatAnswerers.find(([k]) => k === m)?.[1]).toBe(B);
  });

  it("Assign of one on an open document is allowed (it follows no document)", async () => {
    const d = mkDoc("d");
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);
    const m = carriedOverMessage(d);
    expect((await assignMessage(m, B)).body).toEqual({ data: { changed: true } });
    expect(messageOwner(m)).toEqual({ ownerId: B, origin: "assign" });
  });

  it("Release of one is a no-op: it stays carried over, with no owner", async () => {
    const m = carriedOverMessage();
    expect(await releaseMessage(m)).toEqual({ status: 200, body: { data: { changed: false } } });
    expect(ownershipSnapshotForTests().carriedOver).toEqual([m]);
    expect(messageOwner(m)).toBeUndefined();
  });

  it("unknown-owner and owner-detached leave it carried over", async () => {
    const m = carriedOverMessage();
    expect(
      await control({ messageId: m, action: "assign", ownerLabel: "owner-zzzz" }),
    ).toMatchObject({ status: 404, body: { error: "unknown-owner" } });
    tandemPresent();
    present = false;
    expect(await assignMessage(m, TANDEM)).toMatchObject({
      status: 409,
      body: { error: "owner-detached" },
    });
    expect(ownershipSnapshotForTests().carriedOver).toEqual([m]);
  });

  it("a failed re-owe leaves it carried over with no owner (500)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const m = carriedOverMessage();
    setChatOwnershipFaultForTests((at) => {
      if (at === "re-owe") throw new Error("fault");
    });
    expect((await assignMessage(m, B)).status).toBe(500);
    expect(ownershipSnapshotForTests().carriedOver).toEqual([m]);
    expect(messageOwner(m)).toBeUndefined();
  });

  it("once Assigned it is ordinary: its owner's lapse re-owes it and another session may take it", async () => {
    const m = carriedOverMessage();
    await assignMessage(m, B);
    lapseByGrace(B);
    expect(messageOwner(m)).toBeUndefined();
    expect(ownershipSnapshotForTests().carriedOver).toEqual([]);
    await takeByPoll(C, m);
  });

  it("no other writer gives one an owner: a poll, a reply and a tab close leave it ownerless", async () => {
    const d = mkDoc("d");
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);
    const m = carriedOverMessage(d);
    await pollAs(A);
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    expect((await reply(A, m)).error).toBe(false);
    const n = userChat(key("n"), d);
    withInternal(ctrl(), () => chatMap().set(n, { ...(row(n) as ChatMessage), read: true }));
    captureCarriedOverChat(() => [n]);
    await closeByRoute(d);
    const owners = ownershipSnapshotForTests().messageOwners.map(([k]) => k);
    expect(owners).not.toContain(m);
    expect(owners).not.toContain(n);
  });
});

describe("the message loss beyond the gate and the poll", () => {
  it("a mapped push stream of the record a message was released from does not get it; the others do", async () => {
    const m = userChat(key("m"));
    await takeByPoll(A, m);
    await releaseMessage(m);
    expect(pushStreamAdmits("msgctl-a", { chatMessageKey: m })).toBe(false);
    expect(pushStreamAdmits("msgctl-b", { chatMessageKey: m })).toBe(true);
  });

  it("Tandem's Claude's waiting decision never counts a message released from it", async () => {
    // Tandem's Claude present; D unowned and open; its close gives the
    // message to Tandem's Claude (origin close); D reopens unowned.
    tandemPresent();
    const d = mkDoc("d");
    const m = userChat(key("m"), d);
    await closeByRoute(d);
    expect(messageOwner(m)).toMatchObject({ ownerId: TANDEM, origin: "close" });
    mkDoc("d");
    // No other session is connected.
    for (const owner of [A, B, C]) lapseByGrace(owner);
    expect(tandemWorkWaiting()).toBe(true);
    expect((await releaseMessage(m)).body).toEqual({ data: { changed: true } });
    expect(messageLoss(m)).toEqual({ ownerId: TANDEM, cause: "released" });
    // It now follows D, which nobody holds: claimable, but not by Tandem's Claude.
    expect(tandemWorkWaiting()).toBe(false);
    expect(await freshPoll(TANDEM)).not.toContain(m);
  });
});

describe("flag off", () => {
  it("controlMessageOwner records nothing and answers unknown-message", async () => {
    await close?.();
    await buildWorld("");
    const m = userChat(key("m"));
    expect(controlMessageOwner(m, "assign", "owner-abcd")).toBe("unknown-message");
    const snap = ownershipSnapshotForTests();
    expect(snap.messageOwners).toEqual([]);
    expect(snap.messageLosses).toEqual([]);
    expect(snap.records).toEqual([]);
  });
});

describe("the message's loss outside the reply gate (unit, a fake chat side)", () => {
  it("not-controllable for local-period chat; the reassigned copy is true for an assigned loss with no holder", async () => {
    const facts = new Map<
      string,
      { documentId?: string; documentOpen: boolean; localPeriod: boolean }
    >([
      ["local", { documentOpen: false, localPeriod: true }],
      ["m", { documentOpen: false, localPeriod: false }],
    ]);
    const side: OwnershipChatSide = {
      handledKeys: () => new Set(),
      messagesOn: () => [],
      unhandledKeys: () => [...facts.keys()],
      message: (k) => facts.get(k),
      reOwe: () => {},
      settleCandidates: () => [],
      addSettles: () => [],
      owedToFreshReader: () => [...facts.keys()],
    };
    setOwnershipChatSide(side);
    expect(controlMessageOwner("local", "assign", labelOf(B))).toBe("not-controllable");
    expect(MESSAGE_REASSIGNED).toContain("assigned to another session");
    expect(MESSAGE_REASSIGNED).not.toMatch(/user/);
    expect(MESSAGE_RELEASED).not.toMatch(/user/);
  });
});
