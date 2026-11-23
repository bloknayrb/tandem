/**
 * Take-back, the self re-owe and their wake at each run start of Tandem's
 * Claude, the taken-back exclusion texts and the Solo-release check (#2358 PR
 * 3b-2b4b, ADR-054; ownership design §6.3, §6.5, §8.2, §8.3). Ships dark:
 * flag on for the whole file except the dark case.
 *
 * The world is `ownership-waiting-chat.test.ts`'s, cut down: the real
 * `tandem_checkInbox` with the seams `src/server/index.ts` wires (the inbox
 * handover, the chat side, the waiting probe, the open documents), a
 * terminal A, and Tandem's Claude present unless a case says otherwise. The
 * run start is `noteTandemRunStart()`, called as the supervisor's run-start
 * event calls it (`index.ts`); its wake goes to a counting sink. The
 * supervisor's half (the event, `requestWake`'s licence check, the
 * Solo-release start) is in `tests/server/launcher/supervisor-presence.test.ts`.
 *
 * Platform: real files under `os.tmpdir()` joined with `path.join`.
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
import { unwatchFile } from "../../src/server/file-watcher.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import {
  documentWaiting,
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
import { handleModeRelease } from "../../src/server/mcp/routes/mode-release.js";
import { handleOpen } from "../../src/server/mcp/routes/open.js";
import { runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  captureCarriedOverChat,
  forgetChatMessageOwners,
  getDocOwner,
  noteSoloReleased,
  noteTandemPresence,
  noteTandemRunStart,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setOpenDocumentIdsSource,
  setOwnershipChatSide,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setRequestWakeSink,
  setStartOrWakeSink,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
  tandemWorkWaiting,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_ANNOTATIONS, Y_MAP_CHAT } from "../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { makeRes } from "../helpers/route-recorder.js";

const A = "claude:take-back-a";
const TANDEM = TANDEM_OWNER_ID;

const inboxSchema = z.object({ ...checkInboxOutputShape, ...checkInboxOwnershipShape });
type Inbox = z.infer<typeof inboxSchema>;

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs = A;
let run = 0;
let prefix = "";
let tmpDir = "";
let present = true;
let wakes = 0;
let forwarded: string[] = [];
let clock = 1_000;

interface Doc {
  id: string;
  ydoc: Y.Doc;
}

function mkDoc(name: string): Doc {
  const id = `${prefix}-${name}`;
  const ydoc = getOrCreateDocument(id);
  if (ydoc.getXmlFragment("default").length === 0) {
    populateYDoc(ydoc, "Hello world, this is a test document.");
  }
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return { id, ydoc };
}

function realFile(name: string): string {
  const filePath = path.join(tmpDir, `${prefix}-${name}`);
  fs.writeFileSync(filePath, `Hello world, this is test document ${filePath}.\n`);
  return filePath;
}

async function as(owner: string, tool: string, args: Record<string, unknown> = {}) {
  callingAs = owner;
  return parseResult(await client.callTool({ name: tool, arguments: args })) as {
    error: boolean;
    code?: string;
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
    async poll(): Promise<Inbox> {
      const inbox = await pollAs(owner, { cursor });
      cursor = inbox.cursor;
      return inbox;
    },
  };
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

function userComment(ydoc: Y.Doc, id: string): string {
  withBrowser(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: `text of ${id}`,
      status: "pending",
      timestamp: clock++,
      rev: 1,
    }),
  );
  return id;
}

const ctrl = () => getOrCreateDocument(CTRL_ROOM);
const chatMap = () => ctrl().getMap(Y_MAP_CHAT);

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

/** Every answerable id a poll hands: chat, comments and replies. */
const handed = (inbox: Inbox) =>
  [
    ...inbox.chatMessages.map((m) => String(m.id)),
    ...inbox.userActions.map((a) => String(a.id)),
    ...inbox.userReplies.map((r) => String(r.id)),
  ].sort();

/** A document operation that runs until `release` is called. */
function hold(documentId: string): { release: () => void; done: Promise<unknown> } {
  let release = () => {};
  const done = runDocOp(documentId, () => new Promise<void>((r) => (release = r)));
  return { release: () => release(), done };
}

async function buildWorld(flag: "1" | "" = "1"): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `tb${run}`;
  callingAs = A;
  present = true;
  wakes = 0;
  forwarded = [];
  resetInbox();
  resetOwnershipForTests();
  for (const [id, doc] of [...getOpenDocs()]) {
    unwatchFile(doc.filePath);
    removeDoc(id);
  }
  clearChat();
  view = [{ ownerId: A, openStreams: 0 }];
  setTransportView(() => view);
  noteTransportRegistered(A, { recordKind: "claude" });
  // The lines of `src/server/index.ts`.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setOwnershipChatSide(ownershipChatSide);
  setChatRowsDeletedListener(forgetChatMessageOwners);
  setWaitingProbe(documentWaiting);
  setOpenDocumentIdsSource(() => getOpenDocs().keys());
  setTandemPresenceSource(() => present);
  setRequestWakeSink(() => {
    wakes += 1;
  });
  setStartOrWakeSink((cause) => forwarded.push(cause));
  setCtrlMode("tandem");
  setActiveDocId(mkDoc("front").id);
  ({ client, close } = await setupMcpServer(
    [registerAwarenessTools, registerDocumentTools, registerAnnotationTools],
    { dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }) },
  ));
  await client.listTools();
}

beforeEach(async () => {
  setWaitingWrittenSinceForTests(undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-take-back-"));
  await buildWorld();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.restoreAllMocks();
  setWaitingProbe(() => false);
  setChatRowsDeletedListener(undefined);
  for (const [id, doc] of [...getOpenDocs()]) {
    unwatchFile(doc.filePath);
    removeDoc(id);
  }
  clearChat();
  resetOwnershipForTests();
  resetInbox();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("the self re-owe at a run start (ownership design §8.2; the dead run's row)", () => {
  it("what a previous run was handed and acknowledged but did not answer is owed again to a fresh reader, and wakes", async () => {
    const d = mkDoc("d");
    setDocOwner(d.id, { ownerId: TANDEM, kind: "default" }, "presence");
    const c = userComment(d.ydoc, `${prefix}-c`);
    const onDoc = userChat(`${prefix}-m`, d.id);
    const docless = userChat(`${prefix}-m2`);
    const oldRun = reader(TANDEM);
    expect(handed(await oldRun.poll())).toEqual([c, onDoc, docless].sort());
    await oldRun.poll(); // acknowledged; then the run dies unanswered
    expect(tandemWorkWaiting(), "the dead run's row: stranded").toBe(false);

    noteTandemRunStart();
    expect(wakes).toBe(1);
    expect(tandemWorkWaiting()).toBe(true);
    expect(handed(await reader(TANDEM).poll())).toEqual([c, onDoc, docless].sort());
    // The holder is unchanged: a re-owe moves no entry.
    expect(getDocOwner(d.id)).toMatchObject({ ownerId: TANDEM, kind: "default" });
  });

  it("nothing waiting: no wake, and an answered chat message is not re-owed", async () => {
    const d = mkDoc("d");
    setDocOwner(d.id, { ownerId: TANDEM, kind: "default" }, "presence");
    noteTandemRunStart();
    expect(wakes).toBe(0);
    expect(handed(await reader(TANDEM).poll())).toEqual([]);
  });
});

describe("take-back at a run start (ownership design §8.2)", () => {
  it("unowned and claimed documents go to Tandem's Claude as default; opened and assigned stay; the loser is owed nothing it was handed", async () => {
    present = false;
    const fileE = realFile("e.md");
    const e = await userOpen(fileE); // not present: unowned
    const free = mkDoc("free");
    const opened = mkDoc("opened");
    const assigned = mkDoc("assigned");
    setDocOwner(opened.id, { ownerId: A, kind: "opened" }, "take", A);
    setDocOwner(assigned.id, { ownerId: A, kind: "assigned" }, "take", A);
    const wrote = await as(A, "tandem_comment", { from: 0, to: 5, text: "x", documentId: e });
    expect(wrote.error, JSON.stringify(wrote)).toBe(false);
    expect(getDocOwner(e)).toMatchObject({ ownerId: A, kind: "claimed" });
    const ydocE = getOrCreateDocument(e);
    const c = userComment(ydocE, `${prefix}-ce`);
    const a = reader(A);
    expect(handed(await a.poll())).toContain(c);
    await a.poll();

    present = true;
    noteTandemRunStart();
    for (const id of [e, free.id]) {
      expect(getDocOwner(id), id).toMatchObject({ ownerId: TANDEM, kind: "default" });
    }
    expect(getDocOwner(opened.id)).toMatchObject({ ownerId: A, kind: "opened" });
    expect(getDocOwner(assigned.id)).toMatchObject({ ownerId: A, kind: "assigned" });
    expect(new Map(ownershipSnapshotForTests().losses).get(e)).toEqual({
      ownerId: A,
      cause: "taken back",
    });
    expect(wakes).toBe(1);
    expect(handed(await reader(TANDEM).poll())).toContain(c);

    // The terminal is told it was taken back, and may take it again.
    const inbox = await a.poll();
    expect(inbox.ownership?.notYours).toContain(e);
    expect(inbox.summary).toContain("Tandem's Claude took");
    expect(inbox.summary).toContain(
      "back from you, so an earlier request from the user does not count for it: call tandem_open on it only if the user asks you again after that.",
    );
    const write = await as(A, "tandem_comment", { from: 0, to: 5, text: "y", documentId: e });
    expect(write.details).toMatchObject({ reason: "lost", cause: "taken back" });
    const retake = await as(A, "tandem_open", { filePath: fileE });
    expect(retake.error, JSON.stringify(retake)).toBe(false);
    expect(getDocOwner(e)).toMatchObject({ ownerId: A, kind: "opened" });
  });

  it("a named poll of a document taken back says so", async () => {
    present = false;
    const e = await userOpen(realFile("e.md"));
    await as(A, "tandem_comment", { from: 0, to: 5, text: "x", documentId: e });
    present = true;
    noteTandemRunStart();
    const inbox = await pollAs(A, { documentId: e });
    expect(inbox.summary).toContain(
      "Tandem's Claude took this document back from you, so an earlier request from the user does not count",
    );
  });

  it("a busy document moves at its turn; a tandem_open queued ahead wins; the deferred move wakes for its work", async () => {
    present = false;
    const busy = mkDoc("busy");
    const raced = mkDoc("raced");
    present = true;
    const c = userComment(busy.ydoc, `${prefix}-cb`);
    const runningBusy = hold(busy.id);
    const runningRaced = hold(raced.id);
    const take = runDocOp(raced.id, () =>
      setDocOwner(raced.id, { ownerId: A, kind: "opened" }, "take", A),
    );
    noteTandemRunStart();
    expect(getDocOwner(busy.id)).toBeUndefined();
    expect(wakes).toBe(0);
    runningRaced.release();
    await runningRaced.done;
    await take;
    await new Promise((r) => setTimeout(r, 0));
    expect(getDocOwner(raced.id)).toMatchObject({ ownerId: A, kind: "opened" });
    runningBusy.release();
    await runningBusy.done;
    await new Promise((r) => setTimeout(r, 0));
    expect(getDocOwner(busy.id)).toMatchObject({ ownerId: TANDEM, kind: "default" });
    expect(wakes).toBe(1);
    expect(handed(await reader(TANDEM).poll())).toContain(c);
  });

  it("not present by its turn: a deferred take-back moves nothing", async () => {
    const busy = mkDoc("busy");
    const running = hold(busy.id);
    noteTandemRunStart();
    present = false;
    running.release();
    await running.done;
    await new Promise((r) => setTimeout(r, 0));
    expect(getDocOwner(busy.id)).toBeUndefined();
  });

  it("in Solo, a waiting comment does not wake; in Tandem it does", async () => {
    const d = mkDoc("d");
    setDocOwner(d.id, { ownerId: TANDEM, kind: "default" }, "presence");
    userComment(d.ydoc, `${prefix}-c`);
    setCtrlMode("solo");
    noteTandemRunStart();
    expect(wakes).toBe(0);
    setCtrlMode("tandem");
    noteTandemRunStart();
    expect(wakes).toBe(1);
  });
});

describe("the Solo-release check (ownership design §8.3)", () => {
  it("the release route forwards solo-release to start-or-wake once the room reads Tandem; not while it reads Solo", () => {
    const release = () => {
      const res = makeRes();
      handleModeRelease(
        {
          body: {},
          socket: { remoteAddress: "127.0.0.1" },
          headers: { origin: "http://127.0.0.1:5173" },
        } as never,
        res as never,
      );
      return res._status;
    };
    setCtrlMode("solo");
    expect(release()).toBe(409);
    expect(forwarded).toEqual([]);
    setCtrlMode("tandem");
    expect(release()).toBe(200);
    expect(forwarded).toEqual(["solo-release"]);
  });
});

describe("the end of presence: chat held by presence alone (ownership design §7.2; 3b-2b4c)", () => {
  it("doc-less and closed-document chat handed but unanswered is owed to the next owner's fresh reader; handled and carried-over are not", async () => {
    const carried = `${prefix}-co`;
    withInternal(ctrl(), () =>
      chatMap().set(carried, {
        id: carried,
        author: "user",
        text: "carried over",
        timestamp: clock++,
        read: true,
      }),
    );
    captureCarriedOverChat(() => [carried]);
    // Answered first: a reply settles the earlier messages of its batch.
    const answered = userChat(`${prefix}-h`);
    const docless = userChat(`${prefix}-m`);
    const onClosed = userChat(`${prefix}-cd`, `${prefix}-never-open`);
    const tandem = reader(TANDEM);
    expect(handed(await tandem.poll())).toEqual([docless, answered, onClosed].sort());
    await tandem.poll(); // acknowledged
    const reply = await as(TANDEM, "tandem_reply", { text: "done", replyTo: answered });
    expect(reply.error, JSON.stringify(reply)).toBe(false);
    // None of them has a per-message owner: Tandem's Claude held them by presence.
    expect(ownershipSnapshotForTests().messageOwners).toEqual([]);

    present = false;
    noteTandemPresence(false);
    expect(handed(await reader(A).poll())).toEqual([docless, onClosed].sort());
    expect(chatMap().get(answered)).toMatchObject({ read: true });
    expect(chatMap().get(carried)).toMatchObject({ read: true });
  });

  it("flag off: the end of presence marks nothing unread", async () => {
    await close?.();
    await buildWorld("");
    const k = `${prefix}-m`;
    withInternal(ctrl(), () =>
      chatMap().set(k, { id: k, author: "user", text: "x", timestamp: clock++, read: true }),
    );
    present = false;
    noteTandemPresence(false);
    expect(chatMap().get(k)).toMatchObject({ read: true });
    expect(ownershipSnapshotForTests().records).toEqual([]);
  });
});

describe("dark: flag off, everything wired", () => {
  it("a run start and a Solo release do nothing: no move, no wake, no forward, nothing created, no log", async () => {
    await close?.();
    await buildWorld("");
    const errSpy = vi.spyOn(console, "error");
    const d = mkDoc("d");
    userComment(d.ydoc, `${prefix}-c`);
    userChat(`${prefix}-m`);
    noteTandemRunStart();
    noteSoloReleased();
    expect(getDocOwner(d.id)).toBeUndefined();
    expect(wakes).toBe(0);
    expect(forwarded).toEqual([]);
    expect(ownershipSnapshotForTests().records).toEqual([]);
    expect(errSpy).not.toHaveBeenCalled();
    expect(chatMap().get(`${prefix}-m`)).toMatchObject({ read: false });
  });
});
