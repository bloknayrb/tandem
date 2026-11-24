/**
 * Waiting for Tandem's Claude, the chat half and the decision (#2358 PR
 * 3b-2b1b-chat; ownership design §8.5 as that PR's brief rules it, ADR-054's
 * 3b-2b1b-chat amendment), and claimable work (3b-2b1b-claimable, ADR-054's
 * amendment of that name). Ships dark: flag on for the whole file except the
 * dark case.
 *
 * `tandemWorkWaiting()` answers whether anything is waiting for Tandem's
 * Claude: a user comment or user thread reply on a document it holds (the
 * document half, #2464's `documentWaiting` through the waiting probe), or a
 * user chat message a FRESH cursor reader for Tandem's Claude would be handed
 * and own (Ruling K applied to chat); and, while no other session is
 * connected, the same on an open document nobody holds that it could claim,
 * and chat that follows one. **The agreement table is the judge**:
 * each row builds one world with exactly one candidate (a message, or an
 * annotation or reply), asks `tandemWorkWaiting()`, then polls through the
 * real `tandem_checkInbox` as a fresh reader for Tandem's Claude with no
 * `documentId`, and asserts that the poll hands exactly the candidate when
 * the decision is true and nothing when it is false, and that the decision is
 * the row's expected answer. The recorded differences assert both sides:
 * `poll-claims-F` and `another-session` (decision false while another session
 * is connected; the poll hands the candidate and claims F) and `not-present`
 * (decision true; a poll of a Tandem's Claude that is not present hands
 * nothing, and once present a new fresh poll hands it and claims F). Rows
 * marked `asA` poll as A instead (decision false; A is handed it and claims
 * F). Every agreeing "not" row ends with a positive anchor: a message on D,
 * which must read as waiting and be handed alone to a new fresh reader.
 *
 * The world is `ownership-waiting.test.ts`'s, with chat: Tandem's Claude is
 * present and holds D by its own comment (D opened through the user's route
 * before presence), a terminal A holds E, F is open and unowned, and a closed
 * id names no open document. A is registered with no stream ever, so it is
 * connected: rows 33 to 51, 54 and 55 lapse it first. The open-documents seam is wired
 * as `index.ts` wires it. The helpers are copied from
 * `ownership-waiting.test.ts` and `ownership-chat.test.ts`, whose worlds stay
 * put.
 *
 * Platform: real files under `os.tmpdir()` joined with `path.join`. Nothing
 * is gated.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { z } from "zod";
import { addUserReply } from "../../src/server/annotations/lifecycle.js";
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
import { CHAT_SCOPE, deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  type ChatRowsInput,
  chatRowsOwedToFreshReader,
} from "../../src/server/mcp/inbox-selection.js";
import {
  checkInboxOutputShape,
  checkInboxOwnershipShape,
} from "../../src/server/mcp/output-schemas.js";
import { handleClose } from "../../src/server/mcp/routes/close.js";
import { handleOpen } from "../../src/server/mcp/routes/open.js";
import { CLAUDE_DESKTOP_CLIENT_NAME } from "../../src/server/mcp/transport-registry.js";
import {
  __resetLocalPeriodForTests,
  __setHonourLocalPeriodRecordsForTests,
  loadLocalPeriodRecord,
} from "../../src/server/models/local-period.js";
import { runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  captureCarriedOverChat,
  DEFAULT_GRACE_MS,
  forgetChatMessageOwners,
  getDocOwner,
  LOCAL_OWNER_ID,
  noteTransportChanged,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  type RecordKind,
  resetOwnershipForTests,
  setDocOwner,
  setLossForTests,
  setOpenDocumentIdsSource,
  setOwnershipChatSide,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  setWakeObserverForTests,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
  tandemWorkWaiting,
} from "../../src/server/sessions/ownership.js";
import { getDocument, getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../src/shared/origins.js";
import type { ChatMessage } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { makeRes } from "../helpers/route-recorder.js";

const A = "claude:waiting-chat-a";
/** The second session's owner id for a record kind. */
const B = (kind: RecordKind) => `${kind}:waiting-chat-b`;
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
let frontId = "";
/** Whether presence is on, as the row's acts last set it. */
let present = false;
/** Releases F's held queue (`f-busy`); called by `afterEach`. */
let releaseF: (() => void) | undefined;

// ---------------------------------------------------------------------------
// Helpers copied from `ownership-waiting.test.ts`.

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 0 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

/** `register` with a kind, a client name and stream counters. */
function registerAs(
  ownerId: string,
  opts: { recordKind: RecordKind; clientName?: string; openStreams?: number; streamEver?: boolean },
): void {
  view.push({
    ownerId,
    openStreams: opts.openStreams ?? 0,
    ...(opts.streamEver !== undefined ? { streamEver: opts.streamEver } : {}),
  });
  noteTransportRegistered(ownerId, {
    recordKind: opts.recordKind,
    ...(opts.clientName !== undefined ? { clientName: opts.clientName } : {}),
  });
}

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
  // Unique content per world (the annotation store's rename recovery).
  fs.writeFileSync(filePath, `Hello world, this is test document ${filePath}.\n`);
  return filePath;
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
  };
}

/** Lapse `owner` through the grace (its transport removed). */
function lapseByGrace(owner: string): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  view = view.filter((e) => e.ownerId !== owner);
  noteTransportChanged(owner);
  vi.advanceTimersByTime(DEFAULT_GRACE_MS + 1);
  vi.useRealTimers();
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

/** A write by `owner` through `tandem_comment`: its claim of the document. Returns the annotation id. */
async function writeAs(owner: string, documentId: string): Promise<string> {
  const wrote = await as(owner, "tandem_comment", {
    from: 0,
    to: 5,
    text: "a note",
    documentId,
  });
  expect(wrote.error, JSON.stringify(wrote)).toBe(false);
  return wrote.data?.annotationId as string;
}

const annotations = (ydoc: Y.Doc) => ydoc.getMap(Y_MAP_ANNOTATIONS);

let clock = 1_000;

function userComment(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}): string {
  withBrowser(ydoc, () =>
    annotations(ydoc).set(id, {
      id,
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: `text of ${id}`,
      status: "pending",
      timestamp: clock++,
      rev: 1,
      ...extra,
    }),
  );
  return id;
}

/** A user reply through the browser's own entry (`addUserReply`). */
function userReply(ydoc: Y.Doc, parentId: string): string {
  const result = addUserReply(ydoc, parentId, `a reply on ${parentId}`, () => {});
  expect(result.kind, JSON.stringify(result)).toBe("ok");
  return (result as { replyId: string }).replyId;
}

// ---------------------------------------------------------------------------
// Helpers copied from `ownership-chat.test.ts`.

const key = (name: string) => `${prefix}-${name}`;
const ctrl = () => getOrCreateDocument(CTRL_ROOM);
const chatMap = () => ctrl().getMap(Y_MAP_CHAT);
const row = (k: string) => chatMap().get(k) as ChatMessage | undefined;

/** An unread user chat message under key `k`, about `documentId` if given (`extra` overrides). */
function userChat(k: string, documentId?: string, extra: Record<string, unknown> = {}): string {
  withInternal(ctrl(), () =>
    chatMap().set(k, {
      id: k,
      author: "user",
      text: `text of ${k}`,
      timestamp: clock++,
      read: false,
      ...(documentId !== undefined ? { documentId } : {}),
      ...extra,
    }),
  );
  return k;
}

function clearChat(): void {
  withInternal(ctrl(), () => {
    for (const k of [...chatMap().keys()]) chatMap().delete(k);
  });
}

const chatIds = (inbox: Inbox) => inbox.chatMessages.map((m) => String(m.id)).sort();

const messageOwner = (k: string) =>
  ownershipSnapshotForTests().messageOwners.find(([mk]) => mk === k)?.[1];

async function closeByRoute(id: string): Promise<void> {
  const res = makeRes();
  await handleClose(
    { body: { documentId: id }, socket: { remoteAddress: "127.0.0.1" }, headers: {} } as never,
    res as never,
  );
  expect(res._status, JSON.stringify(res._body)).toBe(200);
}

/** Every answerable id a poll hands: chat, comments and replies. */
const handed = (inbox: Inbox) => [
  ...chatIds(inbox),
  ...inbox.userActions.map((a) => String(a.id)),
  ...inbox.userReplies.map((r) => String(r.id)),
];

// ---------------------------------------------------------------------------
// The world.

async function buildWorld(flag: "1" | "" = "1"): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `wc${run}`;
  callingAs = A;
  resetInbox();
  resetOwnershipForTests();
  __resetLocalPeriodForTests();
  __setHonourLocalPeriodRecordsForTests(null);
  for (const [id, doc] of [...getOpenDocs()]) {
    unwatchFile(doc.filePath);
    removeDoc(id);
  }
  clearChat();
  view = [];
  setTransportView(() => view);
  register(A);
  // The lines of `src/server/index.ts`, the waiting probe included.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setOwnershipChatSide(ownershipChatSide);
  setChatRowsDeletedListener(forgetChatMessageOwners);
  setWaitingProbe(documentWaiting);
  setOpenDocumentIdsSource(() => getOpenDocs().keys());
  setCtrlMode("tandem");
  frontId = mkDoc("front").id;
  setActiveDocId(frontId);
  ({ client, close } = await setupMcpServer(
    [registerAwarenessTools, registerDocumentTools, registerAnnotationTools],
    { dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }) },
  ));
  await client.listTools();
}

beforeEach(async () => {
  // These suites judge the waiting rules on fake clocks; the restart
  // cutoff ("written since boot", #2358) has its own cases.
  setWaitingWrittenSinceForTests(undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-waiting-chat-"));
  await buildWorld();
});

afterEach(async () => {
  releaseF?.();
  releaseF = undefined;
  await close?.();
  close = undefined;
  vi.useRealTimers();
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
  __resetLocalPeriodForTests();
  __setHonourLocalPeriodRecordsForTests(null);
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface RowWorld {
  d: Doc;
  file: string;
  e: Doc;
  f: Doc;
  /** A valid chat document id that no open document carries. */
  closedId: string;
  /** The row's one candidate: a chat key, or an annotation or reply id. */
  candidate: string;
  /** One cursor reader of Tandem's Claude (`t-poll`, `t-poll-again`). */
  t: ReturnType<typeof reader>;
  /** What each `t-poll` / `t-poll-again` returned, in order. */
  tInboxes: Inbox[];
  a: ReturnType<typeof reader>;
}

/**
 * `ownership-waiting.test.ts`'s row world (D opened before presence, then
 * presence, then Tandem's Claude holding D by its own comment), plus E held
 * by A, F open and unowned, and a closed id.
 */
async function rowWorld(): Promise<RowWorld> {
  const file = realFile("d.md");
  const id = await userOpen(file);
  setActiveDocId(frontId);
  setTandemPresenceSource(() => true);
  present = true;
  const ydoc = getDocument(id) as Y.Doc;
  await writeAs(TANDEM, id);
  expect(getDocOwner(id)?.ownerId).toBe(TANDEM);
  const e = mkDoc("e");
  setDocOwner(e.id, { ownerId: A, kind: "opened" }, "take", A);
  expect(getDocOwner(e.id)?.ownerId).toBe(A);
  // Not a user open after presence: that would give F to Tandem's Claude.
  const f = mkDoc("f");
  expect(getDocOwner(f.id)).toBeUndefined();
  const closedId = `${prefix}-closed`;
  // Valid as a chat document id: row 22's premise test reads it back through
  // the chat side, so a drift of `chatDocumentOf`'s pattern cannot make row
  // 22 a doc-less row.
  expect(getOpenDocs().has(closedId)).toBe(false);
  return {
    d: { id, ydoc },
    file,
    e,
    f,
    closedId,
    candidate: "",
    t: reader(TANDEM),
    tInboxes: [],
    a: reader(A),
  };
}

// ---------------------------------------------------------------------------
// The agreement table.

type Candidate =
  | "doc-less"
  | "on-D"
  | "on-E"
  | "on-F"
  | "on-closed"
  | "malformed"
  | "comment-on-D"
  | "comment-on-E"
  | "comment-on-F"
  | "note-reply-on-D"
  | "note-reply-on-F";

type Act =
  | "candidate"
  | "t-poll"
  | "t-poll-again"
  | "t-legacy"
  | "a-poll"
  | "t-ack"
  | "t-final"
  | "raw-final"
  | "raw-progress"
  | "raw-agent"
  | "raw-settles"
  | "local"
  | "carry"
  | "a-lapse"
  | "take-a"
  | "close-d"
  | "reopen-d"
  | "presence-off"
  | "presence-on"
  | "solo"
  | "mode-unknown"
  | "b-desktop"
  | "b-desktop-http"
  | "b-desktop-claude"
  | "b-bridge"
  | "b-http"
  | "b-detached"
  | "b-lapsed"
  | "local-record"
  | "a-stream"
  | "f-busy"
  | "f-loss";

interface Row {
  name: string;
  candidate: Candidate;
  /** In order; `"candidate"` places the candidate's creation (first, if absent). */
  acts: readonly Act[];
  expected: "waiting" | "not";
  /**
   * A recorded difference. `"poll-claims-F"` (rows 26 and 30, their value
   * kept) and `"another-session"`: the decision is false because another
   * session is connected; Tandem's Claude's poll hands it and claims F.
   * `"not-present"`: the decision is true; the poll of a Tandem's Claude that
   * is not present hands nothing; then `presence-on`, and a new fresh poll
   * hands exactly it and claims F.
   */
  difference?: "poll-claims-F" | "another-session" | "not-present";
  /** Poll as A, not Tandem's Claude: the decision is false; A is handed exactly it and holds F. */
  asA?: boolean;
}

async function makeCandidate(w: RowWorld, c: Candidate): Promise<void> {
  const m = key("m");
  switch (c) {
    case "doc-less":
      w.candidate = userChat(m);
      return;
    case "on-D":
      w.candidate = userChat(m, w.d.id);
      return;
    case "on-E":
      w.candidate = userChat(m, w.e.id);
      return;
    case "on-F":
      w.candidate = userChat(m, w.f.id);
      return;
    case "on-closed":
      w.candidate = userChat(m, w.closedId);
      return;
    case "malformed":
      w.candidate = userChat(m, undefined, { text: 42 });
      return;
    case "comment-on-D":
      w.candidate = userComment(w.d.ydoc, key("c"));
      return;
    case "comment-on-E":
      w.candidate = userComment(w.e.ydoc, key("c"));
      return;
    case "comment-on-F":
      w.candidate = userComment(w.f.ydoc, key("c"));
      return;
    case "note-reply-on-D":
    case "note-reply-on-F": {
      const ydoc = c === "note-reply-on-D" ? w.d.ydoc : w.f.ydoc;
      const note = key("note");
      withBrowser(ydoc, () =>
        annotations(ydoc).set(note, {
          id: note,
          author: "user",
          type: "note",
          audience: "private",
          range: { from: 0, to: 5 },
          content: "my note",
          status: "pending",
          timestamp: clock++,
        }),
      );
      w.candidate = userReply(ydoc, note);
      return;
    }
  }
}

/** A Claude row written by the server with no `read` field (the raw acts). */
function rawClaudeRow(w: RowWorld, name: string, fields: Record<string, unknown>): void {
  const k = key(name);
  withInternal(ctrl(), () =>
    chatMap().set(k, {
      id: k,
      author: "claude",
      text: `raw ${name}`,
      timestamp: clock++,
      ...fields,
    }),
  );
  // The candidate stays unread, which no tool does.
  expect(row(w.candidate)?.read).toBe(false);
}

async function toolReply(w: RowWorld, inProgress: boolean): Promise<void> {
  const replied = await as(TANDEM, "tandem_reply", {
    text: "on it",
    replyTo: w.candidate,
    ...(inProgress ? { inProgress: true } : {}),
  });
  expect(replied.error, JSON.stringify(replied)).toBe(false);
}

async function runAct(w: RowWorld, act: Act, r: Row): Promise<void> {
  switch (act) {
    case "candidate":
      return makeCandidate(w, r.candidate);
    case "t-poll":
    case "t-poll-again":
      w.tInboxes.push(await w.t.poll());
      return;
    case "t-legacy":
      await pollAs(TANDEM);
      return;
    case "a-poll":
      await w.a.poll();
      return;
    case "t-ack":
      return toolReply(w, true);
    case "t-final":
      return toolReply(w, false);
    case "raw-final":
      return rawClaudeRow(w, "raw", { replyTo: w.candidate });
    case "raw-progress":
      return rawClaudeRow(w, "raw", { replyTo: w.candidate, inProgress: true });
    case "raw-agent":
      return rawClaudeRow(w, "raw", {
        replyTo: w.candidate,
        agentIdentity: { provider: "ollama", displayName: "Local" },
      });
    case "raw-settles":
      return rawClaudeRow(w, "raw", { settles: [w.candidate] });
    case "local":
      __setHonourLocalPeriodRecordsForTests(true);
      loadLocalPeriodRecord({ v: 1, open: false, owed: [], local: [w.candidate] });
      return;
    case "carry":
      // Constructed: production carries over read rows only.
      captureCarriedOverChat(() => [w.candidate]);
      return;
    case "a-lapse":
      lapseByGrace(A);
      // E, A's, goes by the default rule: to Tandem's Claude while present,
      // otherwise unowned (and then claimable, with nothing on it).
      expect(getDocOwner(w.e.id)?.ownerId).toBe(present ? TANDEM : undefined);
      return;
    case "take-a":
      expect(await openAs(A, w.file)).toBe(w.d.id);
      setActiveDocId(frontId);
      expect(getDocOwner(w.d.id)?.ownerId).toBe(A);
      return;
    case "close-d":
      await closeByRoute(w.d.id);
      expect(getOpenDocs().has(w.d.id)).toBe(false);
      return;
    case "reopen-d":
      expect(await userOpen(w.file)).toBe(w.d.id);
      setActiveDocId(frontId);
      return;
    case "presence-off":
      setTandemPresenceSource(() => false);
      present = false;
      return;
    case "presence-on":
      setTandemPresenceSource(() => true);
      present = true;
      return;
    case "solo":
      setCtrlMode("solo");
      return;
    case "mode-unknown":
      setCtrlMode(null);
      return;
    case "b-desktop":
      registerAs(B("bridge"), { recordKind: "bridge", clientName: CLAUDE_DESKTOP_CLIENT_NAME });
      return;
    case "b-desktop-http":
      registerAs(B("http"), { recordKind: "http", clientName: CLAUDE_DESKTOP_CLIENT_NAME });
      return;
    case "b-desktop-claude":
      // Desktop's name on a `claude` record, whose display kind is "terminal":
      // told apart by the name, never by the display kind.
      registerAs(B("claude"), { recordKind: "claude", clientName: CLAUDE_DESKTOP_CLIENT_NAME });
      return;
    case "b-bridge":
      registerAs(B("bridge"), { recordKind: "bridge", clientName: "claude-code" });
      return;
    case "b-http":
      // A header-less terminal: an `http` record with no client name.
      registerAs(B("http"), { recordKind: "http" });
      return;
    case "b-detached":
      register(B("claude"));
      view = view.filter((e) => e.ownerId !== B("claude"));
      noteTransportChanged(B("claude"));
      // The premise: detached, in its grace, not lapsed.
      expect(
        ownershipSnapshotForTests().records.find((r) => r.ownerId === B("claude")),
      ).toMatchObject({ lapsed: undefined, graceTimer: expect.anything() });
      return;
    case "b-lapsed":
      // As `lapseByGrace`, but the entry stays: lapsed and still registered.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      registerAs(B("claude"), { recordKind: "claude", openStreams: 0, streamEver: true });
      noteTransportChanged(B("claude"));
      vi.advanceTimersByTime(DEFAULT_GRACE_MS + 1);
      vi.useRealTimers();
      expect(
        ownershipSnapshotForTests().records.find((r) => r.ownerId === B("claude"))?.lapsed,
      ).toBe(true);
      return;
    case "local-record":
      noteTransportRegistered(LOCAL_OWNER_ID, { recordKind: "local" });
      return;
    case "a-stream": {
      const entry = view.find((e) => e.ownerId === A) as TransportViewEntry;
      entry.openStreams = 1;
      entry.streamEver = true;
      noteTransportChanged(A);
      return;
    }
    case "f-busy":
      void runDocOp(w.f.id, () => new Promise<void>((r) => (releaseF = r)));
      return;
    case "f-loss":
      setLossForTests(w.f.id, TANDEM, "taken");
      return;
  }
}

const ROWS: readonly Row[] = [
  // Doc-less, present
  { name: "1 never polled", candidate: "doc-less", acts: [], expected: "waiting" },
  {
    name: "2 t-poll, t-poll-again",
    candidate: "doc-less",
    acts: ["candidate", "t-poll", "t-poll-again"],
    expected: "not",
  },
  {
    name: "3 t-poll (delivered only)",
    candidate: "doc-less",
    acts: ["candidate", "t-poll"],
    expected: "waiting",
  },
  { name: "4 t-legacy", candidate: "doc-less", acts: ["candidate", "t-legacy"], expected: "not" },
  {
    name: "5 t-ack (read, no registry entry)",
    candidate: "doc-less",
    acts: ["candidate", "t-ack"],
    expected: "not",
  },
  { name: "6 t-final", candidate: "doc-less", acts: ["candidate", "t-final"], expected: "not" },
  {
    name: "7 raw-final (handled, unread)",
    candidate: "doc-less",
    acts: ["candidate", "raw-final"],
    expected: "not",
  },
  {
    name: "8 raw-settles (handled, unread)",
    candidate: "doc-less",
    acts: ["candidate", "raw-settles"],
    expected: "not",
  },
  {
    name: "9 raw-progress (handles nothing; covers only the non-superseded state)",
    candidate: "doc-less",
    acts: ["candidate", "raw-progress"],
    expected: "waiting",
  },
  {
    name: "10 raw-agent (handles nothing)",
    candidate: "doc-less",
    acts: ["candidate", "raw-agent"],
    expected: "waiting",
  },
  { name: "11 local", candidate: "doc-less", acts: ["candidate", "local"], expected: "not" },
  {
    name: "12 carry (constructed)",
    candidate: "doc-less",
    acts: ["candidate", "carry"],
    expected: "not",
  },
  { name: "13 a malformed row: text 42", candidate: "malformed", acts: [], expected: "not" },
  {
    name: "14 solo, then the message",
    candidate: "doc-less",
    acts: ["solo", "candidate"],
    expected: "waiting",
  },
  {
    name: "15 mode-unknown, then the message",
    candidate: "doc-less",
    acts: ["mode-unknown", "candidate"],
    expected: "waiting",
  },
  {
    name: "16 presence-off, then the message",
    candidate: "doc-less",
    acts: ["presence-off", "candidate"],
    expected: "not",
  },
  {
    name: "17 presence-off, the message, a-poll (A takes it per message), presence-on",
    candidate: "doc-less",
    acts: ["presence-off", "candidate", "a-poll", "presence-on"],
    expected: "not",
  },
  {
    name: "18 row 17, then a-lapse (released and re-owed)",
    candidate: "doc-less",
    acts: ["presence-off", "candidate", "a-poll", "presence-on", "a-lapse"],
    expected: "waiting",
  },
  // Following a document
  { name: "19 on D, never polled", candidate: "on-D", acts: [], expected: "waiting" },
  {
    name: "20 on D, t-poll, t-poll-again",
    candidate: "on-D",
    acts: ["candidate", "t-poll", "t-poll-again"],
    expected: "not",
  },
  { name: "21 on E", candidate: "on-E", acts: [], expected: "not" },
  { name: "22 on the closed id, present", candidate: "on-closed", acts: [], expected: "waiting" },
  {
    name: "23 on D, t-poll, t-poll-again, take-a, a-lapse (re-owed twice; handedByRecord keeps the key)",
    candidate: "on-D",
    acts: ["candidate", "t-poll", "t-poll-again", "take-a", "a-lapse"],
    expected: "waiting",
  },
  {
    name: "24 on D, close-d while Tandem's Claude holds D (per-message owner close)",
    candidate: "on-D",
    acts: ["candidate", "close-d"],
    expected: "waiting",
  },
  {
    name: "25 take-a, on D, close-d (A owns it per message), reopen-d",
    candidate: "on-D",
    acts: ["take-a", "candidate", "close-d", "reopen-d"],
    expected: "not",
  },
  {
    name: "26 on F, another session (A) is connected: difference, decision false; the poll hands it and claims F",
    candidate: "on-F",
    acts: [],
    expected: "not",
    difference: "poll-claims-F",
  },
  // The document half
  { name: "27 a user comment on D", candidate: "comment-on-D", acts: [], expected: "waiting" },
  { name: "28 a user comment on E", candidate: "comment-on-E", acts: [], expected: "not" },
  {
    name: "29 a private note on D with a user reply (ADR-027)",
    candidate: "note-reply-on-D",
    acts: [],
    expected: "not",
  },
  {
    name: "30 a user comment on F, another session (A) is connected: difference, decision false; the poll hands it and claims F",
    candidate: "comment-on-F",
    acts: [],
    expected: "not",
    difference: "poll-claims-F",
  },
  // Added
  {
    name: "31 row 24, then presence-off: the per-message Tandem owner survives",
    candidate: "on-D",
    acts: ["candidate", "close-d", "presence-off"],
    expected: "waiting",
  },
  {
    name: "32 on D, t-ack (follows D), take-a (re-owe: read false, acknowledgement superseded), a-lapse",
    candidate: "on-D",
    acts: ["candidate", "t-ack", "take-a", "a-lapse"],
    expected: "waiting",
  },
  // Claimable work (3b-2b1b-claimable): rows 33 to 51 lapse A first.
  { name: "33 on F", candidate: "on-F", acts: ["a-lapse", "candidate"], expected: "waiting" },
  {
    name: "34 a comment on F",
    candidate: "comment-on-F",
    acts: ["a-lapse", "candidate"],
    expected: "waiting",
  },
  {
    name: "35 a private note on F with a user reply (ADR-027)",
    candidate: "note-reply-on-F",
    acts: ["a-lapse", "candidate"],
    expected: "not",
  },
  {
    name: "36 a comment on F, b-desktop (Claude Desktop's name on a bridge)",
    candidate: "comment-on-F",
    acts: ["a-lapse", "candidate", "b-desktop"],
    expected: "waiting",
  },
  {
    name: "37 a comment on F, b-desktop-http (Claude Desktop's name on an http record)",
    candidate: "comment-on-F",
    acts: ["a-lapse", "candidate", "b-desktop-http"],
    expected: "waiting",
  },
  {
    name: "38 a comment on F, b-bridge: difference, another session",
    candidate: "comment-on-F",
    acts: ["a-lapse", "candidate", "b-bridge"],
    expected: "not",
    difference: "another-session",
  },
  {
    name: "39 on F, b-bridge: difference, another session",
    candidate: "on-F",
    acts: ["a-lapse", "candidate", "b-bridge"],
    expected: "not",
    difference: "another-session",
  },
  {
    name: "40 a comment on F, b-http (a header-less terminal): difference, another session",
    candidate: "comment-on-F",
    acts: ["a-lapse", "candidate", "b-http"],
    expected: "not",
    difference: "another-session",
  },
  {
    name: "41 a comment on F, b-detached (in its grace): difference, another session",
    candidate: "comment-on-F",
    acts: ["a-lapse", "candidate", "b-detached"],
    expected: "not",
    difference: "another-session",
  },
  {
    name: "42 on F, b-detached (in its grace): difference, another session",
    candidate: "on-F",
    acts: ["a-lapse", "candidate", "b-detached"],
    expected: "not",
    difference: "another-session",
  },
  {
    name: "43 a comment on F, b-lapsed (lapsed, still registered)",
    candidate: "comment-on-F",
    acts: ["a-lapse", "candidate", "b-lapsed"],
    expected: "waiting",
  },
  {
    name: "44 a comment on F, local-record (constructed: a stdio-mode record in an HTTP world; pins that local is built in)",
    candidate: "comment-on-F",
    acts: ["a-lapse", "candidate", "local-record"],
    expected: "waiting",
  },
  {
    name: "45 a comment on F, f-busy (F's queue busy within the bound)",
    candidate: "comment-on-F",
    acts: ["a-lapse", "candidate", "f-busy"],
    expected: "not",
  },
  {
    name: "46 a comment on F, f-loss (Tandem's Claude lost F)",
    candidate: "comment-on-F",
    acts: ["a-lapse", "candidate", "f-loss"],
    expected: "not",
  },
  {
    name: "47 a comment on F, solo",
    candidate: "comment-on-F",
    acts: ["a-lapse", "candidate", "solo"],
    expected: "not",
  },
  {
    name: "48 on F, solo (chat is never Solo-held)",
    candidate: "on-F",
    acts: ["a-lapse", "candidate", "solo"],
    expected: "waiting",
  },
  {
    name: "49 presence-off, a comment on F: difference, not present",
    candidate: "comment-on-F",
    acts: ["presence-off", "a-lapse", "candidate"],
    expected: "waiting",
    difference: "not-present",
  },
  {
    name: "50 presence-off, on F: difference, not present",
    candidate: "on-F",
    acts: ["presence-off", "a-lapse", "candidate"],
    expected: "waiting",
    difference: "not-present",
  },
  {
    name: "51 presence-off, a doc-less message (per message, not counted)",
    candidate: "doc-less",
    acts: ["presence-off", "a-lapse", "candidate"],
    expected: "not",
  },
  {
    name: "52 a comment on F, A connected (no stream ever): A is handed it and claims F",
    candidate: "comment-on-F",
    acts: ["candidate"],
    expected: "not",
    asA: true,
  },
  {
    name: "53 a-stream, a comment on F: A is handed it and claims F",
    candidate: "comment-on-F",
    acts: ["a-stream", "candidate"],
    expected: "not",
    asA: true,
  },
  // Review round 1 (#2486).
  {
    name: "54 on F, carried over (constructed), A gone: the claimable chat skips it too",
    candidate: "on-F",
    acts: ["a-lapse", "candidate", "carry"],
    expected: "not",
  },
  {
    name: "55 a comment on F, b-desktop-claude (Claude Desktop's name on a claude record)",
    candidate: "comment-on-F",
    acts: ["a-lapse", "candidate", "b-desktop-claude"],
    expected: "waiting",
  },
];

const ON_F: readonly Candidate[] = ["on-F", "comment-on-F", "note-reply-on-F"];

async function buildRow(r: Row): Promise<RowWorld> {
  clock = 1_000;
  const w = await rowWorld();
  const acts: readonly Act[] = r.acts.includes("candidate") ? r.acts : ["candidate", ...r.acts];
  for (const act of acts) await runAct(w, act, r);
  expect(w.candidate, "the row built its candidate").not.toBe("");
  return w;
}

/** `tandemWorkWaiting()` with every console method spied for that call only; asserts silence. */
function decide(): boolean {
  const spies = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
    vi.spyOn(console, m),
  );
  const before = spies.map((spy) => spy.mock.calls.length);
  const answer = tandemWorkWaiting();
  const during = spies.flatMap((spy, i) => spy.mock.calls.slice(before[i]));
  for (const spy of spies) spy.mockRestore();
  expect(during, "tandemWorkWaiting logged").toEqual([]);
  return answer;
}

const rowNamed = (n: number): Row => ROWS.find((r) => Number.parseInt(r.name, 10) === n) as Row;

describe("the agreement table: the decision answers as a fresh poll of Tandem's Claude would hand (rows 1 to 55)", () => {
  it("has all 55 rows, numbered in order", () => {
    expect(ROWS.map((r) => Number.parseInt(r.name, 10))).toEqual(
      Array.from({ length: 55 }, (_, i) => i + 1),
    );
    expect(ROWS.filter((r) => r.difference).map((r) => Number.parseInt(r.name, 10))).toEqual([
      26, 30, 38, 39, 40, 41, 42, 49, 50,
    ]);
    expect(ROWS.filter((r) => r.asA).map((r) => Number.parseInt(r.name, 10))).toEqual([52, 53]);
  });

  for (const r of ROWS) {
    it(r.name, async () => {
      const w = await buildRow(r);

      // Review round 1 (R1.5): where a row's world starts with a `t-poll`,
      // that first poll handed the candidate, and only it.
      if (r.acts.includes("t-poll")) {
        expect(handed(w.tInboxes[0] as Inbox), "the first t-poll").toEqual([w.candidate]);
      }

      const decision = decide();
      // The decision claims nothing.
      if (ON_F.includes(r.candidate)) {
        expect(getDocOwner(w.f.id), "F unowned after the decision").toBeUndefined();
      }
      expect(decision, "the decision").toBe(r.expected === "waiting");
      if (r.asA) {
        const inbox = await reader(A).poll();
        expect(handed(inbox), "A's fresh poll hands the candidate").toEqual([w.candidate]);
        expect(getDocOwner(w.f.id)?.ownerId, "and A claims F").toBe(A);
        return;
      }
      const inbox = await reader(TANDEM).poll();
      if (r.difference === undefined) {
        expect(handed(inbox), "the fresh poll hands the candidate iff waiting").toEqual(
          decision ? [w.candidate] : [],
        );
      } else if (r.difference === "not-present") {
        expect(handed(inbox), "not present: the fresh poll hands nothing").toEqual([]);
        setTandemPresenceSource(() => true);
        expect(handed(await reader(TANDEM).poll()), "present: a new fresh poll").toEqual([
          w.candidate,
        ]);
        expect(getDocOwner(w.f.id)?.ownerId, "and claims F").toBe(TANDEM);
      } else {
        expect(handed(inbox), "the fresh poll hands the candidate").toEqual([w.candidate]);
        expect(getDocOwner(w.f.id)?.ownerId, "and claims F").toBe(TANDEM);
      }

      // The anchor: the same world, given a message on D, reads as waiting,
      // and a new fresh reader is handed exactly that message.
      if (r.expected === "not" && r.difference === undefined) {
        const anchor = userChat(key("anchor"), w.d.id);
        expect(decide(), "waiting, with the anchor").toBe(true);
        expect(handed(await reader(TANDEM).poll()), "the anchor's fresh poll").toEqual([anchor]);
      }
    });
  }

  it("row 17 and 25's premise: A owns the message per message", async () => {
    for (const n of [17, 25]) {
      const w = await buildRow(rowNamed(n));
      expect(messageOwner(w.candidate)?.ownerId, `row ${n}`).toBe(A);
      await close?.();
      resetInbox();
      resetOwnershipForTests();
      await buildWorld();
    }
  });

  it("rows 24 and 31's premise: Tandem's Claude owns the message per message", async () => {
    for (const n of [24, 31]) {
      const w = await buildRow(rowNamed(n));
      expect(messageOwner(w.candidate)?.ownerId, `row ${n}`).toBe(TANDEM);
      await close?.();
      resetInbox();
      resetOwnershipForTests();
      await buildWorld();
    }
  });

  it("row 22's premise: the message names the closed id, as the chat side reads it", async () => {
    const w = await buildRow(rowNamed(22));
    expect(ownershipChatSide.message(w.candidate)).toEqual({
      documentId: w.closedId,
      documentOpen: false,
      localPeriod: false,
      // #2358 PR 5d: the row's arrival, for the published pickup and stall clock.
      timestamp: expect.any(Number),
      writtenThisRun: true,
    });
  });

  it("row 32's premise: the acknowledgement is superseded and the message unread", async () => {
    const w = await buildRow(rowNamed(32));
    expect(messageOwner(w.candidate)).toBeUndefined();
    const acks = [...chatMap().values()].filter(
      (v) => (v as ChatMessage).author === "claude" && (v as ChatMessage).replyTo === w.candidate,
    ) as ChatMessage[];
    expect(acks).toHaveLength(1);
    expect(acks[0]?.inProgress).toBe(true);
    expect(acks[0]?.superseded).toBe(true);
    expect(row(w.candidate)?.read).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The pure function alone.

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

describe("chatRowsOwedToFreshReader, the module alone", () => {
  const msg = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    author: "user",
    text: "t",
    timestamp: 1,
    read: false,
    ...extra,
  });
  const input = (rows: ChatRowsInput["rows"], over: Partial<ChatRowsInput> = {}): ChatRowsInput =>
    deepFreeze({
      rows,
      handled: new Set<string>(),
      isLocalPeriodChat: () => false,
      ...over,
    } as ChatRowsInput);
  const owed = (row: unknown, over: Partial<ChatRowsInput> = {}) => {
    const given = input([{ key: "k", row }], over);
    // `deepFreeze` does not stop `Set.add` (review round 1, R1.5): the handled
    // set is asserted unchanged instead.
    const size = given.handled.size;
    const keys = chatRowsOwedToFreshReader(given);
    expect(given.handled.size, "the handled set is not written").toBe(size);
    return keys;
  };

  it("keeps an unread, unhandled user row over deep-frozen inputs, in input order", () => {
    expect(owed(msg("k"))).toEqual(["k"]);
    expect(
      chatRowsOwedToFreshReader(
        input([
          { key: "b", row: msg("b") },
          { key: "a", row: msg("a", { documentId: "doc", anchor: undefined }) },
        ]),
      ),
    ).toEqual(["b", "a"]);
    // Fields `admitChatItem` drops when falsy are not checked.
    expect(owed(msg("k", { documentId: "", replyTo: "" }))).toEqual(["k"]);
    expect(owed(msg("k", { anchor: { from: 0, to: 1, textSnapshot: "H" }, replyTo: "x" }))).toEqual(
      ["k"],
    );
  });

  it("writtenSince (#2358, the restart row): a row written before it is not owed; at or after it, owed; unset, owed", () => {
    expect(owed(msg("k", { timestamp: 99 }), { writtenSince: 100 })).toEqual([]);
    expect(owed(msg("k", { timestamp: 100 }), { writtenSince: 100 })).toEqual(["k"]);
    expect(owed(msg("k", { timestamp: 99 }))).toEqual(["k"]);
  });

  it("refuses each exclusion once", () => {
    expect(owed(null)).toEqual([]);
    expect(owed("a string")).toEqual([]);
    expect(owed(msg("k", { author: "claude" }))).toEqual([]);
    expect(owed(msg("k", { author: undefined }))).toEqual([]);
    expect(owed(msg("k"), { handled: new Set(["k"]) })).toEqual([]);
    expect(owed(msg("k"), { isLocalPeriodChat: (k) => k === "k" })).toEqual([]);
    expect(owed(msg("k", { read: true }))).toEqual([]);
    // `!msg.read`, as the collector: any truthy value reads as read.
    expect(owed(msg("k", { read: "yes" }))).toEqual([]);
  });

  it("refuses an item the chat schema refuses, field by field", () => {
    expect(owed(msg("k", { text: 42 }))).toEqual([]);
    expect(owed(msg("k", { id: 7 }))).toEqual([]);
    expect(owed(msg("k", { timestamp: "now" }))).toEqual([]);
    expect(owed(msg("k", { documentId: 5 }))).toEqual([]);
    expect(owed(msg("k", { anchor: { from: "x", to: 1, textSnapshot: "H" } }))).toEqual([]);
    expect(owed(msg("k", { replyTo: 9 }))).toEqual([]);
  });

  it("logs nothing (a schema refusal included)", () => {
    const spies = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    expect(owed(msg("k", { text: 42 }))).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Total.

const DOCUMENT_HALF_FAILED =
  "[ownership] the document half of waiting could not be computed; it is read as nothing waiting.";
const CHAT_HALF_FAILED =
  "[ownership] the chat half of waiting could not be computed; it is read as nothing waiting.";

/** The one line `error` got, asserted fixed: no id and no error text. */
function expectOneLine(error: ReturnType<typeof vi.spyOn>, line: string, ids: string[]): void {
  expect(error.mock.calls).toEqual([[line]]);
  for (const id of ids) expect(line).not.toContain(id);
  expect(line).not.toContain("boom");
}

describe("tandemWorkWaiting is total: a throw in one half hides nothing in the other", () => {
  it("a chat half that throws: a waiting comment on D still answers true, through the document half", async () => {
    const w = await rowWorld();
    userComment(w.d.ydoc, key("c"));
    const owedToFreshReader = vi.fn((): readonly string[] => {
      throw new Error(`boom ${w.d.id}`);
    });
    setOwnershipChatSide({ ...ownershipChatSide, owedToFreshReader });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(tandemWorkWaiting()).toBe(true);
    // Both halves are asked: the chat half did throw, and logged its line.
    expect(owedToFreshReader).toHaveBeenCalledTimes(1);
    expectOneLine(error, CHAT_HALF_FAILED, [w.d.id]);
  });

  it("a chat half that throws, nothing on D: false, with one fixed line", async () => {
    const w = await rowWorld();
    const m = userChat(key("m"));
    setOwnershipChatSide({
      ...ownershipChatSide,
      owedToFreshReader: vi.fn((): readonly string[] => {
        throw new Error(`boom ${m}`);
      }),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(tandemWorkWaiting()).toBe(false);
    expectOneLine(error, CHAT_HALF_FAILED, [m, w.d.id]);
  });

  it("a probe that throws: waiting chat still answers true, with one fixed line", async () => {
    const w = await rowWorld();
    const m = userChat(key("m"));
    setWaitingProbe(() => {
      throw new Error(`boom ${w.d.id}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(tandemWorkWaiting()).toBe(true);
    expectOneLine(error, DOCUMENT_HALF_FAILED, [m, w.d.id]);
  });
});

// ---------------------------------------------------------------------------
// No write, judged by behaviour.

function listenerCounts(ydoc: Y.Doc): Record<string, number> {
  const observers = (ydoc as unknown as { _observers: Map<string, Set<unknown>> })._observers;
  const out: Record<string, number> = {};
  for (const [event, set] of observers) out[`doc:${event}`] = set.size;
  for (const name of [
    Y_MAP_ANNOTATIONS,
    Y_MAP_ANNOTATION_REPLIES,
    Y_MAP_USER_AWARENESS,
    Y_MAP_CHAT,
  ]) {
    const type = ydoc.share.get(name) as
      | { _eH: { l: unknown[] }; _dEH: { l: unknown[] } }
      | undefined;
    if (type) out[`${name}:observe`] = type._eH.l.length;
    if (type) out[`${name}:observeDeep`] = type._dEH.l.length;
  }
  return out;
}

/** What a call that writes nothing must leave equal (#2464's, extended to chat). */
function observable(w: RowWorld, counts: { d: number; ctrl: number }) {
  const scopes = [...deliveryRegistry.documentScopes(), CHAT_SCOPE].sort();
  return JSON.stringify({
    chat: chatMap().toJSON(),
    entries: scopes.map((scope) => [
      scope,
      deliveryRegistry.entriesIn(scope).map((e) => ({
        seq: e.seq,
        kind: e.kind,
        base: e.base,
        editedAt: e.editedAt,
        acked: e.acked,
        received: e.received,
      })),
    ]),
    counter: deliveryRegistry.counter,
    epoch: deliveryRegistry.epoch,
    ownership: ownershipSnapshotForTests(),
    updates: { ...counts },
    listeners: { d: listenerCounts(w.d.ydoc), ctrl: listenerCounts(ctrl()) },
  });
}

describe("no write, judged by behaviour", () => {
  async function chatWorld(): Promise<RowWorld> {
    const w = await rowWorld();
    userChat(key("legacy"));
    await pollAs(TANDEM); // handed cursor-less
    userChat(key("acked"));
    await w.t.poll();
    await w.t.poll(); // handed and acknowledged
    userChat(key("unacked"));
    await w.t.poll(); // handed, unacknowledged
    userChat(key("unhanded"));
    const local = userChat(key("local"));
    __setHonourLocalPeriodRecordsForTests(true);
    loadLocalPeriodRecord({ v: 1, open: false, owed: [], local: [local] });
    userComment(w.d.ydoc, key("c"));
    return w;
  }

  it("two consecutive calls leave the chat map, the registry, ownership and the listeners as they were, and log nothing", async () => {
    const w = await chatWorld();
    const counts = { d: 0, ctrl: 0 };
    w.d.ydoc.on("update", () => counts.d++);
    ctrl().on("update", () => counts.ctrl++);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const before = observable(w, counts);
    expect(tandemWorkWaiting()).toBe(true);
    const between = observable(w, counts);
    expect(tandemWorkWaiting()).toBe(true);
    const after = observable(w, counts);
    expect(between).toBe(before);
    expect(after).toBe(before);
    expect(counts).toEqual({ d: 0, ctrl: 0 });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("the chat half alone (no comment on D) also answers true and writes nothing", async () => {
    const w = await rowWorld();
    userChat(key("unhanded"));
    const counts = { d: 0, ctrl: 0 };
    w.d.ydoc.on("update", () => counts.d++);
    ctrl().on("update", () => counts.ctrl++);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const before = observable(w, counts);
    expect(tandemWorkWaiting()).toBe(true);
    expect(observable(w, counts)).toBe(before);
    expect(counts).toEqual({ d: 0, ctrl: 0 });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("anchor: in the same world, a cursor poll does emit a control-room update", async () => {
    await chatWorld();
    let ctrlUpdates = 0;
    ctrl().on("update", () => ctrlUpdates++);
    await reader(TANDEM).poll();
    expect(ctrlUpdates).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Dark.

describe("dark", () => {
  for (const flag of ["", "1"] as const) {
    it(`a waiting doc-less message seeded flag on, then the flag ${flag === "" ? "off: false, and neither the chat side nor the probe is asked" : "on (the twin): true"}`, async () => {
      await rowWorld();
      userChat(key("m"));
      const owedToFreshReader = vi.fn(() => ownershipChatSide.owedToFreshReader());
      setOwnershipChatSide({ ...ownershipChatSide, owedToFreshReader });
      const probe = vi.fn((documentId: string) => documentWaiting(documentId));
      setWaitingProbe(probe);
      vi.stubEnv("TANDEM_OWNERSHIP", flag);
      if (flag === "") {
        expect(tandemWorkWaiting()).toBe(false);
        expect(owedToFreshReader).not.toHaveBeenCalled();
        expect(probe).not.toHaveBeenCalled();
      } else {
        expect(tandemWorkWaiting()).toBe(true);
        expect(probe).toHaveBeenCalled();
        expect(owedToFreshReader).toHaveBeenCalledTimes(1);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Claimable work, beyond the table (#2358 PR 3b-2b1b-claimable).

const OPEN_DOCUMENTS_FAILED =
  "[ownership] the open documents could not be read for waiting; no unheld document is counted.";

describe("claimable work: the open-documents seam", () => {
  it("unwired (and after a reset that forgets a wired source), a comment and chat on F do not count; wired, they do", async () => {
    const w = await rowWorld();
    lapseByGrace(A);
    userComment(w.f.ydoc, key("c"));
    userChat(key("m"), w.f.id);
    // The anchor: wired as index.ts wires it, the claimable work counts.
    expect(decide()).toBe(true);
    // A reset forgets the source; everything else is wired again, the seam not.
    resetOwnershipForTests();
    setTransportView(() => view);
    setOwnershipSeqSource(() => deliveryRegistry.counter);
    setOwnershipInboxHandover(handOverDocumentInbox);
    setOwnershipChatSide(ownershipChatSide);
    setWaitingProbe(documentWaiting);
    setTandemPresenceSource(() => true);
    expect(getDocOwner(w.f.id)).toBeUndefined();
    expect(decide()).toBe(false);
    setOpenDocumentIdsSource(() => getOpenDocs().keys());
    expect(decide()).toBe(true);
  });

  for (const twin of ["a waiting comment on D", "owned doc-less chat"] as const) {
    it(`a throwing seam: ${twin} still answers true, with exactly one fixed line`, async () => {
      const w = await rowWorld();
      if (twin === "a waiting comment on D") userComment(w.d.ydoc, key("c"));
      else userChat(key("m"));
      setOpenDocumentIdsSource(() => {
        throw new Error(`boom ${w.f.id}`);
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(tandemWorkWaiting()).toBe(true);
      expectOneLine(error, OPEN_DOCUMENTS_FAILED, [w.d.id, w.f.id]);
    });
  }

  it("a probe that throws hides no claimable chat: chat on F, A gone, answers true with the document half's one line", async () => {
    const w = await rowWorld();
    lapseByGrace(A);
    userChat(key("m"), w.f.id);
    setWaitingProbe(() => {
      throw new Error(`boom ${w.f.id}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(tandemWorkWaiting()).toBe(true);
    expectOneLine(error, DOCUMENT_HALF_FAILED, [w.d.id, w.f.id]);
  });

  it("a lapsed record that holds a document (its grace re-armed) is still not connected", async () => {
    const w = await rowWorld();
    lapseByGrace(A);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    registerAs(B("claude"), { recordKind: "claude", openStreams: 0, streamEver: true });
    noteTransportChanged(B("claude"));
    vi.advanceTimersByTime(DEFAULT_GRACE_MS + 1);
    setDocOwner(frontId, { ownerId: B("claude"), kind: "opened" }, "take", B("claude"));
    noteTransportChanged(B("claude"));
    vi.useRealTimers();
    const b = ownershipSnapshotForTests().records.find((r) => r.ownerId === B("claude"));
    expect(b?.lapsed).toBe(true);
    // The premise: a grace is armed again, so "has a grace timer" would count it.
    expect(b?.graceTimer).toBeDefined();
    expect(getDocOwner(frontId)?.ownerId).toBe(B("claude"));
    userComment(w.f.ydoc, key("c"));
    expect(decide()).toBe(true);
  });

  it("writes nothing: after a-lapse, with a comment on F, two calls leave everything equal and F unowned", async () => {
    const w = await rowWorld();
    lapseByGrace(A);
    userComment(w.f.ydoc, key("c"));
    const counts = { d: 0, ctrl: 0 };
    w.d.ydoc.on("update", () => counts.d++);
    ctrl().on("update", () => counts.ctrl++);
    let fUpdates = 0;
    w.f.ydoc.on("update", () => fUpdates++);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const before = observable(w, counts);
    expect(tandemWorkWaiting()).toBe(true);
    const between = observable(w, counts);
    expect(tandemWorkWaiting()).toBe(true);
    expect(between).toBe(before);
    expect(observable(w, counts)).toBe(before);
    expect(counts).toEqual({ d: 0, ctrl: 0 });
    expect(fUpdates).toBe(0);
    expect(getDocOwner(w.f.id)).toBeUndefined();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("not present, a busy queue is not read (Accepted 5): a comment on F counts, and a present poll while F is busy hands nothing", async () => {
    const w = await rowWorld();
    setTandemPresenceSource(() => false);
    lapseByGrace(A);
    const c = userComment(w.f.ydoc, key("c"));
    void runDocOp(w.f.id, () => new Promise<void>((r) => (releaseF = r)));
    expect(decide()).toBe(true);
    expect(getDocOwner(w.f.id)).toBeUndefined();
    setTandemPresenceSource(() => true);
    expect(handed(await reader(TANDEM).poll())).toEqual([]);
    // The anchor: once F's queue is idle, a new fresh poll hands it.
    releaseF?.();
    releaseF = undefined;
    await new Promise((r) => setTimeout(r, 0));
    expect(handed(await reader(TANDEM).poll())).toEqual([c]);
  });

  it("not present, a loss is not read either (Accepted 5): a comment on F that Tandem's Claude lost counts, and a present poll hands nothing", async () => {
    const w = await rowWorld();
    setTandemPresenceSource(() => false);
    lapseByGrace(A);
    userComment(w.f.ydoc, key("c"));
    // Constructed: today no loss stands on an unowned document (`refusalFor`).
    setLossForTests(w.f.id, TANDEM, "taken");
    expect(decide()).toBe(true);
    expect(getDocOwner(w.f.id)).toBeUndefined();
    setTandemPresenceSource(() => true);
    expect(handed(await reader(TANDEM).poll())).toEqual([]);
    expect(getDocOwner(w.f.id)).toBeUndefined();
  });

  it("dark: the seam is never called", async () => {
    const w = await rowWorld();
    lapseByGrace(A);
    userComment(w.f.ydoc, key("c"));
    const seam = vi.fn(() => getOpenDocs().keys());
    setOpenDocumentIdsSource(seam);
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    expect(tandemWorkWaiting()).toBe(false);
    expect(seam).not.toHaveBeenCalled();
    // The twin: flag on, it is read and the comment counts.
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    expect(tandemWorkWaiting()).toBe(true);
    expect(seam).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Step 5 asks the chat that follows the document (#2358 PR
// 3b-2b1b-chat-step5). The world is #2464's row world without E and F:
// Tandem's Claude present and holding D by its own comment, so A's lapse
// moves only D. Wakes are watched with `setWakeObserverForTests`, and only a
// document's causes are counted (`messageOwnerChanged` reports
// "message-owner" too). The probe is the wired one, wrapped, so every case
// that expects a wake from the chat half also proves the probe answered
// false (S5's twin and the Solo anchor expect the probe's own wake).

const STEP5_CHAT_FAILED =
  "[ownership] the chat that follows a document could not be read at its change of owner; it is read as nothing waiting.";

interface StepWorld {
  id: string;
  file: string;
  ydoc: Y.Doc;
  probe: ReturnType<typeof vi.fn<(documentId: string, ownerId: string) => boolean>>;
  /** Document causes only. */
  wakes: string[];
  /** Every cause, "message-owner" included. */
  all: string[];
}

async function stepWorld(presence = true): Promise<StepWorld> {
  clock = 1_000;
  const file = realFile("d.md");
  const id = await userOpen(file);
  setActiveDocId(frontId);
  if (presence) {
    setTandemPresenceSource(() => true);
    await writeAs(TANDEM, id);
    expect(getDocOwner(id)?.ownerId).toBe(TANDEM);
  } else {
    expect(getDocOwner(id)).toBeUndefined();
  }
  const probe = vi.fn((documentId: string, _ownerId: string) => documentWaiting(documentId));
  setWaitingProbe(probe);
  const wakes: string[] = [];
  const all: string[] = [];
  setWakeObserverForTests((cause) => {
    all.push(cause);
    // "departure" is the lapse's re-ask (3b-2b2), not step 5's.
    if (cause !== "message-owner" && cause !== "departure") wakes.push(cause);
  });
  return { id, file, ydoc: getDocument(id) as Y.Doc, probe, wakes, all };
}

async function aTakesD(w: StepWorld): Promise<void> {
  expect(await openAs(A, w.file)).toBe(w.id);
  setActiveDocId(frontId);
  expect(getDocOwner(w.id)?.ownerId).toBe(A);
}

/** The probe was asked exactly once, with D and Tandem's Claude, and answered false. */
function probeAskedOnceFalse(w: StepWorld): void {
  expect(w.probe.mock.calls).toEqual([[w.id, TANDEM]]);
  expect(w.probe.mock.results.map((r) => r.value)).toEqual([false]);
}

/** The `[ownership]` lines `console.error` got. */
const ownershipLines = (error: { mock: { calls: unknown[][] } }): unknown[][] =>
  error.mock.calls.filter((c) => String(c[0]).startsWith("[ownership]"));

describe("step 5 asks the chat that follows the document (3b-2b1b-chat-step5)", () => {
  it("S1: A takes D, a user message on D, A lapses with presence: one lapse wake, and a fresh poll hands the message", async () => {
    const w = await stepWorld();
    await aTakesD(w);
    const m = userChat(key("m"), w.id);
    lapseByGrace(A);
    expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
    probeAskedOnceFalse(w);
    expect(w.wakes).toEqual(["lapse"]);
    expect(decide()).toBe(true);
    expect(handed(await reader(TANDEM).poll())).toEqual([m]);
  });

  it("S1's control: the same lapse with no message on D wakes nothing", async () => {
    const w = await stepWorld();
    await aTakesD(w);
    lapseByGrace(A);
    expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
    probeAskedOnceFalse(w);
    expect(w.wakes).toEqual([]);
  });

  it("S2, a guard (S2b is the positive arm): A owns the message per message (D closed while A held it); the user reopens D: the probe is asked once, no wake", async () => {
    const w = await stepWorld();
    await aTakesD(w);
    const m = userChat(key("m"), w.id);
    await closeByRoute(w.id);
    expect(messageOwner(m)?.ownerId).toBe(A);
    expect(await userOpen(w.file)).toBe(w.id);
    setActiveDocId(frontId);
    expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
    // Premise: still owed to a fresh reader, so only the owner filter stops it.
    expect(ownershipChatSide.owedToFreshReader()).toContain(m);
    probeAskedOnceFalse(w);
    expect(w.wakes).toEqual([]);
    expect(handed(await reader(TANDEM).poll()), "A's, not Tandem's Claude's").toEqual([]);
  });

  it("S2b, the per-message exclusion: Tandem's Claude owns the message per message; the reopen does not count it, tandemWorkWaiting does", async () => {
    const w = await stepWorld();
    const m = userChat(key("m"), w.id);
    await closeByRoute(w.id);
    expect(messageOwner(m)?.ownerId).toBe(TANDEM);
    expect(await userOpen(w.file)).toBe(w.id);
    setActiveDocId(frontId);
    expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
    probeAskedOnceFalse(w);
    expect(w.wakes).toEqual([]);
    // Not D's work, but Tandem's Claude's: the decision and a fresh poll have it.
    expect(decide()).toBe(true);
    expect(handed(await reader(TANDEM).poll())).toEqual([m]);
  });

  it("S3: S1 with a server-origin Claude final row naming the message (handled, unread): no wake", async () => {
    const w = await stepWorld();
    await aTakesD(w);
    const m = userChat(key("m"), w.id);
    const k = key("raw");
    withInternal(ctrl(), () =>
      chatMap().set(k, { id: k, author: "claude", text: "done", timestamp: clock++, replyTo: m }),
    );
    expect(ownershipChatSide.handledKeys().has(m)).toBe(true);
    expect(row(m)?.read).toBe(false);
    lapseByGrace(A);
    expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
    probeAskedOnceFalse(w);
    expect(w.wakes).toEqual([]);
    expect(handed(await reader(TANDEM).poll())).toEqual([]);
  });

  it("S4: S1 with the message as local-period chat: no wake", async () => {
    const w = await stepWorld();
    await aTakesD(w);
    const m = userChat(key("m"), w.id);
    __setHonourLocalPeriodRecordsForTests(true);
    loadLocalPeriodRecord({ v: 1, open: false, owed: [], local: [m] });
    expect(ownershipChatSide.message(m)?.localPeriod).toBe(true);
    lapseByGrace(A);
    expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
    probeAskedOnceFalse(w);
    expect(w.wakes).toEqual([]);
    expect(handed(await reader(TANDEM).poll())).toEqual([]);
  });

  it("S5: S1 with the chat side throwing: no wake, D is still Tandem's Claude's, one fixed line", async () => {
    const w = await stepWorld();
    await aTakesD(w);
    const m = userChat(key("m"), w.id);
    const owedToFreshReader = vi.fn((): readonly string[] => {
      throw new Error("x");
    });
    setOwnershipChatSide({ ...ownershipChatSide, owedToFreshReader });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    lapseByGrace(A);
    expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
    probeAskedOnceFalse(w);
    expect(owedToFreshReader).toHaveBeenCalledTimes(1);
    expect(w.wakes).toEqual([]);
    // Exactly the fixed line: not `total`'s, which carries the error text.
    expect(ownershipLines(error)).toEqual([[STEP5_CHAT_FAILED]]);
    expect(STEP5_CHAT_FAILED).not.toContain(w.id);
    expect(STEP5_CHAT_FAILED).not.toContain(m);
    // The rate limit (carried from #2485's review): a second throwing change
    // inside the minute asks the chat side again and writes no second line.
    setDocOwner(w.id, null, "stale");
    setDocOwner(w.id, { ownerId: TANDEM, kind: "default" }, "user-open");
    expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
    expect(owedToFreshReader).toHaveBeenCalledTimes(2);
    expect(w.wakes).toEqual([]);
    expect(ownershipLines(error)).toEqual([[STEP5_CHAT_FAILED]]);
  });

  it("S5b, carried-over chat (carried from #2485's review): S1 with the message carried over (constructed): no wake", async () => {
    // A composite that walked the chat side itself, rather than through
    // `tandemChatWaiting`, would count the carried-over key and wake.
    const w = await stepWorld();
    await aTakesD(w);
    const m = userChat(key("m"), w.id);
    // Constructed: production carries over read rows only.
    captureCarriedOverChat(() => [m]);
    expect(ownershipChatSide.owedToFreshReader()).toContain(m);
    lapseByGrace(A);
    expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
    probeAskedOnceFalse(w);
    expect(w.wakes).toEqual([]);
  });

  it("S5's twin: a probe answering true wakes, and the chat side is not asked", async () => {
    const w = await stepWorld();
    await aTakesD(w);
    userChat(key("m"), w.id);
    const owedToFreshReader = vi.fn((): readonly string[] => {
      throw new Error("x");
    });
    setOwnershipChatSide({ ...ownershipChatSide, owedToFreshReader });
    const probe = vi.fn((_documentId: string, _ownerId: string) => true);
    setWaitingProbe(probe);
    lapseByGrace(A);
    expect(probe.mock.calls).toEqual([[w.id, TANDEM]]);
    expect(owedToFreshReader).not.toHaveBeenCalled();
    expect(w.wakes).toEqual(["lapse"]);
  });

  it("a probe that throws at step 5 behaves as before: total's line, the chat side not asked, no wake, D still Tandem's Claude's", async () => {
    const w = await stepWorld();
    await aTakesD(w);
    userChat(key("m"), w.id);
    const owedToFreshReader = vi.fn(() => ownershipChatSide.owedToFreshReader());
    setOwnershipChatSide({ ...ownershipChatSide, owedToFreshReader });
    setWaitingProbe(() => {
      throw new Error(`boom ${w.id}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    lapseByGrace(A);
    expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
    expect(owedToFreshReader).not.toHaveBeenCalled();
    expect(w.wakes).toEqual([]);
    const lines = ownershipLines(error);
    expect(lines).toHaveLength(1);
    expect(String(lines[0]?.[0])).toMatch(/^\[ownership\] setDocOwner failed: /);
  });

  it("S6, the order case: a message on D handed to A and acknowledged (read), then A lapses: one lapse wake (the re-owe runs first)", async () => {
    const w = await stepWorld();
    await aTakesD(w);
    const m = userChat(key("m"), w.id);
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([m]);
    await a.poll(); // acknowledges
    expect(row(m)?.read).toBe(true);
    expect(messageOwner(m)).toBeUndefined();
    lapseByGrace(A);
    expect(row(m)?.read).toBe(false);
    probeAskedOnceFalse(w);
    expect(w.wakes).toEqual(["lapse"]);
    expect(handed(await reader(TANDEM).poll())).toEqual([m]);
  });

  describe("S7, the gates: A holds D with a waiting message on D", () => {
    async function gateWorld(): Promise<StepWorld> {
      const w = await stepWorld();
      await aTakesD(w);
      userChat(key("m"), w.id);
      return w;
    }

    it("take-back: no wake, and nothing is asked", async () => {
      const w = await gateWorld();
      setDocOwner(w.id, { ownerId: TANDEM, kind: "default" }, "take-back");
      expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
      expect(w.probe).not.toHaveBeenCalled();
      expect(w.wakes).toEqual([]);
    });

    it("poll-claim with Tandem's Claude as caller: no wake, and nothing is asked", async () => {
      const w = await gateWorld();
      setDocOwner(w.id, { ownerId: TANDEM, kind: "default" }, "poll-claim", TANDEM);
      expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
      expect(w.probe).not.toHaveBeenCalled();
      expect(w.wakes).toEqual([]);
    });

    it("the twin: the same change with cause user-open and no caller wakes once", async () => {
      const w = await gateWorld();
      setDocOwner(w.id, { ownerId: TANDEM, kind: "default" }, "user-open");
      probeAskedOnceFalse(w);
      expect(w.wakes).toEqual(["user-open"]);
    });
  });

  describe("the selector: only chat that names this document counts at its change", () => {
    it("a doc-less message (Tandem's Claude's by presence): no wake at D's change, while tandemWorkWaiting answers true", async () => {
      const w = await stepWorld();
      await aTakesD(w);
      const m = userChat(key("m"));
      lapseByGrace(A);
      expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
      probeAskedOnceFalse(w);
      expect(w.wakes).toEqual([]);
      expect(decide()).toBe(true);
      expect(handed(await reader(TANDEM).poll())).toEqual([m]);
    });

    it("a message on another open document G that Tandem's Claude holds: no wake at D's change, while tandemWorkWaiting answers true", async () => {
      const w = await stepWorld();
      const g = mkDoc("g");
      setDocOwner(g.id, { ownerId: TANDEM, kind: "opened" }, "take", TANDEM);
      expect(getDocOwner(g.id)?.ownerId).toBe(TANDEM);
      await aTakesD(w);
      const m = userChat(key("m"), g.id);
      lapseByGrace(A);
      expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
      probeAskedOnceFalse(w);
      expect(w.wakes).toEqual([]);
      expect(decide()).toBe(true);
      expect(handed(await reader(TANDEM).poll())).toEqual([m]);
    });

    it("a message on D: one wake (S1's shape)", async () => {
      const w = await stepWorld();
      await aTakesD(w);
      userChat(key("m"), w.id);
      lapseByGrace(A);
      probeAskedOnceFalse(w);
      expect(w.wakes).toEqual(["lapse"]);
    });
  });

  describe("before the first bind: Tandem's Claude is not present and holds nothing", () => {
    it("a user open of D gives it no owner, so step 5 is not reached: nothing is asked, no wake", async () => {
      const w = await stepWorld(false);
      // Who asked: since #2358 PR 5d the open's broadcast publishes the owner
      // fields, whose look at chat (`lookAtChat`, a document's chat waiting
      // time) reads the same member. Only step 5's asks count here.
      const askers: string[] = [];
      const owedToFreshReader = vi.fn(() => {
        askers.push(new Error().stack ?? "");
        return ownershipChatSide.owedToFreshReader();
      });
      setOwnershipChatSide({ ...ownershipChatSide, owedToFreshReader });
      userChat(key("docless"));
      userChat(key("m"), w.id);
      expect(await userOpen(w.file)).toBe(w.id);
      expect(getDocOwner(w.id)).toBeUndefined();
      expect(w.probe).not.toHaveBeenCalled();
      expect(askers.filter((stack) => !stack.includes("lookAtChat"))).toEqual([]);
      expect(w.all).toEqual([]);
    });

    it("constructed: D given to Tandem's Claude with no caller and no presence; a doc-less message alone does not wake", async () => {
      const w = await stepWorld(false);
      userChat(key("docless"));
      setDocOwner(w.id, { ownerId: TANDEM, kind: "default" }, "user-open");
      probeAskedOnceFalse(w);
      expect(w.wakes).toEqual([]);
    });

    it("constructed twin: with a message on D, one wake", async () => {
      const w = await stepWorld(false);
      userChat(key("docless"));
      userChat(key("m"), w.id);
      setDocOwner(w.id, { ownerId: TANDEM, kind: "default" }, "user-open");
      probeAskedOnceFalse(w);
      expect(w.wakes).toEqual(["user-open"]);
    });
  });

  describe("Solo: the probe keeps its hold, chat is not held", () => {
    it("a user comment on D, no chat: no wake", async () => {
      const w = await stepWorld();
      setCtrlMode("solo");
      await aTakesD(w);
      userComment(w.ydoc, key("c"));
      lapseByGrace(A);
      probeAskedOnceFalse(w);
      expect(w.wakes).toEqual([]);
    });

    it("a chat message on D, no comment: one wake", async () => {
      const w = await stepWorld();
      setCtrlMode("solo");
      await aTakesD(w);
      userChat(key("m"), w.id);
      lapseByGrace(A);
      probeAskedOnceFalse(w);
      expect(w.wakes).toEqual(["lapse"]);
    });

    it("anchor: the same comment in Tandem mode wakes, through the probe", async () => {
      const w = await stepWorld();
      await aTakesD(w);
      userComment(w.ydoc, key("c"));
      lapseByGrace(A);
      expect(w.probe.mock.results.map((r) => r.value)).toEqual([true]);
      expect(w.wakes).toEqual(["lapse"]);
    });
  });

  it("the lapse's order: A owns a message on D per message and holds D again; A lapses: no lapse wake, one message-owner wake, and a fresh poll hands it", async () => {
    const w = await stepWorld();
    await aTakesD(w);
    const m = userChat(key("m"), w.id);
    await closeByRoute(w.id);
    expect(messageOwner(m)?.ownerId).toBe(A);
    await aTakesD(w);
    expect(messageOwner(m)?.ownerId).toBe(A);
    w.all.length = 0;
    lapseByGrace(A);
    expect(getDocOwner(w.id)?.ownerId).toBe(TANDEM);
    probeAskedOnceFalse(w);
    expect(w.wakes).toEqual([]);
    // Then the lapse's re-ask (3b-2b2), after the release.
    expect(w.all).toEqual(["message-owner", "departure"]);
    expect(handed(await reader(TANDEM).poll())).toEqual([m]);
  });

  for (const flag of ["", "1"] as const) {
    it(`dark${flag === "" ? "" : ", the flag-on twin"}: a change to Tandem's Claude with a message on D, flag ${flag === "" ? "off: nothing is asked, no wake, the entry unmoved" : "on: one wake"}`, async () => {
      const w = await stepWorld();
      await aTakesD(w);
      userChat(key("m"), w.id);
      const owedToFreshReader = vi.fn(() => ownershipChatSide.owedToFreshReader());
      setOwnershipChatSide({ ...ownershipChatSide, owedToFreshReader });
      vi.stubEnv("TANDEM_OWNERSHIP", flag);
      setDocOwner(w.id, { ownerId: TANDEM, kind: "default" }, "user-open");
      vi.stubEnv("TANDEM_OWNERSHIP", "1");
      if (flag === "") {
        expect(w.probe).not.toHaveBeenCalled();
        expect(owedToFreshReader).not.toHaveBeenCalled();
        expect(w.all).toEqual([]);
        expect(getDocOwner(w.id)?.ownerId).toBe(A);
      } else {
        probeAskedOnceFalse(w);
        expect(owedToFreshReader).toHaveBeenCalledTimes(1);
        expect(w.wakes).toEqual(["user-open"]);
      }
    });
  }
});
