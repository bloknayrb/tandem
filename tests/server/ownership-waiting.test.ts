/**
 * Waiting on a document for Tandem's Claude (#2358 PR 3b-2b1b; ownership
 * design §8.5 as that PR's brief rules it, ADR-054's 3b-2b1b amendment).
 * Ships dark: flag on for the whole file except the dark characterization.
 *
 * `documentWaiting(D)` answers whether D holds a user comment or user thread
 * reply that a FRESH cursor reader for Tandem's Claude (cursor `"start"`)
 * polling D now would be handed (Ruling K). It is a separate pure function
 * (`inbox-selection.ts`), so **the agreement table is the judge**: each row
 * builds one world with exactly one candidate item, asks `documentWaiting(D)`,
 * then polls D through the real `tandem_checkInbox` as a fresh reader for
 * Tandem's Claude, and asserts that the poll hands the candidate if and only
 * if waiting answered true, and that this is the row's expected answer. Rows
 * 41 to 43 are the recorded differences and assert both sides.
 *
 * The world is `ownership-chat.test.ts`'s, pared: registered terminals, the
 * real MCP tools through an in-memory client, and the seams `index.ts` wires
 * (sequence source, inbox handover, chat side). Tandem's Claude is present
 * (`setTandemPresenceSource(() => true)`) and holds D by its own
 * `tandem_comment`, made before the row's item exists (an empty poll claims
 * nothing). D is a real file opened through the user's route, so a
 * terminal's `tandem_open` can take it.
 *
 * Platform: real files under `os.tmpdir()` joined with `path.join`. Nothing
 * is gated.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
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
  setInboxResponseCorruptorForTests,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { YDocStore } from "../../src/server/mcp/document-store.js";
import { CHAT_SCOPE, deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  type DocumentWaitingInput,
  isDocumentWaiting,
} from "../../src/server/mcp/inbox-selection.js";
import {
  checkInboxOutputShape,
  checkInboxOwnershipShape,
} from "../../src/server/mcp/output-schemas.js";
import { handleOpen } from "../../src/server/mcp/routes/open.js";
import {
  __resetLocalPeriodForTests,
  __setHonourLocalPeriodRecordsForTests,
} from "../../src/server/models/local-period.js";
import {
  DEFAULT_GRACE_MS,
  forgetChatMessageOwners,
  getDocOwner,
  getOwnerRecord,
  noteTransportChanged,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setOwnershipChatSide,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
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
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { makeRes } from "../helpers/route-recorder.js";

const A = "claude:waiting-a";
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

// ---------------------------------------------------------------------------
// Helpers, copied from `ownership-chat.test.ts` (whose world stays put) and pared.

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 0 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
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
  // Unique content per world: the annotation store's rename recovery adopts a
  // vanished file's annotations for a new path with the same content, which
  // would carry an earlier row's records into this one.
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

/**
 * A fresh poll whose response skips the SDK client's own output-schema check
 * (`client.request` rather than `callTool`). Row 33 only: see that row.
 */
async function rawFreshPoll(owner: string, documentId: string): Promise<Inbox> {
  callingAs = owner;
  const result = await client.request(
    {
      method: "tools/call",
      params: { name: "tandem_checkInbox", arguments: { cursor: "start", documentId } },
    },
    CallToolResultSchema,
  );
  expect(parseResult(result).error, JSON.stringify(result)).toBe(false);
  return inboxSchema.parse(result.structuredContent);
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
async function writeAs(
  owner: string,
  documentId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const wrote = await as(owner, "tandem_comment", {
    from: 0,
    to: 5,
    text: "a note",
    documentId,
    ...extra,
  });
  expect(wrote.error, JSON.stringify(wrote)).toBe(false);
  return wrote.data?.annotationId as string;
}

const annotations = (ydoc: Y.Doc) => ydoc.getMap(Y_MAP_ANNOTATIONS);
const replies = (ydoc: Y.Doc) => ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

let clock = 1_000;

/** A record written as the browser writes one. */
function putRecord(ydoc: Y.Doc, record: Record<string, unknown>): void {
  withBrowser(ydoc, () => annotations(ydoc).set(record.id as string, record));
}

/** Merge `fields` into the stored record `id`, as a browser edit does. */
function patchRecord(ydoc: Y.Doc, id: string, fields: Record<string, unknown>): void {
  const current = annotations(ydoc).get(id) as Record<string, unknown>;
  expect(current, `record ${id}`).toBeDefined();
  withBrowser(ydoc, () => annotations(ydoc).set(id, { ...current, ...fields }));
}

function userComment(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}): string {
  putRecord(ydoc, {
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
  });
  return id;
}

/** A user reply through the browser's own entry (`addUserReply`). */
function userReply(ydoc: Y.Doc, parentId: string): string {
  const result = addUserReply(ydoc, parentId, `a reply on ${parentId}`, () => {});
  expect(result.kind, JSON.stringify(result)).toBe("ok");
  return (result as { replyId: string }).replyId;
}

/** A reply written raw into the replies map (for a parent no entry accepts). */
function rawReply(ydoc: Y.Doc, parentId: string, extra: Record<string, unknown> = {}): string {
  const id = `${parentId}-raw-reply`;
  withBrowser(ydoc, () =>
    replies(ydoc).set(id, {
      id,
      annotationId: parentId,
      author: "user",
      text: `a reply on ${parentId}`,
      timestamp: clock++,
      ...extra,
    }),
  );
  return id;
}

const ctrl = () => getOrCreateDocument(CTRL_ROOM);

function clearChat(): void {
  const chat = ctrl().getMap(Y_MAP_CHAT);
  withInternal(ctrl(), () => {
    for (const k of [...chat.keys()]) chat.delete(k);
  });
}

/** The ids a poll hands in its two answerable buckets. */
const handed = (inbox: Inbox) => [
  ...inbox.userActions.map((a) => String(a.id)),
  ...inbox.userReplies.map((r) => String(r.id)),
];

async function buildWorld(flag: "1" | "" = "1"): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `wait${run}`;
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
  // The lines of `src/server/index.ts` (the waiting probe is left unwired:
  // the table calls `documentWaiting` itself).
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setOwnershipChatSide(ownershipChatSide);
  setChatRowsDeletedListener(forgetChatMessageOwners);
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-waiting-"));
  await buildWorld();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setInboxResponseCorruptorForTests(undefined);
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

// ---------------------------------------------------------------------------
// The row world.

interface RowWorld {
  d: Doc;
  file: string;
  /** Tandem's Claude's own comment: its holding claim. */
  claude: string;
  /** The row's one candidate item. */
  candidate: string;
  parent: string;
  readers: Record<"r0" | "r1" | "r2" | "a", ReturnType<typeof reader>>;
}

/** The world every row starts from: D open, Tandem's Claude present and holding it by a write. */
async function rowWorld(): Promise<RowWorld> {
  const file = realFile("d.md");
  // Opened before presence, so the user-open default leaves it unowned and the
  // holding is the write-claim below, made before the row's item exists.
  const id = await userOpen(file);
  setActiveDocId(frontId);
  setTandemPresenceSource(() => true);
  const ydoc = getDocument(id) as Y.Doc;
  const claude = await writeAs(TANDEM, id);
  expect(getDocOwner(id)?.ownerId).toBe(TANDEM);
  return {
    d: { id, ydoc },
    file,
    claude,
    candidate: "",
    parent: "",
    readers: { r0: reader(TANDEM), r1: reader(TANDEM), r2: reader(TANDEM), a: reader(A) },
  };
}

type ItemKind =
  | "user-comment"
  | "user-comment-accepted"
  | "user-comment-dismissed"
  | "user-comment-agent"
  | "user-comment-bad-content"
  | "user-comment-on-E"
  | "import-comment"
  | "collision-comment"
  | "claude-suggestion"
  | "user-reply"
  | "raw-user-reply"
  | "import-reply"
  | "claude-reply"
  | "claude-annotation-accepted";

type ParentKind =
  | "none"
  | "claude"
  | "user-acked"
  | "claude-suggestion"
  | "note"
  | "private-comment"
  | "legacy-flag"
  | "highlight"
  | "local-model"
  | "import-note";

type Act =
  | "item"
  | "poll"
  | "poll-again"
  | "poll2"
  | "legacy-poll"
  | "undone-poll"
  | `edit:${number}`
  | "take-a"
  | "a-poll"
  | "a-lapse"
  | "claude-dismisses-parent"
  | "promote-parent"
  | "accept-claude"
  | "solo"
  | "mode-unknown"
  | "handover-throws"
  | "honour-local";

interface Row {
  name: string;
  item: ItemKind;
  parent: ParentKind;
  /** In order; `"item"` places the candidate's creation (first, if absent). */
  acts: readonly Act[];
  expected: "waiting" | "not";
  /** A recorded difference: what the fresh poll does instead of agreeing. */
  difference?: "poll-hands-it" | "poll-hands-notice";
  /** The fresh poll skips the SDK client's schema check (row 33). */
  rawPoll?: true;
}

async function makeParent(w: RowWorld, kind: ParentKind): Promise<void> {
  const { ydoc } = w.d;
  const p = `${prefix}-parent`;
  switch (kind) {
    case "none":
      return;
    case "claude":
      w.parent = w.claude;
      return;
    case "user-acked":
      w.parent = userComment(ydoc, p);
      // Handed to a reader of Tandem's Claude, and acknowledged by its next poll.
      expect(handed(await w.readers.r0.poll(w.d.id))).toEqual([p]);
      expect(handed(await w.readers.r0.poll(w.d.id))).toEqual([]);
      return;
    case "claude-suggestion":
      w.parent = await writeAs(TANDEM, w.d.id, { suggestedText: "Howdy" });
      return;
    case "note":
      w.parent = p;
      putRecord(ydoc, {
        id: p,
        author: "user",
        type: "note",
        audience: "private",
        range: { from: 0, to: 5 },
        content: "my note",
        status: "pending",
        timestamp: clock++,
      });
      return;
    case "private-comment":
      w.parent = userComment(ydoc, p, { audience: "private" });
      return;
    case "legacy-flag":
      w.parent = p;
      putRecord(ydoc, {
        id: p,
        author: "user",
        type: "flag",
        range: { from: 0, to: 5 },
        content: "a legacy flag",
        status: "pending",
        timestamp: clock++,
      });
      return;
    case "highlight":
      w.parent = p;
      putRecord(ydoc, {
        id: p,
        author: "user",
        type: "highlight",
        audience: "private",
        color: "yellow",
        range: { from: 0, to: 5 },
        content: "",
        status: "pending",
        timestamp: clock++,
      });
      return;
    case "local-model":
      w.parent = p;
      putRecord(ydoc, {
        id: p,
        author: "claude",
        type: "comment",
        audience: "outbound",
        range: { from: 0, to: 5 },
        content: "from the local model",
        status: "pending",
        timestamp: clock++,
        agentIdentity: { kind: "local", label: "Local model" },
      });
      return;
    case "import-note":
      w.parent = p;
      putRecord(ydoc, {
        id: p,
        author: "import",
        type: "note",
        audience: "private",
        range: { from: 0, to: 5 },
        content: "a Word comment",
        status: "pending",
        timestamp: clock++,
      });
      return;
  }
}

async function makeItem(w: RowWorld, kind: ItemKind): Promise<void> {
  const { ydoc } = w.d;
  const c = `${prefix}-cand`;
  switch (kind) {
    case "user-comment":
      w.candidate = userComment(ydoc, c);
      return;
    case "user-comment-accepted":
      w.candidate = userComment(ydoc, c, { status: "accepted", resolvedBy: "user" });
      return;
    case "user-comment-dismissed":
      w.candidate = userComment(ydoc, c, { status: "dismissed", resolvedBy: "user" });
      return;
    case "user-comment-agent":
      w.candidate = userComment(ydoc, c, { agentIdentity: { kind: "local", label: "Local" } });
      return;
    case "user-comment-bad-content":
      // Passes the read's shape check (`hasAnnotationShape` tests no `content`),
      // fails the schema's `content: z.string()`.
      w.candidate = userComment(ydoc, c, { content: 42 });
      return;
    case "user-comment-on-E": {
      const e = mkDoc("e");
      w.candidate = userComment(e.ydoc, c);
      return;
    }
    case "import-comment":
      // No stored audience: the sanitiser derives "private" for an import.
      w.candidate = c;
      putRecord(ydoc, {
        id: c,
        author: "import",
        type: "comment",
        range: { from: 0, to: 5 },
        content: "a Word comment",
        status: "pending",
        timestamp: clock++,
      });
      return;
    case "collision-comment":
      w.candidate = userComment(ydoc, `${w.claude}#accepted`);
      return;
    case "claude-suggestion":
      w.candidate = await writeAs(TANDEM, w.d.id, { suggestedText: "Howdy" });
      return;
    case "user-reply":
      w.candidate = userReply(ydoc, w.parent);
      return;
    case "raw-user-reply":
      w.candidate = rawReply(ydoc, w.parent);
      return;
    case "import-reply":
      w.candidate = rawReply(ydoc, w.parent, { author: "import", private: true });
      return;
    case "claude-reply": {
      const replied = await as(TANDEM, "tandem_annotationReply", {
        annotationId: w.parent,
        text: "Claude's own reply",
        documentId: w.d.id,
      });
      expect(replied.error, JSON.stringify(replied)).toBe(false);
      const own = [...replies(ydoc).values()].find(
        (r) => (r as { author: string }).author === "claude",
      ) as { id: string };
      w.candidate = own.id;
      return;
    }
    case "claude-annotation-accepted":
      patchRecord(ydoc, w.claude, { status: "accepted", resolvedBy: "user" });
      w.candidate = w.claude;
      return;
  }
}

async function runAct(w: RowWorld, act: Act, row: Row): Promise<void> {
  const { id } = w.d;
  if (act === "item") return makeItem(w, row.item);
  if (act.startsWith("edit:")) {
    patchRecord(w.d.ydoc, w.candidate, { editedAt: Number(act.slice(5)) });
    return;
  }
  switch (act) {
    case "poll":
      await w.readers.r1.poll(id);
      return;
    case "poll-again":
      await w.readers.r1.poll(id);
      return;
    case "poll2":
      await w.readers.r2.poll(id);
      return;
    case "legacy-poll":
      await pollAs(TANDEM, { documentId: id });
      return;
    case "undone-poll": {
      vi.spyOn(console, "error").mockImplementation(() => {});
      setInboxResponseCorruptorForTests(() => ({ broken: true }));
      callingAs = TANDEM;
      const result = await client.callTool({
        name: "tandem_checkInbox",
        arguments: { cursor: "start", documentId: id },
      });
      expect(parseResult(result).error).toBe(true);
      // Cleared before the last poll.
      setInboxResponseCorruptorForTests(undefined);
      return;
    }
    case "take-a":
      expect(await openAs(A, w.file)).toBe(id);
      setActiveDocId(frontId);
      expect(getDocOwner(id)?.ownerId).toBe(A);
      return;
    case "a-poll":
      await w.readers.a.poll(id);
      return;
    case "a-lapse":
      lapseByGrace(A);
      // The default rule gives it back to Tandem's Claude (present).
      expect(getDocOwner(id)?.ownerId).toBe(TANDEM);
      return;
    case "claude-dismisses-parent": {
      const resolved = await as(TANDEM, "tandem_resolveAnnotation", {
        id: w.parent,
        action: "dismiss",
        documentId: id,
      });
      expect(resolved.error, JSON.stringify(resolved)).toBe(false);
      return;
    }
    case "promote-parent":
      // The browser's promotion: a note becomes a user comment shared with Claude.
      patchRecord(w.d.ydoc, w.parent, { author: "user", type: "comment", audience: "outbound" });
      return;
    case "accept-claude":
      patchRecord(w.d.ydoc, w.claude, { status: "accepted", resolvedBy: "user" });
      return;
    case "solo":
      setCtrlMode("solo");
      return;
    case "mode-unknown":
      setCtrlMode(null);
      return;
    case "handover-throws":
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      setOwnershipInboxHandover(() => {
        throw new Error("x");
      });
      return;
    case "honour-local":
      __setHonourLocalPeriodRecordsForTests(true);
      return;
  }
}

// ---------------------------------------------------------------------------
// The agreement table (the main judge).

const ROWS: readonly Row[] = [
  // Comments
  { name: "1 never polled", item: "user-comment", parent: "none", acts: [], expected: "waiting" },
  {
    name: "2 cursor poll, acknowledged (the same reader polled again)",
    item: "user-comment",
    parent: "none",
    acts: ["item", "poll", "poll-again"],
    expected: "not",
  },
  {
    name: "3 cursor poll, unacknowledged",
    item: "user-comment",
    parent: "none",
    acts: ["item", "poll"],
    expected: "waiting",
  },
  {
    name: "4 cursor-less poll (assigns and acknowledges)",
    item: "user-comment",
    parent: "none",
    acts: ["item", "legacy-poll"],
    expected: "not",
  },
  {
    name: "5 acknowledged, then edited",
    item: "user-comment",
    parent: "none",
    acts: ["item", "poll", "poll-again", "edit:100"],
    expected: "waiting",
  },
  {
    name: "6 editedAt moved backwards after a newer version was acknowledged",
    item: "user-comment",
    parent: "none",
    acts: ["item", "edit:200", "poll", "poll-again", "edit:100"],
    expected: "not",
  },
  {
    name: "7 an older version acknowledged; the current one handed unacknowledged",
    item: "user-comment",
    parent: "none",
    acts: ["item", "poll", "poll-again", "edit:100", "poll-again"],
    expected: "waiting",
  },
  {
    name: "8 acknowledged higher, unacknowledged lower",
    item: "user-comment",
    parent: "none",
    // R2 is handed v0 and keeps its cursor; edit to 200, R1 is handed it and
    // acknowledges; edit back to 100, R2 polls with its old cursor and is
    // handed v100 unacknowledged.
    acts: ["item", "poll2", "edit:200", "poll", "poll-again", "edit:100", "poll2"],
    expected: "not",
  },
  {
    name: "9 a cursor poll undone",
    item: "user-comment",
    parent: "none",
    acts: ["item", "undone-poll"],
    expected: "waiting",
  },
  {
    name: "10 re-owed: a terminal handed and acknowledging it lapses with presence",
    item: "user-comment",
    parent: "none",
    acts: ["take-a", "item", "a-poll", "a-poll", "a-lapse"],
    expected: "waiting",
  },
  {
    name: "11 resolved (accepted), never handed",
    item: "user-comment-accepted",
    parent: "none",
    acts: [],
    expected: "not",
  },
  {
    name: "12 resolved (dismissed), never handed",
    item: "user-comment-dismissed",
    parent: "none",
    acts: [],
    expected: "not",
  },
  {
    name: "13 resolved, then edited",
    item: "user-comment-dismissed",
    parent: "none",
    acts: ["item", "edit:100"],
    expected: "waiting",
  },
  {
    name: "14 only the highest version unacknowledged",
    item: "user-comment",
    parent: "none",
    acts: ["item", "edit:150", "poll", "poll-again", "edit:200", "poll-again", "edit:100"],
    expected: "not",
  },
  // Replies (kind "r")
  {
    name: "15 reply never polled, on the user's own acknowledged comment",
    item: "user-reply",
    parent: "user-acked",
    acts: [],
    expected: "waiting",
  },
  {
    name: "16 reply never polled, on Claude's comment",
    item: "user-reply",
    parent: "claude",
    acts: [],
    expected: "waiting",
  },
  {
    name: "17 reply on Claude's comment: cursor acknowledged",
    item: "user-reply",
    parent: "claude",
    acts: ["item", "poll", "poll-again"],
    expected: "not",
  },
  {
    name: "18 reply on Claude's comment: cursor unacknowledged",
    item: "user-reply",
    parent: "claude",
    acts: ["item", "poll"],
    expected: "waiting",
  },
  {
    name: "19 reply on Claude's comment: cursor-less",
    item: "user-reply",
    parent: "claude",
    acts: ["item", "legacy-poll"],
    expected: "not",
  },
  {
    name: "20 reply on Claude's comment: re-owed (the terminal handed and acknowledging before it lapses)",
    item: "user-reply",
    parent: "claude",
    acts: ["take-a", "item", "a-poll", "a-poll", "a-lapse"],
    expected: "waiting",
  },
  {
    name: "21 reply on a resolved Claude comment, never polled (reply first, then Claude's own dismiss)",
    item: "user-reply",
    parent: "claude",
    acts: ["item", "claude-dismisses-parent"],
    expected: "waiting",
  },
  {
    name: "22 reply on Claude's own suggestion, never polled",
    item: "user-reply",
    parent: "claude-suggestion",
    acts: [],
    expected: "waiting",
  },
  {
    name: "23 reply in a note thread; the note promoted, then the promoted parent handed and acknowledged",
    item: "user-reply",
    parent: "note",
    acts: ["item", "promote-parent", "poll", "poll-again"],
    expected: "not",
  },
  {
    name: "24 Claude's own reply on Claude's own comment",
    item: "claude-reply",
    parent: "claude",
    acts: [],
    expected: "not",
  },
  // Never records
  {
    name: "25 a private note with a user reply",
    item: "user-reply",
    parent: "note",
    acts: [],
    expected: "not",
  },
  {
    name: '26 {comment, audience: "private"} with a user reply',
    item: "user-reply",
    parent: "private-comment",
    acts: [],
    expected: "not",
  },
  {
    name: "27 a legacy flag with a user reply",
    item: "user-reply",
    parent: "legacy-flag",
    acts: [],
    expected: "not",
  },
  {
    name: '28 an author "import" comment with no stored audience',
    item: "import-comment",
    parent: "none",
    acts: [],
    expected: "not",
  },
  {
    name: "29 an imported reply on a promoted comment, the promoted parent handed and acknowledged",
    item: "import-reply",
    parent: "import-note",
    acts: ["item", "promote-parent", "poll", "poll-again"],
    expected: "not",
  },
  {
    name: "30 a highlight with a user reply (raw write)",
    item: "raw-user-reply",
    parent: "highlight",
    acts: [],
    expected: "not",
  },
  {
    name: "31 Claude's own suggestion",
    item: "claude-suggestion",
    parent: "none",
    acts: [],
    expected: "not",
  },
  {
    name: "32 a Claude-authored local-model record with a user reply (local-period records honoured)",
    item: "user-reply",
    parent: "local-model",
    acts: ["honour-local", "item"],
    expected: "not",
  },
  {
    name: "33 a user comment carrying agentIdentity (local-period records honoured)",
    item: "user-comment-agent",
    parent: "none",
    acts: ["honour-local", "item"],
    expected: "waiting",
    // The server hands it with its stored `agentIdentity`, a field the
    // advertised output schema does not declare, so an SDK client that checks
    // structured content (this harness's, and Claude Code's) rejects the whole
    // response; reported on the PR. The row reads the server's answer.
    rawPoll: true,
  },
  // Others
  {
    name: "34 a schema-refused record (a non-string content that passes the shape check)",
    item: "user-comment-bad-content",
    parent: "none",
    acts: [],
    expected: "not",
  },
  {
    name: "35 Solo, a comment",
    item: "user-comment",
    parent: "none",
    acts: ["item", "solo"],
    expected: "not",
  },
  {
    name: "36 Solo, a reply",
    item: "user-reply",
    parent: "claude",
    acts: ["item", "solo"],
    expected: "not",
  },
  {
    name: "37 a waiting comment on another document E, none on D",
    item: "user-comment-on-E",
    parent: "none",
    acts: [],
    expected: "not",
  },
  {
    name: "38 a notice-key collision: a user comment `x#accepted` beside Claude's accepted x, notice acknowledged",
    item: "collision-comment",
    parent: "none",
    acts: ["accept-claude", "poll", "poll-again", "item"],
    expected: "not",
  },
  {
    name: "39 a failed handover, entries left acknowledged",
    item: "user-comment",
    parent: "none",
    acts: ["take-a", "item", "a-poll", "a-poll", "handover-throws", "a-lapse"],
    expected: "not",
  },
  {
    name: "40 a failed handover, entries left unacknowledged",
    item: "user-comment",
    parent: "none",
    acts: ["take-a", "item", "a-poll", "handover-throws", "a-lapse"],
    expected: "waiting",
  },
  // The differences, both sides asserted.
  {
    name: "41 mode unknown, a comment: waiting false by ruling; the fresh poll hands the unmarked record",
    item: "user-comment",
    parent: "none",
    acts: ["item", "mode-unknown"],
    expected: "not",
    difference: "poll-hands-it",
  },
  {
    name: "42 mode unknown, a reply: waiting false by ruling; the fresh poll hands the unmarked record",
    item: "user-reply",
    parent: "claude",
    acts: ["item", "mode-unknown"],
    expected: "not",
    difference: "poll-hands-it",
  },
  {
    name: "43 the user accepts Claude's annotation: the poll hands the notice; waiting is false",
    item: "claude-annotation-accepted",
    parent: "none",
    acts: [],
    expected: "not",
    difference: "poll-hands-notice",
  },
];

describe("the agreement table: waiting answers as a fresh poll of Tandem's Claude would hand (rows 1 to 43)", () => {
  it("has the brief's 43 rows, numbered in order", () => {
    expect(ROWS.map((r) => Number.parseInt(r.name, 10))).toEqual(
      Array.from({ length: 43 }, (_, i) => i + 1),
    );
  });

  for (const row of ROWS) {
    it(row.name, async () => {
      const w = await rowWorld();
      await makeParent(w, row.parent);
      const acts = row.acts.includes("item") ? row.acts : (["item", ...row.acts] as Act[]);
      for (const act of acts) await runAct(w, act, row);
      expect(w.candidate, "the row built its candidate").not.toBe("");

      // Spies around the waiting call only (the poll's admit logs its own drops):
      // a "not" answer must be computed, never the catch's.
      const logs = (["error", "warn", "log", "info"] as const).map((m) => vi.spyOn(console, m));
      const before = logs.map((spy) => spy.mock.calls.length);
      const waiting = documentWaiting(w.d.id);
      // The one line allowed: `listAnnotations`' own legacy-migration log
      // (row 27's flag), which every caller of the read gets (Accepted).
      const during = logs
        .flatMap((spy, i) => spy.mock.calls.slice(before[i]))
        .filter((call) => !String(call[0]).startsWith("[ANNOTATION-STORE] legacy migration:"));
      expect(during, "documentWaiting logged").toEqual([]);
      const inbox = row.rawPoll
        ? await rawFreshPoll(TANDEM, w.d.id)
        : await reader(TANDEM).poll(w.d.id);
      const pollHands = handed(inbox).includes(w.candidate);
      // One candidate: nothing else answerable is handed.
      expect(handed(inbox).filter((id) => id !== w.candidate)).toEqual([]);

      expect(waiting, "waiting").toBe(row.expected === "waiting");
      if (row.difference === undefined) {
        expect(pollHands, "the fresh poll hands the candidate iff waiting").toBe(waiting);
      } else if (row.difference === "poll-hands-it") {
        expect(pollHands, "the fresh poll hands the unmarked record").toBe(true);
      } else {
        expect(pollHands).toBe(false);
        expect(inbox.userResponses.map((r) => String(r.id))).toEqual([w.candidate]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// No write, judged by behaviour.

/** What a call that writes nothing must leave equal. */
function observable(w: RowWorld, counts: { d: number; ctrl: number }) {
  const scopes = [...deliveryRegistry.documentScopes(), CHAT_SCOPE].sort();
  return JSON.stringify({
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
    afterTransaction: afterTransactionListeners(w.d.ydoc),
    listeners: { d: listenerCounts(w.d.ydoc), ctrl: listenerCounts(ctrl()) },
  });
}

/**
 * How many `afterTransaction` listeners D has (the quiet-document state
 * attaches one). Read from lib0's observer map, `Y.Doc`'s base class.
 */
function afterTransactionListeners(ydoc: Y.Doc): number {
  const observers = (ydoc as unknown as { _observers: Map<string, Set<unknown>> })._observers;
  expect(observers).toBeInstanceOf(Map);
  return observers.get("afterTransaction")?.size ?? 0;
}

/**
 * Every listener a write could leave behind: each event's listener count on
 * the Y.Doc, and the observe/observeDeep handlers of the maps waiting reads.
 */
function listenerCounts(ydoc: Y.Doc): Record<string, number> {
  const observers = (ydoc as unknown as { _observers: Map<string, Set<unknown>> })._observers;
  const out: Record<string, number> = {};
  for (const [event, set] of observers) out[`doc:${event}`] = set.size;
  for (const name of [Y_MAP_ANNOTATIONS, Y_MAP_ANNOTATION_REPLIES, Y_MAP_USER_AWARENESS]) {
    const type = ydoc.share.get(name) as
      | { _eH: { l: unknown[] }; _dEH: { l: unknown[] } }
      | undefined;
    if (type) out[`${name}:observe`] = type._eH.l.length;
    if (type) out[`${name}:observeDeep`] = type._dEH.l.length;
  }
  return out;
}

/** A user comment no poll has handed, with no `relRange` and a stored range its snapshot still matches. */
function refreshFixture(w: RowWorld, n: number): string {
  return userComment(w.d.ydoc, `${prefix}-fixture${n}`, {
    range: { from: 0, to: 5 },
    textSnapshot: "Hello",
  });
}

/** Strip what differs between two builds of the same world: the run prefix, cursors and generated reply ids. */
function normalise(inbox: Inbox, claude: string) {
  const p = (s: string) => s.split(claude).join("CLAUDE").split(prefix).join("P");
  return {
    hasNew: inbox.hasNew,
    userActions: inbox.userActions.map((a) => ({ id: p(String(a.id)), edited: a.edited })),
    userReplies: inbox.userReplies.map((r) => ({
      parent: p(String(r.annotationId)),
      text: p(r.text),
    })),
    userResponses: inbox.userResponses.map((r) => p(String(r.id))),
  };
}

/**
 * The brief's world: handed out cursor-less, then by cursor and acknowledged,
 * then by cursor unacknowledged; then unhanded items. Each a comment and a
 * reply, with a refresh fixture after every setup poll. With `calls`, waiting
 * is asked twice and everything observable is compared across the calls.
 * Returns what the holder's cursor poll and a fresh cursor-less poll return after.
 */
async function noWriteWorld(calls: boolean) {
  clock = 1_000;
  const w = await rowWorld();
  const { ydoc, id } = w.d;
  const holder = w.readers.r1;
  userComment(ydoc, `${prefix}-c-legacy`);
  userReply(ydoc, w.claude);
  await pollAs(TANDEM, { documentId: id });
  refreshFixture(w, 1);
  userComment(ydoc, `${prefix}-c-acked`);
  userReply(ydoc, w.claude);
  await holder.poll(id);
  refreshFixture(w, 2);
  await holder.poll(id);
  refreshFixture(w, 3);
  userComment(ydoc, `${prefix}-c-unacked`);
  userReply(ydoc, w.claude);
  await holder.poll(id);
  const fixture = refreshFixture(w, 4);
  userComment(ydoc, `${prefix}-c-unhanded`);
  userReply(ydoc, w.claude);

  if (calls) {
    // The control room exists before the call (the mode read uses the creating getter).
    expect(getDocument(CTRL_ROOM)).toBeDefined();
    // The positive anchor: on a twin, a refresh of the fixture writes.
    const twin = new Y.Doc();
    Y.applyUpdate(twin, Y.encodeStateAsUpdate(ydoc));
    const twinStore = new YDocStore(twin, w.file, id);
    const rec = twinStore.listAnnotations().find((a) => a.id === fixture);
    expect(rec?.relRange).toBeUndefined();
    let twinUpdates = 0;
    twin.on("update", () => twinUpdates++);
    twinStore.refreshAnnotations([rec as NonNullable<typeof rec>]);
    expect(twinUpdates).toBeGreaterThan(0);

    const counts = { d: 0, ctrl: 0 };
    ydoc.on("update", () => counts.d++);
    ctrl().on("update", () => counts.ctrl++);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const before = observable(w, counts);
    expect(documentWaiting(id)).toBe(true);
    const between = observable(w, counts);
    expect(documentWaiting(id)).toBe(true);
    const after = observable(w, counts);
    expect(between).toBe(before);
    expect(after).toBe(before);
    expect(counts).toEqual({ d: 0, ctrl: 0 });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
    // The lazy anchor is still unspent.
    const stored = annotations(ydoc).get(fixture) as { relRange?: unknown };
    expect(stored.relRange).toBeUndefined();
  }
  return {
    holder: normalise(await holder.poll(id), w.claude),
    cursorLess: normalise(await pollAs(TANDEM, { documentId: id }), w.claude),
  };
}

describe("no write, judged by behaviour", () => {
  it("two consecutive calls leave the registry, ownership, the Y.Docs and D's listeners as they were, and log nothing", async () => {
    await noWriteWorld(true);
  });

  it("follow-ups: the holder's cursor poll and a fresh cursor-less poll return what they would have without the calls", async () => {
    const withCalls = await noWriteWorld(true);
    await close?.();
    resetInbox();
    resetOwnershipForTests();
    await buildWorld();
    const without = await noWriteWorld(false);
    expect(withCalls).toEqual(without);
    // Not vacuous: the follow-ups hand something.
    expect(without.holder.userActions.length + without.holder.userReplies.length).toBeGreaterThan(
      0,
    );
  });

  it("an id that is not open answers false and creates no document", () => {
    const id = `${prefix}-not-open`;
    expect(documentWaiting(id)).toBe(false);
    expect(getDocument(id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Other cases.

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

describe("isDocumentWaiting, the module alone", () => {
  const userCommentRecord = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    author: "user",
    type: "comment",
    audience: "outbound",
    range: { from: 0, to: 5 },
    content: "c",
    status: "pending",
    timestamp: 1,
    ...extra,
  });
  const input = (over: Partial<DocumentWaitingInput>): DocumentWaitingInput =>
    deepFreeze({
      documentId: "doc",
      annotations: [],
      repliesOf: () => deepFreeze([]),
      mode: "tandem",
      handedAtOrAbove: () => false,
      isLocalModelRecord: () => false,
      ...over,
    } as DocumentWaitingInput);

  it("answers over deep-frozen inputs (a mutation would throw)", () => {
    const anns = [userCommentRecord("c1")] as never;
    expect(isDocumentWaiting(input({ annotations: anns }))).toBe(true);
    expect(isDocumentWaiting(input({ annotations: anns, handedAtOrAbove: () => true }))).toBe(
      false,
    );
    expect(isDocumentWaiting(input({ annotations: anns, mode: "solo" }))).toBe(false);
    expect(isDocumentWaiting(input({ annotations: anns, mode: "indeterminate" }))).toBe(false);
    const parent = userCommentRecord("p", { author: "claude" });
    const reply = { id: "r1", annotationId: "p", author: "user", text: "t", timestamp: 2 };
    const withReply = input({
      annotations: [parent] as never,
      repliesOf: () => deepFreeze([reply]) as never,
    });
    expect(isDocumentWaiting(withReply)).toBe(true);
  });

  it("restates the reply gate: raw note-thread, private and private-parent replies never count", () => {
    const reply = (extra: Record<string, unknown> = {}) =>
      deepFreeze([
        { id: "r", annotationId: "p", author: "user", text: "t", timestamp: 2, ...extra },
      ]);
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ type: "note", audience: "private" }, {}],
      [{ audience: "private" }, {}],
      [{}, { private: true }],
      // A Claude-facing parent that is not a comment (a legacy Claude highlight
      // stored outbound keeps its audience): the type arm alone refuses it.
      [{ author: "claude", type: "highlight", audience: "outbound" }, {}],
    ];
    for (const [parentExtra, replyExtra] of cases) {
      const anns = [userCommentRecord("p", parentExtra)] as never;
      expect(
        isDocumentWaiting(
          input({
            annotations: anns,
            handedAtOrAbove: (kind) => kind === "a",
            repliesOf: () => reply(replyExtra) as never,
          }),
        ),
        JSON.stringify([parentExtra, replyExtra]),
      ).toBe(false);
    }
  });
});

describe("documentWaiting is total", () => {
  it("a read that throws answers false, with one fixed log line naming no id", async () => {
    const w = await rowWorld();
    userComment(w.d.ydoc, `${prefix}-c`);
    vi.spyOn(YDocStore.prototype, "listAnnotations").mockImplementation(() => {
      throw new Error(`boom ${w.d.id}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(documentWaiting(w.d.id)).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.[0]);
    expect(error.mock.calls[0]).toHaveLength(1);
    expect(line).not.toContain(w.d.id);
    expect(line).not.toContain("boom");
    expect(line).toBe(
      "[Tandem] waiting could not be computed for a document; it is read as holding nothing waiting.",
    );
  });
});

/** A terminal holds D with a waiting comment on it; returns D's id. */
function terminalHolds(): string {
  const d = mkDoc("held");
  setDocOwner(d.id, { ownerId: A, kind: "opened" }, "take", A);
  userComment(d.ydoc, `${prefix}-c`);
  return d.id;
}

describe("step 5 asks the probe", () => {
  it("with presence, a terminal holding D lapses, and the probe is asked exactly once, with D", () => {
    setTandemPresenceSource(() => true);
    const id = terminalHolds();
    const probe = vi.fn((documentId: string) => documentWaiting(documentId));
    setWaitingProbe(probe);
    lapseByGrace(A);
    expect(getDocOwner(id)?.ownerId).toBe(TANDEM);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0]).toBe(id);
    expect(probe.mock.results[0]?.value).toBe(true);
  });

  it("characterization: at default presence the probe is never asked", () => {
    const id = terminalHolds();
    const probe = vi.fn(() => true);
    setWaitingProbe(probe);
    lapseByGrace(A);
    expect(getDocOwner(id)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  for (const flag of ["", "1"] as const) {
    it(`characterization${flag === "" ? " (dark)" : ", the flag-on twin"}: a grace armed flag on, then run with the flag ${flag === "" ? "off" : "on"}`, () => {
      setTandemPresenceSource(() => true);
      const id = terminalHolds();
      const probe = vi.fn(() => true);
      setWaitingProbe(probe);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      view = view.filter((e) => e.ownerId !== A);
      noteTransportChanged(A);
      if (flag === "") vi.stubEnv("TANDEM_OWNERSHIP", "");
      vi.advanceTimersByTime(DEFAULT_GRACE_MS + 1);
      vi.useRealTimers();
      vi.stubEnv("TANDEM_OWNERSHIP", "1");
      if (flag === "") {
        // The record lapsed; flag off, `defaultRuleOwner()` is null and
        // `setDocOwner` returns at the flag, so the entry is not moved (and the
        // record, still holding it, is not deleted) and the probe is not asked.
        expect(getOwnerRecord(A)?.lapsed).toBe(true);
        expect(getDocOwner(id)?.ownerId).toBe(A);
        expect(probe).not.toHaveBeenCalled();
      } else {
        expect(getOwnerRecord(A)).toBeUndefined();
        expect(getDocOwner(id)?.ownerId).toBe(TANDEM);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(probe.mock.calls[0]).toEqual([id, TANDEM]);
      }
    });
  }
});
