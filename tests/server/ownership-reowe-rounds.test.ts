/**
 * The rest of the owner (#2358 PR 3b-2b5, ADR-054): handover gap (d), where a
 * re-owe that wakes someone opens the delivery round of what it owed again,
 * and the reopen round, where a document closed and reopened by the user
 * with items owed opens its round again (ownership design §6.3, §6.7, §8.6).
 * The failed-bind wake, which needs a real supervisor, is in
 * `tests/server/launcher/supervisor-presence.test.ts`. Ships dark: flag on
 * for the whole file except the dark case.
 *
 * The world is `ownership-take-back.test.ts`'s: the real `tandem_checkInbox`
 * with the seams `src/server/index.ts` wires (the inbox handover, the chat
 * side, the waiting probe, the open documents), plus the keyed delivery-round
 * seam and the round opener (`openRoundsForOwedWork`, as `index.ts` wires
 * it), one external consumer attached, a counting frame sink and a recording
 * start-or-wake sink. Terminals A and B, and Tandem's Claude present only
 * where a case says so.
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
import {
  getDeliveryState,
  keyedDeliveryRoundsForTests,
  setDeliveryRoundSeam,
} from "../../src/server/events/delivery-state.js";
import {
  getSubscriberCount,
  openRoundsForOwedWork,
  resetForTesting as resetEventsForTesting,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
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
import { handleClose } from "../../src/server/mcp/routes/close.js";
import { handleOpen } from "../../src/server/mcp/routes/open.js";
import { runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  DEFAULT_GRACE_MS,
  forgetChatMessageOwners,
  getDocOwner,
  keyedDeliveryRounds,
  noteTandemPresence,
  noteTandemRunStart,
  noteTransportChanged,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDeliveryRoundOpener,
  setDocOwner,
  setOpenDocumentIdsSource,
  setOwnershipChatSide,
  setOwnershipFrameSink,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setRequestWakeSink,
  setStartOrWakeSink,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_ANNOTATIONS, Y_MAP_CHAT } from "../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { makeRes } from "../helpers/route-recorder.js";

const A = "claude:reowe-rounds-a";
const B = "claude:reowe-rounds-b";
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
let present = false;
let wakes = 0;
let frames = 0;
let forwarded: string[] = [];
let clock = 1_000;
const extCb = () => {};

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

async function userClose(documentId: string): Promise<void> {
  const res = makeRes();
  await handleClose(
    { body: { documentId }, socket: { remoteAddress: "127.0.0.1" }, headers: {} } as never,
    res as never,
  );
  expect(res._status, JSON.stringify(res._body)).toBe(200);
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

/** The open keyed rounds, as `kind:id`. */
const rounds = () =>
  keyedDeliveryRoundsForTests()
    .map((r) => `${r.kind}:${r.id ?? ""}`)
    .sort();
const health = () => getDeliveryState(Date.now(), getSubscriberCount());

function register(owner: string): void {
  view.push({ ownerId: owner, openStreams: 1 });
  noteTransportRegistered(owner, { recordKind: "claude" });
}

/** `owner`'s transport goes; its grace (the real default, on fake timers) lapses it. */
function lapseByGrace(owner: string): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    view = view.filter((e) => e.ownerId !== owner);
    noteTransportChanged(owner);
    vi.advanceTimersByTime(DEFAULT_GRACE_MS + 1);
  } finally {
    vi.useRealTimers();
  }
}

/** A claims `d` by a poll and acknowledges what it was handed: no round is left open. */
async function handedAndAcknowledgedBy(owner: string, expected: string[]): Promise<void> {
  const r = reader(owner);
  expect(handed(await r.poll())).toEqual([...expected].sort());
  await r.poll();
}

async function buildWorld(flag: "1" | "" = "1"): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `rr${run}`;
  callingAs = A;
  present = false;
  wakes = 0;
  frames = 0;
  forwarded = [];
  resetEventsForTesting();
  resetInbox();
  resetOwnershipForTests();
  for (const [id, doc] of [...getOpenDocs()]) {
    unwatchFile(doc.filePath);
    removeDoc(id);
  }
  clearChat();
  view = [];
  setTransportView(() => view);
  register(A);
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
  setOwnershipFrameSink(() => {
    frames += 1;
  });
  setDeliveryRoundSeam({
    keyed: keyedDeliveryRounds,
    isDocumentOpen: (documentId) => getOpenDocs().has(documentId),
  });
  setDeliveryRoundOpener(openRoundsForOwedWork);
  subscribe(extCb, "external");
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-reowe-rounds-"));
  await buildWorld();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setWaitingProbe(() => false);
  setChatRowsDeletedListener(undefined);
  setDeliveryRoundSeam(undefined);
  unsubscribe(extCb);
  for (const [id, doc] of [...getOpenDocs()]) {
    unwatchFile(doc.filePath);
    removeDoc(id);
  }
  clearChat();
  resetOwnershipForTests();
  resetInbox();
  resetEventsForTesting();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("handover gap (d): a re-owe that wakes someone opens the round of what it owed again", () => {
  it("a lapse to unowned with a handed, acknowledged comment: the frame goes out, the document's round opens, and the next reader's poll closes it", async () => {
    const d = mkDoc("d");
    const c = userComment(d.ydoc, `${prefix}-c`);
    await handedAndAcknowledgedBy(A, [c]);
    expect(getDocOwner(d.id)).toMatchObject({ ownerId: A, kind: "claimed" });
    expect(rounds()).toEqual([]);
    expect(health().state).not.toBe("awaiting-poll");

    lapseByGrace(A);
    expect(getDocOwner(d.id)).toBeUndefined();
    expect(frames).toBe(1);
    expect(rounds()).toEqual([`document:${d.id}`]);
    expect(health().state).toBe("awaiting-poll");

    register(B);
    expect(handed(await reader(B).poll())).toEqual([c]);
    expect(rounds()).toEqual([]);
    expect(health().state).toBe("polled");
  });

  it("a lapse to a present Tandem's Claude with no other session: the forward goes out and the document's round opens", async () => {
    const d = mkDoc("d");
    const c = userComment(d.ydoc, `${prefix}-c`);
    await handedAndAcknowledgedBy(A, [c]);
    present = true;

    lapseByGrace(A);
    expect(getDocOwner(d.id)).toMatchObject({ ownerId: TANDEM, kind: "default" });
    expect(forwarded).toContain("document");
    expect(rounds()).toEqual([`document:${d.id}`]);
    expect(handed(await reader(TANDEM).poll())).toEqual([c]);
    expect(rounds()).toEqual([]);
  });

  it("negative (anchor: the row above): with another session connected the lapse forwards nothing and opens no round", async () => {
    const d = mkDoc("d");
    const c = userComment(d.ydoc, `${prefix}-c`);
    await handedAndAcknowledgedBy(A, [c]);
    register(B);
    present = true;

    lapseByGrace(A);
    expect(getDocOwner(d.id)).toMatchObject({ ownerId: TANDEM, kind: "default" });
    expect(forwarded).toEqual([]);
    expect(rounds()).toEqual([]);
  });

  it("negative (anchor: the first row): a handover with nothing owed sends no frame and opens no round", async () => {
    const d = mkDoc("d");
    const c = userComment(d.ydoc, `${prefix}-c`);
    await handedAndAcknowledgedBy(A, [c]);
    // Removed by the user: nothing is owed after the handover.
    withBrowser(d.ydoc, () => d.ydoc.getMap(Y_MAP_ANNOTATIONS).delete(c));

    lapseByGrace(A);
    expect(getDocOwner(d.id)).toBeUndefined();
    expect(frames).toBe(0);
    expect(rounds()).toEqual([]);
  });

  it("chat that follows the document, handed and acknowledged, is re-owed by the lapse: its message round opens", async () => {
    const d = mkDoc("d");
    const c = userComment(d.ydoc, `${prefix}-c`);
    const m = userChat(`${prefix}-m`, d.id);
    await handedAndAcknowledgedBy(A, [c, m]);
    expect(rounds()).toEqual([]);

    lapseByGrace(A);
    expect(frames).toBe(1);
    expect(rounds()).toEqual([`document:${d.id}`, `message:${m}`].sort());
    register(B);
    expect(handed(await reader(B).poll())).toEqual([c, m].sort());
    expect(rounds()).toEqual([]);
  });

  it("a release of per-message owners: a doc-less message A owned per message opens its round when the lapse frames it", async () => {
    const m = userChat(`${prefix}-m`);
    await handedAndAcknowledgedBy(A, [m]);
    expect(new Map(ownershipSnapshotForTests().messageOwners).get(m)).toMatchObject({
      ownerId: A,
    });
    expect(rounds()).toEqual([]);

    lapseByGrace(A);
    expect(frames).toBe(1);
    expect(rounds()).toEqual([`message:${m}`]);
  });

  it("a lapsed holder's close, its move deferred behind a running operation: the re-owed chat that followed the document is framed and its message round opens", async () => {
    const d = mkDoc("d");
    const m = userChat(`${prefix}-m`, d.id);
    await handedAndAcknowledgedBy(A, [m]);
    let release!: () => void;
    const op = runDocOp(d.id, () => new Promise<void>((r) => (release = r)));
    lapseByGrace(A);
    // The move waits on d's queue, so A still holds it when the tab closes.
    expect(getDocOwner(d.id)).toMatchObject({ ownerId: A });
    expect(rounds()).toEqual([]);
    frames = 0;

    await userClose(d.id);
    expect(frames).toBe(1);
    expect(rounds()).toEqual([`message:${m}`]);
    register(B);
    expect(handed(await reader(B).poll())).toEqual([m]);
    expect(rounds()).toEqual([]);
    release();
    await op;
  });

  it("the run start's self re-owe wakes Tandem's Claude and opens the rounds of the held document and the chat it owed again", async () => {
    present = true;
    const d = mkDoc("d");
    setDocOwner(d.id, { ownerId: TANDEM, kind: "default" }, "presence");
    const c = userComment(d.ydoc, `${prefix}-c`);
    const m = userChat(`${prefix}-m`);
    await handedAndAcknowledgedBy(TANDEM, [c, m]);
    expect(rounds()).toEqual([]);

    noteTandemRunStart();
    expect(wakes).toBe(1);
    expect(rounds()).toEqual([`document:${d.id}`, `message:${m}`].sort());
    expect(handed(await reader(TANDEM).poll())).toEqual([c, m].sort());
    expect(rounds()).toEqual([]);
  });

  it("negative (anchor: the row above): a run start with nothing owed neither wakes nor opens a round", async () => {
    present = true;
    const d = mkDoc("d");
    setDocOwner(d.id, { ownerId: TANDEM, kind: "default" }, "presence");
    noteTandemRunStart();
    expect(wakes).toBe(0);
    expect(rounds()).toEqual([]);
  });

  it("the end of presence: a held document goes unowned with its handed item, the frame goes out and its round opens", async () => {
    present = true;
    const d = mkDoc("d");
    setDocOwner(d.id, { ownerId: TANDEM, kind: "default" }, "presence");
    const c = userComment(d.ydoc, `${prefix}-c`);
    await handedAndAcknowledgedBy(TANDEM, [c]);
    present = false;
    noteTandemPresence(false);
    expect(getDocOwner(d.id)).toBeUndefined();
    expect(frames).toBe(1);
    expect(rounds()).toEqual([`document:${d.id}`]);
  });

  it("no external consumer attached: the round opens abandoned, so /health reads consumer-detached, then awaiting-poll once one attaches", async () => {
    const d = mkDoc("d");
    const c = userComment(d.ydoc, `${prefix}-c`);
    await handedAndAcknowledgedBy(A, [c]);
    unsubscribe(extCb);
    lapseByGrace(A);
    expect(keyedDeliveryRoundsForTests()).toMatchObject([
      { kind: "document", id: d.id, abandoned: true },
    ]);
    expect(health().state).toBe("consumer-detached");
    subscribe(extCb, "external");
    expect(health().state).toBe("awaiting-poll");
  });
});

describe("the reopen round", () => {
  it("a document closed with a handed comment and reopened by the user opens its round again, and wakes nobody", async () => {
    const filePath = realFile("e.md");
    const e = await userOpen(filePath);
    const c = userComment(getOrCreateDocument(e), `${prefix}-c`);
    await handedAndAcknowledgedBy(A, [c]);
    await userClose(e);
    expect(rounds()).toEqual([]);
    frames = 0;

    const again = await userOpen(filePath);
    expect(again).toBe(e);
    expect(rounds()).toEqual([`document:${e}`]);
    expect(frames).toBe(0);
    expect(forwarded).toEqual([]);
    expect(wakes).toBe(0);
    expect(handed(await reader(A).poll())).toEqual([c]);
    expect(rounds()).toEqual([]);
  });

  it("the same with Tandem's Claude present: the user-open default gives it the document and its round opens; nobody is woken", async () => {
    const filePath = realFile("e.md");
    const e = await userOpen(filePath);
    const c = userComment(getOrCreateDocument(e), `${prefix}-c`);
    await handedAndAcknowledgedBy(A, [c]);
    await userClose(e);
    present = true;
    frames = 0;

    expect(await userOpen(filePath)).toBe(e);
    expect(getDocOwner(e)).toMatchObject({ ownerId: TANDEM, kind: "default" });
    expect(rounds()).toEqual([`document:${e}`]);
    expect(frames + wakes + forwarded.length).toBe(0);
  });

  it("a terminal's tandem_open of the closed document reopens it: its round opens, and its own poll closes it", async () => {
    const filePath = realFile("e.md");
    const e = await userOpen(filePath);
    const c = userComment(getOrCreateDocument(e), `${prefix}-c`);
    await handedAndAcknowledgedBy(A, [c]);
    await userClose(e);
    register(B);

    callingAs = B;
    const opened = parseResult(
      await client.callTool({ name: "tandem_open", arguments: { filePath } }),
    ) as { error: boolean; data?: { documentId?: string } };
    expect(opened.error, JSON.stringify(opened)).toBe(false);
    expect(opened.data?.documentId).toBe(e);
    expect(getDocOwner(e)).toMatchObject({ ownerId: B, kind: "opened" });
    expect(rounds()).toEqual([`document:${e}`]);
    expect(handed(await reader(B).poll())).toEqual([c]);
    expect(rounds()).toEqual([]);
  });

  it("negative (anchor: the row above): a first open with an item waiting opens no round", async () => {
    const filePath = realFile("e.md");
    const e = await userOpen(filePath);
    userComment(getOrCreateDocument(e), `${prefix}-c`);
    // Opened again while open: not a reopen.
    expect(await userOpen(filePath)).toBe(e);
    expect(rounds()).toEqual([]);
  });

  it("negative (anchor: the first row): a reopen with nothing owed opens no round", async () => {
    const filePath = realFile("e.md");
    const e = await userOpen(filePath);
    await userClose(e);
    expect(await userOpen(filePath)).toBe(e);
    expect(rounds()).toEqual([]);
  });
});

describe("dark: flag off, everything wired", () => {
  it("a handover, a close and reopen and a run start open no round, wake nobody and log nothing", async () => {
    await close?.();
    await buildWorld("");
    const errSpy = vi.spyOn(console, "error");
    const filePath = realFile("e.md");
    const e = await userOpen(filePath);
    const c = userComment(getOrCreateDocument(e), `${prefix}-c`);
    const r = reader(A);
    expect(handed(await r.poll())).toEqual([c]);
    await r.poll();
    setDocOwner(e, null, "lapse");
    await userClose(e);
    await userOpen(filePath);
    noteTandemRunStart();
    noteTandemPresence(false);
    expect(keyedDeliveryRoundsForTests()).toEqual([]);
    expect(frames + wakes + forwarded.length).toBe(0);
    expect(ownershipSnapshotForTests().records).toEqual([]);
    // The file watcher's own lines are master's; nothing else is logged.
    const lines = errSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((l) => !l.startsWith("[FileWatcher]"))).toEqual([]);
  });
});
