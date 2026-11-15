/**
 * Posts, batches and forged values (#2358, the posts PR; ownership design
 * §5.5, §6.4, §6.5, §7.3 as that PR's brief rules them). Ships dark: flag on
 * for the whole file except where a test says otherwise.
 *
 * Everything goes through the real `tandem_checkInbox` and `tandem_reply`
 * tools, with **three registered records, A, B and C, each with its own
 * cursor**, and every seam `src/server/index.ts` wires (the sequence source,
 * the inbox handover, the chat side and the chat-row deletion listener).
 * Changes of ownership go through production paths: a take is `tandem_open`,
 * a write's claim `tandem_comment`, a tab close `POST /api/close`, a lapse
 * the grace. `setDocOwner` is used only for setup.
 *
 * Tests that need Tandem's Claude present use the presence seam; PR 3b makes
 * that branch reachable in production (Ruling 5).
 *
 * The client side of R4 (a real Hocuspocus connection) is in
 * `ownership-chat-client-undo.test.ts`.
 *
 * Platform: real files under `os.tmpdir()` joined with `path.join` for
 * `tandem_open` and `POST /api/open`; the CTRL session file lives in vitest's
 * throwaway app-data dir. Nothing is gated.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { z } from "zod";
import { setChatRowsDeletedListener } from "../../src/server/chat-row-deletions.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { unwatchFile } from "../../src/server/file-watcher.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import {
  handOverDocumentInbox,
  onTandemReply,
  ownershipChatSide,
  registerAwarenessTools,
  resetInbox,
  setChatCommitFaultForTests,
  setInboxResponseCorruptorForTests,
  unansweredUserChatKeys,
} from "../../src/server/mcp/awareness.js";
import { settledChatIds } from "../../src/server/mcp/chat-handled.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs, restoreCtrlSession } from "../../src/server/mcp/document-service.js";
import { deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  checkInboxOutputShape,
  checkInboxOwnershipShape,
} from "../../src/server/mcp/output-schemas.js";
import { handleClose } from "../../src/server/mcp/routes/close.js";
import { handleOpen } from "../../src/server/mcp/routes/open.js";
import {
  __resetLocalPeriodForTests,
  __setHonourLocalPeriodRecordsForTests,
} from "../../src/server/models/local-period.js";
import { saveCtrlSession } from "../../src/server/session/manager.js";
import { getMcpContext, runWithMcpContext } from "../../src/server/sessions/context.js";
import { runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  DEFAULT_GRACE_MS,
  forgetChatMessageOwners,
  getDocOwner,
  getOwnerRecord,
  MAX_DETACHED_RECORDS,
  noteTransportChanged,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setChatOwnershipFaultForTests,
  setDocOwner,
  setLossForTests,
  setOwnershipChatSide,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setTandemPresenceSource,
  setTransportView,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_CHAT } from "../../src/shared/constants.js";
import { withInternal, withMcp } from "../../src/shared/origins.js";
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
        throw new Error("after the pass");
      }
      return real.resolveDeliveryRound(...args);
    },
  };
});

/** Set to make `aiRefusal` refuse (the licence); counts `noteClaudeActivity`. */
const licence = vi.hoisted(() => ({ refuse: false, activity: 0 }));
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
vi.mock("../../src/server/mcp/presence-expiry.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/server/mcp/presence-expiry.js")>();
  return {
    ...real,
    noteClaudeActivity: (docName: string) => {
      licence.activity++;
      real.noteClaudeActivity(docName);
    },
  };
});

const A = "claude:posts-a";
const B = "claude:posts-b";
const C = "claude:posts-c";
/** A caller with an owner id and no record. */
const NOBODY = "test:caller";

const inboxSchema = z.object({ ...checkInboxOutputShape, ...checkInboxOwnershipShape });
type Inbox = z.infer<typeof inboxSchema>;

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs: string | undefined = A;
let run = 0;
let prefix = "";
let tmpDir = "";

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

function realFile(name: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, "Hello world, this is a test document.\n");
  return filePath;
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

async function as(owner: string | undefined, tool: string, args: Record<string, unknown> = {}) {
  callingAs = owner;
  return parseResult(await client.callTool({ name: tool, arguments: args })) as Result;
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
    get cursor() {
      return cursor;
    },
    set cursor(value: string) {
      cursor = value;
    },
  };
}

const chatIds = (inbox: Inbox) => inbox.chatMessages.map((m) => String(m.id)).sort();

/** `owner`'s two consecutive cursor polls (the second with the first's cursor) are not handed `k`. */
async function notHanded(owner: string, k: string): Promise<void> {
  const r = reader(owner);
  for (const n of [1, 2]) expect(chatIds(await r.poll()), `${owner} poll ${n}`).not.toContain(k);
}

/** `owner`'s two consecutive cursor-less polls are not handed `k`. */
async function notHandedCursorless(owner: string, k: string): Promise<void> {
  for (const n of [1, 2]) {
    expect(chatIds(await pollAs(owner)), `${owner} cursor-less ${n}`).not.toContain(k);
  }
}

const reply = (owner: string | undefined, replyTo: string, extra: Record<string, unknown> = {}) =>
  as(owner, "tandem_reply", { text: `reply from ${owner}`, replyTo, ...extra });
const post = (owner: string | undefined, extra: Record<string, unknown> = {}) =>
  as(owner, "tandem_reply", { text: `post from ${owner}`, ...extra });

const ownerOf = (id: string) => getDocOwner(id)?.ownerId;
const messageOwner = (k: string) =>
  ownershipSnapshotForTests().messageOwners.find(([mk]) => mk === k)?.[1];
const answererOf = (k: string) =>
  ownershipSnapshotForTests().chatAnswerers.find(([mk]) => mk === k)?.[1];
const labelOf = (owner: string) => getOwnerRecord(owner)?.label as string;
/** Claude rows that name `k` in `replyTo`. */
const repliesTo = (k: string) =>
  [...chatMap().values()].filter(
    (v) => (v as ChatMessage).author === "claude" && (v as ChatMessage).replyTo === k,
  ) as ChatMessage[];
/** The one final reply row naming `k`. */
const finalReplyTo = (k: string) => repliesTo(k).find((r) => r.inProgress !== true) as ChatMessage;
const claudeRows = () =>
  [...chatMap().values()].filter((v) => (v as ChatMessage).author === "claude") as ChatMessage[];
const handled = () => settledChatIds(chatMap());

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

/** The lines of `src/server/index.ts` that wire the ownership side. */
function wireSeams(): void {
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setOwnershipChatSide(ownershipChatSide);
  setChatRowsDeletedListener(forgetChatMessageOwners);
}

async function startTools(): Promise<void> {
  ({ client, close } = await setupMcpServer(
    [registerAwarenessTools, registerDocumentTools, registerAnnotationTools],
    {
      // `undefined` is a request whose context carries no owner id: a wiring
      // fault (R1.4's last case), reached by a context without one.
      dispatch: (fn) =>
        callingAs === undefined
          ? runWithMcpContext({ ...getMcpContext(), ownerId: undefined }, fn)
          : asTestCaller(fn, { ownerId: callingAs }),
    },
  ));
  // The SDK client validates every structured response against the output
  // schema tools/list advertised (additionalProperties: false).
  await client.listTools();
}

async function buildWorld(flag: "1" | "" = "1"): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `posts${run}`;
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
  wireSeams();
  setCtrlMode("tandem");
  setActiveDocId(mkDoc("front"));
  await startTools();
}

/**
 * A simulated restart (R0.1's and R3.6's fixture): the CTRL session is saved,
 * the live CTRL doc is DROPPED (review round 1, item 1: before, the rows
 * stayed in the live doc and the restore merged rows that were never lost),
 * the delivery registry and the ownership module are reset, the records come
 * back, and `restoreCtrlSession` restores into a fresh CTRL doc as `main()`
 * does at boot. Flag on unless `flag` says otherwise.
 */
async function restart(flag: "1" | "" = "1"): Promise<void> {
  await saveCtrlSession(ctrl());
  await close?.();
  const before = ctrl();
  removeDocument(CTRL_ROOM);
  expect(ctrl(), "a fresh CTRL doc").not.toBe(before);
  expect(chatMap().size, "nothing survives but the file").toBe(0);
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  resetInbox();
  resetOwnershipForTests();
  view = [];
  setTransportView(() => view);
  register(A);
  register(B);
  register(C);
  wireSeams();
  setCtrlMode("tandem");
  await restoreCtrlSession();
  await startTools();
}
const restartFlagOn = () => restart("1");

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-posts-"));
  await buildWorld();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  roundThrows.next = false;
  licence.refuse = false;
  setInboxResponseCorruptorForTests(undefined);
  setChatCommitFaultForTests(undefined);
  setChatOwnershipFaultForTests(undefined);
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

describe("R3: the handled rule, `settles` and the sweep", () => {
  it("the batch: A is handed M1..M3, replies to M3; A's next poll lists M1 and M2 in M3's reply's settles; after A lapses a fresh reader is not handed them", async () => {
    const [m1, m2, m3] = [userChat(key("m1")), userChat(key("m2")), userChat(key("m3"))];
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([m1, m2, m3].sort());
    expect((await reply(A, m3)).error).toBe(false);
    // Not yet: the hand-out is not confirmed received (step 1 finds nothing).
    expect(finalReplyTo(m3).settles).toBeUndefined();
    expect(chatIds(await a.poll())).toEqual([]);
    // Step 2, at the confirming poll: what only the rule changes.
    expect(finalReplyTo(m3).settles).toEqual([m1, m2].sort());
    expect(answererOf(m1)).toBe(A);
    lapseByGrace(A, "transport removed");
    await notHanded(B, m1);
    await notHanded(B, m2);
  });

  it("step 1 across hand-outs: an earlier hand-out already confirmed is settled at once; a later one at its confirming poll", async () => {
    const a = reader(A);
    const m1 = userChat(key("m1"));
    expect(chatIds(await a.poll())).toEqual([m1]);
    // Confirms M1's hand-out (A's mark passes it, so this poll hands nothing).
    expect(chatIds(await a.poll())).toEqual([]);
    const [m2, m3] = [userChat(key("m2")), userChat(key("m3"))];
    expect(chatIds(await a.poll())).toEqual([m2, m3].sort());
    expect((await reply(A, m3)).error).toBe(false);
    expect(finalReplyTo(m3).settles, "step 1: M1 at once").toEqual([m1]);
    await a.poll();
    expect(finalReplyTo(m3).settles, "step 2: M2 at the confirmation").toEqual([m1, m2].sort());
  });

  /** The live registry sequence of chat key `k`. */
  const seqOf = (k: string) => deliveryRegistry.lookup("c", k, 0)?.seq as number;
  /** Open a real file as the user; then `owner` holds it through a write. */
  async function heldBy(owner: string, name: string): Promise<{ id: string; file: string }> {
    const file = realFile(name);
    const id = await userOpen(file);
    await writeAs(owner, id);
    return { id, file };
  }

  it("the conjunction at step 1: a re-owed M_old (higher sequence, earlier timestamp) does not settle M_new; M_early (lower on both) is settled", async () => {
    const d1 = await heldBy(B, "c1.md");
    const d2 = await heldBy(A, "c2.md");
    const mEarly = userChat(key("early"), d2.id);
    const mOld = userChat(key("old"), d1.id);
    const mNew = userChat(key("new"), d2.id);
    // M_old is handed to B first.
    expect(chatIds(await reader(B).poll())).toEqual([mOld]);
    // A is handed M_early and M_new and confirms them.
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([mEarly, mNew].sort());
    await a.poll();
    // A's tandem_open takes D1: M_old is re-owed and gets a new sequence.
    await openAs(A, d1.file);
    expect(chatIds(await a.poll())).toEqual([mOld]);
    // The precondition (review round 1, item 7): M_old's sequence is now above
    // M_new's, while its timestamp is below.
    expect(seqOf(mOld)).toBeGreaterThan(seqOf(mNew));
    expect((row(mOld) as ChatMessage).timestamp).toBeLessThan((row(mNew) as ChatMessage).timestamp);
    expect((await reply(A, mOld)).error).toBe(false);
    await a.poll();
    expect(finalReplyTo(mOld).settles ?? [], "the settled twin").toContain(mEarly);
    expect(finalReplyTo(mOld).settles ?? []).not.toContain(mNew);
    expect(handled().has(mNew)).toBe(false);
  });

  it("the conjunction at step 2: in one hand-out, a message with a lower sequence but a later timestamp than the target is not settled; one lower on both is", async () => {
    const d = await heldBy(B, "c3.md");
    const early = userChat(key("early")); // doc-less, earliest
    const target = userChat(key("t"), d.id);
    // A takes `early` first (unconfirmed), so it is A's; B is handed the target.
    expect(chatIds(await reader(A).poll())).toEqual([early]);
    expect(chatIds(await reader(B).poll())).toEqual([target]);
    const later = userChat(key("later")); // doc-less, latest
    // A is handed `early` and `later` (their entries; not confirmed).
    expect(chatIds(await reader(A).poll())).toEqual([early, later].sort());
    // A's tandem_open takes D: the target is re-owed and gets a new sequence.
    await openAs(A, d.file);
    const a2 = reader(A);
    expect(chatIds(await a2.poll())).toEqual([early, later, target].sort());
    expect(seqOf(target)).toBeGreaterThan(seqOf(later));
    expect((row(target) as ChatMessage).timestamp).toBeLessThan(
      (row(later) as ChatMessage).timestamp,
    );
    expect((await reply(A, target)).error).toBe(false);
    expect(finalReplyTo(target).settles, "not yet received").toBeUndefined();
    await a2.poll(); // confirms the hand-out holding all three
    expect(finalReplyTo(target).settles).toEqual([early]);
    expect(handled().has(later)).toBe(false);
  });

  it("step 2 skips retired entries: M2's entry is retired by a re-owe before A's confirming poll; A's reply to M3 settles M1 and not M2", async () => {
    const d = await heldBy(A, "c4.md");
    const [m1, m2, m3] = [userChat(key("m1")), userChat(key("m2"), d.id), userChat(key("m3"))];
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([m1, m2, m3].sort());
    const handedSeq = seqOf(m2);
    expect((await reply(A, m3)).error).toBe(false);
    // B's tandem_open takes D: M2 is re-owed (its entry retired) and B is handed it.
    await openAs(B, d.file);
    expect(deliveryRegistry.lookup("c", m2, 0), "the precondition: retired").toBeUndefined();
    expect(chatIds(await reader(B).poll())).toEqual([m2]);
    expect(seqOf(m2), "a new entry, not the one A was handed").not.toBe(handedSeq);
    await a.poll();
    expect(finalReplyTo(m3).settles).toEqual([m1]);
  });

  it("a step 1 write that throws skips nothing else: the reply stands, A answers M3 and owns it, and A is the row's writer (review round 1, item 12)", async () => {
    const a = reader(A);
    const m1 = userChat(key("m1"));
    expect(chatIds(await a.poll())).toEqual([m1]);
    await a.poll(); // M1 received: step 1 has something to write
    const m3 = userChat(key("m3"));
    expect(chatIds(await a.poll())).toEqual([m3]); // M3 has an entry: a batch to settle
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setChatOwnershipFaultForTests((at) => {
      if (at === "settles") throw new Error("settles write");
    });
    expect((await reply(A, m3)).error).toBe(false);
    setChatOwnershipFaultForTests(undefined);
    const r = finalReplyTo(m3);
    expect(r.settles, "the write failed").toBeUndefined();
    expect(answererOf(m3)).toBe(A);
    expect(messageOwner(m3)?.ownerId).toBe(A);
    expect(ownershipSnapshotForTests().repliers).toContainEqual([r.id, A]);
    expect(errors.mock.calls.map((c) => String(c[0])).join("\n")).toContain("replySettles failed");
  });

  it("step 2 writes only the confirming record's rows: B's confirming poll adds nothing to A's row", async () => {
    const [ma1, ma2] = [userChat(key("a1")), userChat(key("a2"))];
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([ma1, ma2].sort());
    expect((await reply(A, ma2)).error).toBe(false);
    const [mb1, mb2] = [userChat(key("b1")), userChat(key("b2"))];
    const b = reader(B);
    expect(chatIds(await b.poll())).toEqual([mb1, mb2].sort());
    expect((await reply(B, mb2)).error).toBe(false);
    await b.poll();
    expect(finalReplyTo(mb2).settles).toEqual([mb1]);
    expect(finalReplyTo(ma2).settles, "B's confirmation touches no row of A's").toBeUndefined();
    await a.poll();
    expect(finalReplyTo(ma2).settles).toEqual([ma1]);
  });

  it("step 2 adds only to the confirming record's own rows: a no-caller final reply in the same hand-out gets no settles (review round 1, item 2)", async () => {
    const [m1, m2, m3] = [userChat(key("m1")), userChat(key("m2")), userChat(key("m3"))];
    const b = reader(B);
    expect(chatIds(await b.poll())).toEqual([m1, m2, m3].sort());
    expect((await reply(B, m3)).error).toBe(false);
    // A server-origin final reply with no replier (as /api/channel-reply
    // writes one) naming M2, which is in B's unconfirmed hand-out.
    withMcp(ctrl(), () =>
      chatMap().set(key("shim"), {
        id: key("shim"),
        author: "claude",
        text: "from the shim",
        timestamp: clock++,
        read: true,
        replyTo: m2,
      }),
    );
    await b.poll();
    expect(finalReplyTo(m3).settles).toEqual([m1, m2].sort());
    expect(row(key("shim"))?.settles, "a row with no replier is never settled").toBeUndefined();
  });

  it("the sweep is gone: A's reply to a later message does not settle the message B received; after B lapses a fresh reader is handed it", async () => {
    const mB = userChat(key("mb"));
    const b = reader(B);
    expect(chatIds(await b.poll())).toEqual([mB]);
    await b.poll(); // B's hand-out is received.
    const mA = userChat(key("ma"));
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([mA]);
    await a.poll(); // A's hand-out is received too.
    expect((await reply(A, mA)).error).toBe(false);
    await a.poll();
    expect(handled().has(mB)).toBe(false);
    expect(unansweredUserChatKeys(), "the owed-at-switch set counts it").toContain(mB);
    lapseByGrace(B, "transport removed");
    expect(chatIds(await reader(C).poll())).toEqual([mB]);
  });

  it("the sweep is gone (held state): a lapsed B that gained M_B by a poll is kept with a grace when its transport goes", async () => {
    lapseByGrace(B, "stream dropped");
    const mB = userChat(key("mb"));
    const b = reader(B);
    expect(chatIds(await b.poll())).toEqual([mB]);
    await b.poll();
    const mA = userChat(key("ma"));
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([mA]);
    await a.poll();
    expect((await reply(A, mA)).error).toBe(false);
    await a.poll();
    view = view.filter((e) => e.ownerId !== B);
    noteTransportChanged(B);
    expect(getOwnerRecord(B), "kept: M_B is unhandled").toBeDefined();
    expect(getOwnerRecord(B)?.graceTimer).toBeDefined();
  });

  for (const how of ["replyTo", "settles"] as const) {
    it(`the cursor-less check: an unread M named by a server-written final reply's ${how} is not handed to its owner`, async () => {
      const m = userChat(key("m"));
      const other = userChat(key("other"));
      withMcp(ctrl(), () =>
        chatMap().set(key("r"), {
          id: key("r"),
          author: "claude",
          text: "answered",
          timestamp: clock++,
          read: true,
          ...(how === "replyTo" ? { replyTo: m } : { replyTo: other, settles: [m] }),
        }),
      );
      expect(row(m)?.read).toBe(false);
      // The twin: in the `replyTo` variant `other` is unhandled and handed.
      if (how === "replyTo") expect(chatIds(await pollAs(A))).toContain(other);
      await notHandedCursorless(A, m);
    });
  }

  it("R3.3: A acknowledges a doc-less M it owns and lapses; B is handed it (cursor); A's acknowledgement is superseded", async () => {
    const m = userChat(key("m"));
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    expect(messageOwner(m)?.ownerId).toBe(A);
    lapseByGrace(A, "transport removed");
    expect(chatIds(await reader(B).poll())).toEqual([m]);
    expect(repliesTo(m).find((r) => r.inProgress)?.superseded).toBe(true);
  });

  it("R3.3, cursor-less: the same, B's cursor-less poll is handed it", async () => {
    const m = userChat(key("m"));
    expect(chatIds(await pollAs(A))).toEqual([m]);
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    lapseByGrace(A, "transport removed");
    expect(chatIds(await pollAs(B))).toEqual([m]);
    expect(repliesTo(m).find((r) => r.inProgress)?.superseded).toBe(true);
  });

  it("R3.3, a message that follows a document: A acknowledges M on D it holds; no owner; B takes D; A's acknowledgement superseded, B handed M, A's reply refused naming B", async () => {
    const id = await userOpen(realFile("ack.md"));
    await writeAs(A, id);
    const m = userChat(key("m"), id);
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    expect(messageOwner(m)).toBeUndefined();
    await openAs(B, getOpenDocs().get(id)?.filePath as string);
    expect(repliesTo(m).find((r) => r.inProgress)?.superseded).toBe(true);
    expect(chatIds(await reader(B).poll())).toEqual([m]);
    const refused = await reply(A, m);
    expect(refused.details?.reason).toBe("chat");
    expect(refused.message).toBe(
      `The terminal session ${labelOf(B)} answers this message. Do not reply to it.`,
    );
  });

  it("R3.6: settles and superseded survive a save and a restore; after a restart the settled message is handled, not carried over, and not handed", async () => {
    const [m1, m2] = [userChat(key("m1")), userChat(key("m2"))];
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([m1, m2].sort());
    expect((await reply(A, m2)).error).toBe(false);
    await a.poll();
    const m3 = userChat(key("m3"));
    expect(chatIds(await a.poll())).toEqual([m3]);
    expect((await reply(A, m3, { inProgress: true })).error).toBe(false);
    lapseByGrace(A, "transport removed");
    const ackKey = repliesTo(m3).find((r) => r.inProgress)?.id as string;
    expect(row(ackKey)?.superseded).toBe(true);
    await restartFlagOn();
    expect(finalReplyTo(m2).settles).toEqual([m1]);
    expect(row(ackKey)?.superseded).toBe(true);
    expect(handled().has(m1)).toBe(true);
    expect(ownershipSnapshotForTests().carriedOver).not.toContain(m1);
    await notHanded(B, m1);
  });

  it("R3.8: a poll that confirms a hand-out and then fails validation still settles; so does one that throws after the pass", async () => {
    const [m1, m2] = [userChat(key("m1")), userChat(key("m2"))];
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([m1, m2].sort());
    expect((await reply(A, m2)).error).toBe(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setInboxResponseCorruptorForTests(() => ({ broken: true }));
    callingAs = A;
    const failed = await client.callTool({
      name: "tandem_checkInbox",
      arguments: { cursor: a.cursor },
    });
    expect(parseResult(failed).error).toBe(true);
    setInboxResponseCorruptorForTests(undefined);
    expect(finalReplyTo(m2).settles).toEqual([m1]);

    const [m3, m4] = [userChat(key("m3")), userChat(key("m4"))];
    const b = reader(B);
    expect(chatIds(await b.poll())).toEqual([m3, m4].sort());
    expect((await reply(B, m4)).error).toBe(false);
    roundThrows.next = true;
    callingAs = B;
    const threw = await client.callTool({
      name: "tandem_checkInbox",
      arguments: { cursor: b.cursor },
    });
    expect(parseResult(threw).error).toBe(true);
    expect(finalReplyTo(m4).settles).toEqual([m3]);
  });
});

describe("R0.1: carried-over messages", () => {
  /**
   * Rows written by master's code path: a server built flag off; A is handed
   * M1..M3 on D by a cursor poll, passes the cursor back, and replies to M3,
   * so master's sweep settles M1 and M2. Then a restart with the flag on.
   */
  async function carriedOverWorld(): Promise<{ id: string; m1: string; m2: string; m3: string }> {
    await close?.();
    await buildWorld("");
    const id = await userOpen(realFile("carried.md"));
    const [m1, m2, m3] = [
      userChat(key("m1"), id),
      userChat(key("m2"), id),
      userChat(key("m3"), id),
    ];
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([m1, m2, m3].sort());
    await a.poll();
    expect((await reply(A, m3)).error).toBe(false);
    expect([row(m1)?.read, row(m2)?.read]).toEqual([true, true]);
    await restartFlagOn();
    expect(ownershipSnapshotForTests().carriedOver).toEqual([m1, m2].sort());
    return { id, m1, m2, m3 };
  }

  const snapshotRows = (keys: readonly string[]) => keys.map((k) => JSON.stringify(row(k)));

  for (const path of ["cursor", "cursor-less"] as const) {
    it(`a take by B re-owes neither, and neither B nor a fresh reader is handed them (${path})`, async () => {
      const { id, m1, m2 } = await carriedOverWorld();
      await writeAs(A, id);
      const before = snapshotRows([m1, m2]);
      await openAs(B, getOpenDocs().get(id)?.filePath as string);
      expect(ownerOf(id)).toBe(B);
      expect(snapshotRows([m1, m2])).toEqual(before);
      for (const m of [m1, m2]) {
        if (path === "cursor") {
          await notHanded(B, m);
          await notHanded(C, m);
        } else {
          await notHandedCursorless(B, m);
          await notHandedCursorless(C, m);
        }
      }
    });
  }

  for (const path of ["cursor", "cursor-less"] as const) {
    const notHandedBy = async (owner: string, m: string) => {
      if (path === "cursor") await notHanded(owner, m);
      else await notHandedCursorless(owner, m);
    };

    it(`A, holding D, lapses through the grace: neither is re-owed, nor handed to B or a fresh reader (${path})`, async () => {
      const { id, m1, m2 } = await carriedOverWorld();
      await writeAs(A, id);
      const before = snapshotRows([m1, m2]);
      lapseByGrace(A, "transport removed");
      expect(ownerOf(id)).toBeUndefined();
      expect(snapshotRows([m1, m2])).toEqual(before);
      for (const m of [m1, m2]) {
        await notHandedBy(B, m);
        await notHandedBy(C, m);
      }
    });

    it(`D's tab closes while A holds it: neither gets a per-message owner, nor is handed to A or a fresh reader (${path})`, async () => {
      const { id, m1, m2 } = await carriedOverWorld();
      await writeAs(A, id);
      const before = snapshotRows([m1, m2]);
      await closeByRoute(id);
      expect(messageOwner(m1)).toBeUndefined();
      expect(messageOwner(m2)).toBeUndefined();
      expect(snapshotRows([m1, m2])).toEqual(before);
      for (const m of [m1, m2]) {
        await notHandedBy(A, m);
        await notHandedBy(C, m);
      }
    });
  }

  it("a tab close whose holder has lapsed (its move deferred behind a busy queue) re-owes no carried-over message (R0.6)", async () => {
    const { id, m1, m2 } = await carriedOverWorld();
    await writeAs(A, id);
    let release!: () => void;
    const op = runDocOp(id, () => new Promise<void>((r) => (release = r)));
    lapseByGrace(A, "transport removed");
    expect(ownerOf(id)).toBe(A);
    const before = snapshotRows([m1, m2]);
    await closeByRoute(id);
    expect(snapshotRows([m1, m2])).toEqual(before);
    expect(messageOwner(m1)).toBeUndefined();
    await notHanded(B, m1);
    release();
    await op;
  });

  it("nothing joins the set during a run: M4, pushed to A and acknowledged, is re-owed by B's take and handed to B", async () => {
    const { id } = await carriedOverWorld();
    await writeAs(A, id);
    const m4 = userChat(key("m4"), id);
    expect((await reply(A, m4, { inProgress: true })).error).toBe(false);
    expect(row(m4)?.read).toBe(true);
    expect(ownershipSnapshotForTests().carriedOver).not.toContain(m4);
    await openAs(B, getOpenDocs().get(id)?.filePath as string);
    expect(row(m4)?.read).toBe(false);
    expect(repliesTo(m4).find((r) => r.inProgress)?.superseded).toBe(true);
    expect(chatIds(await reader(B).poll())).toContain(m4);
  });

  it("a carried-over message counts nowhere: a detached record that holds nothing acknowledges one; held state is false and no grace is armed", async () => {
    const { m1 } = await carriedOverWorld();
    lapseByGrace(C, "stream dropped");
    expect(getOwnerRecord(C)?.graceTimer).toBeUndefined();
    expect((await reply(C, m1, { inProgress: true })).error).toBe(false);
    expect(messageOwner(m1)).toBeUndefined();
    expect(getOwnerRecord(C)?.graceTimer, "no grace re-armed").toBeUndefined();
    view = view.filter((e) => e.ownerId !== C);
    noteTransportChanged(C);
    expect(getOwnerRecord(C), "holds nothing: deleted").toBeUndefined();
  });

  it("a final reply from A, which holds nothing, is accepted: M1 is handled, A is its answerer, it has no owner", async () => {
    const { m1 } = await carriedOverWorld();
    expect((await reply(A, m1)).error).toBe(false);
    expect(handled().has(m1)).toBe(true);
    expect(answererOf(m1)).toBe(A);
    expect(messageOwner(m1)).toBeUndefined();
  });

  it("an acknowledgement from A is accepted: no owner, no answerer", async () => {
    const { m1 } = await carriedOverWorld();
    expect((await reply(A, m1, { inProgress: true })).error).toBe(false);
    expect(messageOwner(m1)).toBeUndefined();
    expect(answererOf(m1)).toBeUndefined();
  });

  it("two sessions: both acknowledgements accepted; B's final reply accepted; A's final reply then refused answered", async () => {
    const { m1 } = await carriedOverWorld();
    expect((await reply(A, m1, { inProgress: true })).error).toBe(false);
    expect((await reply(B, m1, { inProgress: true })).error).toBe(false);
    expect(messageOwner(m1)).toBeUndefined();
    expect((await reply(B, m1)).error).toBe(false);
    const refused = await reply(A, m1);
    expect(refused.details?.reason).toBe("answered");
  });

  it("Ruling 4's arm: a carried-over message on an unowned, busy document, replied to by a session never handed it, is accepted with no owner", async () => {
    const { id, m1 } = await carriedOverWorld();
    let release!: () => void;
    const op = runDocOp(id, () => new Promise<void>((r) => (release = r)));
    expect((await reply(C, m1)).error).toBe(false);
    expect(messageOwner(m1)).toBeUndefined();
    expect(ownerOf(id)).toBeUndefined();
    release();
    await op;
  });

  it("R0.2: a lapsed record with its transport registered acknowledges a claimable doc-less message: its grace is armed again", async () => {
    lapseByGrace(A, "stream dropped");
    expect(getOwnerRecord(A)?.graceTimer).toBeUndefined();
    const m = userChat(key("m"));
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    expect(messageOwner(m)).toEqual({ ownerId: A, origin: "acknowledgement" });
    expect(ownershipSnapshotForTests().timers).toBe(1);
    expect(getOwnerRecord(A)?.graceTimer).toBeDefined();
  });
});

describe("R1: posts", () => {
  it("design §14 item 4: a post naming a document another session holds is refused with the holder's reason", async () => {
    const d = mkDoc("held");
    setDocOwner(d, { ownerId: B, kind: "opened" }, "take", B);
    const refused = await post(A, { documentId: d });
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.details).toEqual({
      reason: "held",
      holder: { label: labelOf(B), displayKind: "terminal" },
      documentId: d,
    });
    expect(refused.message).toBe(
      `The terminal session ${labelOf(B)} is working on this document. Only the user can reassign it, from the owner badge on its tab. You can still read it. Do not retry on this document. Nothing was sent. If the user asked you in your own conversation to say this, tell them there.`,
    );
  });

  it("design §14 item 4: while Tandem's Claude is present, a doc-less post from a terminal is refused post", async () => {
    setTandemPresenceSource(() => true);
    const refused = await post(A);
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.details).toEqual({
      reason: "post",
      holder: { label: labelOf(TANDEM_OWNER_ID), displayKind: "Tandem's Claude" },
    });
    expect(refused.message).toBe(
      "Tandem's Claude answers chat that is not about a document. To answer a user's chat message, pass its id as `replyTo`. Do not open or take a document in order to post. Nothing was sent. If the user asked you in your own conversation to say this, tell them there.",
    );
  });

  it("design §14 item 4: a post on an unowned document claims it; the claimant's next poll reports the cause, validated as an SDK client validates it", async () => {
    const d = mkDoc("u");
    expect((await post(A, { documentId: d })).error).toBe(false);
    expect(ownerOf(d)).toBe(A);
    const inbox = await reader(A).poll();
    expect(inbox.ownership?.changed).toEqual([
      { documentId: d, change: "gained", cause: "a chat post of yours claimed it" },
    ]);
  });

  it("no documentId while the active document is held by another record: accepted doc-less, nothing claimed", async () => {
    const front = docId("front");
    setDocOwner(front, { ownerId: B, kind: "opened" }, "take", B);
    expect((await post(A)).error).toBe(false);
    const posted = claudeRows().at(-1) as ChatMessage;
    expect(posted.documentId).toBeUndefined();
    expect(ownerOf(front)).toBe(B);
  });

  it("no documentId while the active document is unowned: accepted doc-less, the active tab is not claimed", async () => {
    expect((await post(A)).error).toBe(false);
    expect((claudeRows().at(-1) as ChatMessage).documentId).toBeUndefined();
    expect(ownerOf(docId("front"))).toBeUndefined();
  });

  it("no documentId while X holds the active document: stamped with it", async () => {
    setDocOwner(docId("front"), { ownerId: A, kind: "opened" }, "take", A);
    expect((await post(A)).error).toBe(false);
    expect((claudeRows().at(-1) as ChatMessage).documentId).toBe(docId("front"));
  });

  it("an explicit document X holds: stamped with it", async () => {
    const d = mkDoc("mine");
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);
    expect((await post(A, { documentId: d })).error).toBe(false);
    expect((claudeRows().at(-1) as ChatMessage).documentId).toBe(d);
  });

  it("an explicit document that is not open: judged doc-less, stamped with the id given", async () => {
    expect((await post(A, { documentId: "not-open-doc" })).error).toBe(false);
    expect((claudeRows().at(-1) as ChatMessage).documentId).toBe("not-open-doc");
    setTandemPresenceSource(() => true);
    const refused = await post(A, { documentId: "not-open-doc" });
    expect(refused.details).toEqual({
      reason: "post",
      holder: { label: labelOf(TANDEM_OWNER_ID), displayKind: "Tandem's Claude" },
      documentId: "not-open-doc",
    });
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.message).toBe(
      "The document you named is not open in Tandem, so this counts as a message that is not about a document. Do not open it just to post. Tandem's Claude answers chat that is not about a document. To answer a user's chat message, pass its id as `replyTo`. Do not open or take a document in order to post. Nothing was sent. If the user asked you in your own conversation to say this, tell them there.",
    );
  });

  it("an unowned document whose queue is busy, no loss: accepted without a claim, with no wait (R1.1)", async () => {
    const d = mkDoc("busy");
    let release!: () => void;
    const op = runDocOp(d, () => new Promise<void>((r) => (release = r)));
    expect((await post(A, { documentId: d })).error).toBe(false);
    expect(ownerOf(d)).toBeUndefined();
    release();
    await op;
  });

  it("a blocking loss on a busy, unowned document wins: refused lost (no holder)", async () => {
    const d = mkDoc("lost");
    setLossForTests(d, A, "taken");
    let release!: () => void;
    const op = runDocOp(d, () => new Promise<void>((r) => (release = r)));
    const refused = await post(A, { documentId: d });
    expect(refused.details).toEqual({
      reason: "lost",
      holder: null,
      documentId: d,
      cause: "taken",
    });
    expect(refused.message).toBe(
      "You lost this document, and nobody holds it now. You can still read it. Do not tandem_open it again unless the user asks you again after this point. Nothing was sent. If the user asked you in your own conversation to say this, tell them there.",
    );
    expect(refused.message).not.toMatch(/another session/i);
    release();
    await op;
  });

  it("lost with a holder, through production paths: B's tandem_open takes A's document; A's post naming it is refused lost naming B", async () => {
    const id = await userOpen(realFile("taken.md"));
    await writeAs(A, id);
    await openAs(B, getOpenDocs().get(id)?.filePath as string);
    const refused = await post(A, { documentId: id });
    expect(refused.details).toEqual({
      reason: "lost",
      holder: { label: labelOf(B), displayKind: "terminal" },
      documentId: id,
      cause: "taken",
    });
    expect(refused.message).toBe(
      `The terminal session ${labelOf(B)} has this document now. Only the user can reassign it, from the owner badge on its tab. You can still read it. Do not retry on this document. Nothing was sent. If the user asked you in your own conversation to say this, tell them there.`,
    );
  });

  it("claimed and default: post forms that say nothing about answering", async () => {
    const c = mkDoc("claimed");
    setDocOwner(c, { ownerId: B, kind: "claimed" }, "claim", B);
    const claimed = await post(A, { documentId: c });
    expect(claimed.code).toBe("NOT_DOC_OWNER");
    expect(claimed.details).toEqual({
      reason: "claimed",
      holder: { label: labelOf(B), displayKind: "terminal" },
      documentId: c,
    });
    expect(claimed.message).toBe(
      `The terminal session ${labelOf(B)} picked this document up while Tandem's Claude was away, and answers its comments and chat. Do not take the document in order to post about it. Nothing was sent. If the user asked you in your own conversation to say this, tell them there.`,
    );
    setTandemPresenceSource(() => true);
    const t = mkDoc("tandem");
    setDocOwner(t, { ownerId: TANDEM_OWNER_ID, kind: "default" }, "user-open");
    const def = await post(A, { documentId: t });
    expect(def.code).toBe("NOT_DOC_OWNER");
    expect(def.details).toEqual({
      reason: "default",
      holder: { label: labelOf(TANDEM_OWNER_ID), displayKind: "Tandem's Claude" },
      documentId: t,
    });
    expect(def.message).toBe(
      "Tandem's Claude answers this document's comments and chat. Do not take the document in order to post about it. Nothing was sent. If the user asked you in your own conversation to say this, tell them there.",
    );
    for (const text of [claimed.message, def.message]) expect(text).not.toMatch(/answer this/i);
  });

  it("a present Tandem's Claude's doc-less post is accepted (it is the doc-less chat owner; the greeting's path once PR 3b binds it)", async () => {
    setTandemPresenceSource(() => true);
    expect((await post(TANDEM_OWNER_ID)).error).toBe(false);
    expect((claudeRows().at(-1) as ChatMessage).documentId).toBeUndefined();
  });

  it("not-present: Tandem's Claude, not present, is refused with no document", async () => {
    const refused = await post(TANDEM_OWNER_ID);
    expect(refused.details).toEqual({ reason: "not-present", holder: null });
    expect(refused.message).toBe(
      "Tandem's Claude is turned off or stopped, so it cannot post to chat now. Nothing was sent. Do not retry.",
    );
  });

  it("R1.4: a caller with an owner id and no record, posting to a document another record holds, gets the no-record form", async () => {
    const d = mkDoc("held");
    setDocOwner(d, { ownerId: B, kind: "opened" }, "take", B);
    const refused = await post(NOBODY, { documentId: d });
    expect(refused.code).toBe("INTERNAL_ERROR");
    expect(refused.message).toBe(
      "tandem_reply refused: Tandem has no record for this session, so it cannot post to chat now. Nothing was sent. This is a fault in Tandem, not something to retry with different arguments.",
    );
  });

  it("R1.4: a caller with no owner id gets the wiring-fault refusal", async () => {
    const refused = await post(undefined);
    expect(refused.code).toBe("INTERNAL_ERROR");
    expect(refused.message).toBe(
      // `withErrorBoundary` answers first, before any handler runs; the
      // gate's own no-owner branch (REPLY_NO_OWNER) is defence behind it.
      "tandem_reply refused: this request carries no caller identity. This is a Tandem wiring fault, not something to retry with different arguments.",
    );
  });

  it("a replyTo that names no message is judged as a post: accepted with the unmatched warning; refused, it says why", async () => {
    const accepted = await reply(A, "no-such-message");
    expect(accepted.error).toBe(false);
    expect(accepted.data?.warning).toMatch(/^replyTo did not match any user chat message/);
    setTandemPresenceSource(() => true);
    const refused = await reply(A, "no-such-message");
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.details).toEqual({
      reason: "post",
      holder: { label: labelOf(TANDEM_OWNER_ID), displayKind: "Tandem's Claude" },
    });
    expect(refused.message).toBe(
      "The `replyTo` you passed names no user chat message, so this was treated as a message that answers nothing. Tandem's Claude answers chat that is not about a document. To answer a user's chat message, pass its id as `replyTo`. Do not open or take a document in order to post. Nothing was sent. If the user asked you in your own conversation to say this, tell them there.",
    );
  });

  it("R1.5: every refusal leaves no trace: no row, no Y.Doc write, no notify, no claim, no presence, no read stamp; an accepted post moves each", async () => {
    const heard: unknown[] = [];
    const off = onTandemReply((s) => heard.push(s));
    // Every Y.Doc update while the refusals run (as the merged reply version
    // watches): the CTRL doc and every document.
    const updates: string[] = [];
    const watched = [ctrl(), ...[...getOpenDocs().keys()].map((id) => getOrCreateDocument(id))];
    const listener = () => updates.push("update");
    try {
      const held = mkDoc("held");
      setDocOwner(held, { ownerId: B, kind: "opened" }, "take", B);
      const claimedDoc = mkDoc("claimed");
      setDocOwner(claimedDoc, { ownerId: B, kind: "claimed" }, "claim", B);
      const lost = mkDoc("lost");
      setLossForTests(lost, A, "taken");
      const takenFile = realFile("taken-trace.md");
      const taken = await userOpen(takenFile);
      await writeAs(A, taken);
      await openAs(B, takenFile);
      const m = userChat(key("m")); // an unread user row: no read stamp may land on it
      const rows = chatMap().size;
      const activity = licence.activity;
      const before = JSON.stringify(ownershipSnapshotForTests().ownerByDoc);
      for (const d of [...watched, ...[held, claimedDoc, lost, taken].map(getOrCreateDocument)]) {
        d.on("update", listener);
      }
      const refusals: Array<[string | undefined, Record<string, unknown>]> = [
        [A, { documentId: held }], // held
        [A, { documentId: claimedDoc }], // claimed
        [A, { documentId: lost }], // lost, no holder
        [A, { documentId: taken }], // lost, with a holder
        [TANDEM_OWNER_ID, {}], // not-present
        [NOBODY, {}], // no record
        [undefined, {}], // no owner id
      ];
      for (const [who, args] of refusals) {
        expect((await post(who, args)).error, JSON.stringify(args)).toBe(true);
      }
      setTandemPresenceSource(() => true);
      const tandemDoc = mkDoc("tandem-default");
      setDocOwner(tandemDoc, { ownerId: TANDEM_OWNER_ID, kind: "default" }, "user-open");
      getOrCreateDocument(tandemDoc).on("update", listener);
      updates.length = 0;
      for (const args of [
        {}, // post
        { documentId: tandemDoc }, // default
        { replyTo: "no-such-message" }, // the unmatched-replyTo post
        { documentId: "not-open-doc" }, // the named-not-open post
      ]) {
        expect((await post(A, args)).error, JSON.stringify(args)).toBe(true);
      }
      expect(chatMap().size, "no row").toBe(rows);
      expect(updates, "no Y.Doc write").toEqual([]);
      expect(heard, "no notify").toEqual([]);
      expect(licence.activity, "no typing presence").toBe(activity);
      expect(row(m)?.read, "no read stamp").toBe(false);
      expect(row(m)?.greeting).toBeUndefined();
      expect(
        JSON.stringify(ownershipSnapshotForTests().ownerByDoc.filter(([d]) => d !== tandemDoc)),
      ).toBe(before);
      // The positive twin: an accepted post moves each of them.
      setTandemPresenceSource(() => false);
      expect((await post(A)).error).toBe(false);
      expect(chatMap().size).toBe(rows + 1);
      expect(updates.length).toBeGreaterThan(0);
      expect(heard).toHaveLength(1);
      expect(licence.activity).toBeGreaterThan(activity);
    } finally {
      off();
      for (const d of watched) d.off("update", listener);
    }
  });

  it("R1.6: a post answers nothing: no answerer, no owner, no settles", async () => {
    const m = userChat(key("m"));
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    expect((await post(A)).error).toBe(false);
    expect(answererOf(m)).toBeUndefined();
    expect(handled().has(m)).toBe(false);
    expect(claudeRows().every((r) => r.settles === undefined)).toBe(true);
  });

  it("a post the licence refuses claims nothing and leaves no row (security review L4)", async () => {
    const d = mkDoc("u");
    licence.refuse = true;
    const rows = chatMap().size;
    expect((await post(A, { documentId: d })).code).toBe("LICENSE_REQUIRED");
    expect(ownerOf(d)).toBeUndefined();
    expect(chatMap().size).toBe(rows);
  });
});

describe("R2: answered once for chat", () => {
  it("design R1.5 (chat): A answers M on D; B, pushed M, takes D; B's reply and acknowledgement are refused answered, nothing written", async () => {
    const id = await userOpen(realFile("answered.md"));
    await writeAs(A, id);
    const m = userChat(key("m"), id);
    expect((await reply(A, m)).error).toBe(false);
    await openAs(B, getOpenDocs().get(id)?.filePath as string);
    const rows = chatMap().size;
    for (const extra of [{}, { inProgress: true }]) {
      const refused = await reply(B, m, extra);
      expect(refused.code).toBe("NOT_DOC_OWNER");
      expect(refused.details).toEqual({
        reason: "answered",
        holder: { label: labelOf(A), displayKind: "terminal" },
        documentId: id,
      });
      expect(refused.message).toBe(
        `The terminal session ${labelOf(A)} already answered this. Do not answer it again.`,
      );
    }
    expect(chatMap().size).toBe(rows);
  });

  it("an acknowledgement sets no answerer: A acknowledges and lapses; B is handed M and its final reply is accepted", async () => {
    const m = userChat(key("m"));
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    expect((await reply(A, m, { inProgress: true })).error).toBe(false);
    expect(answererOf(m)).toBeUndefined();
    lapseByGrace(A, "transport removed");
    expect(chatIds(await reader(B).poll())).toEqual([m]);
    expect((await reply(B, m)).error).toBe(false);
    expect(answererOf(m)).toBe(B);
  });

  it("R2.4: after a simulated restart, a message settled in persisted state with no answerer: its current owner's reply is accepted, another's refused chat", async () => {
    const d = mkDoc("d");
    setDocOwner(d, { ownerId: B, kind: "opened" }, "take", B);
    const m = userChat(key("m"), d);
    expect((await reply(B, m)).error).toBe(false);
    await restartFlagOn();
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);
    expect(answererOf(m)).toBeUndefined();
    expect(handled().has(m)).toBe(true);
    expect((await reply(B, m)).details?.reason).toBe("chat");
    expect((await reply(A, m)).error).toBe(false);
  });

  it("R2.4 in one run: a /api/channel-reply-style final reply (no caller), then M's owner's final reply is accepted", async () => {
    const m = userChat(key("m"));
    withMcp(ctrl(), () =>
      chatMap().set(key("shim"), {
        id: key("shim"),
        author: "claude",
        text: "from the shim",
        timestamp: clock++,
        read: true,
        replyTo: m,
      }),
    );
    expect(answererOf(m)).toBeUndefined();
    expect((await reply(A, m)).error).toBe(false);
  });

  it("R2.4 in one run, with an owner: after a no-caller final reply to M on A's document, B is refused chat and A's final reply is accepted", async () => {
    const d = mkDoc("d");
    setDocOwner(d, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), d);
    withMcp(ctrl(), () =>
      chatMap().set(key("shim"), {
        id: key("shim"),
        author: "claude",
        text: "from the shim",
        timestamp: clock++,
        read: true,
        replyTo: m,
      }),
    );
    expect((await reply(B, m)).details?.reason).toBe("chat");
    expect((await reply(A, m)).error).toBe(false);
  });

  it("R2.5: a local-model row naming M sets no answerer; M stays unhandled, a fresh reader is handed it, and its owner's reply is accepted", async () => {
    const m = userChat(key("m"));
    withMcp(ctrl(), () =>
      chatMap().set(key("local"), {
        id: key("local"),
        author: "claude",
        text: "from a local model",
        timestamp: clock++,
        read: true,
        replyTo: m,
        agentIdentity: { kind: "local", label: "a local model" },
      }),
    );
    expect(handled().has(m)).toBe(false);
    expect(chatIds(await reader(A).poll())).toEqual([m]);
    expect((await reply(A, m)).error).toBe(false);
    expect(answererOf(m)).toBe(A);
  });
});

describe("R0.7: the throw sites and the failed re-owe's retry", () => {
  it("chat.commit throws: the poll fails, sets no owner, and the message is owed again", async () => {
    const m = userChat(key("m"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    setChatCommitFaultForTests(() => {
      throw new Error("chat commit");
    });
    callingAs = A;
    const failed = await client.callTool({ name: "tandem_checkInbox", arguments: {} });
    expect(parseResult(failed).error).toBe(true);
    setChatCommitFaultForTests(undefined);
    expect(messageOwner(m)).toBeUndefined();
    expect(row(m)?.read).toBe(false);
    expect(chatIds(await reader(B).poll())).toEqual([m]);
  });

  it("commitChat throws (inside its total): logged; the poll returns; no owner is set, so the message stays claimable", async () => {
    const m = userChat(key("m"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setChatOwnershipFaultForTests((at) => {
      if (at === "commit") throw new Error("commit");
    });
    expect(chatIds(await pollAs(A))).toEqual([m]);
    setChatOwnershipFaultForTests(undefined);
    expect(messageOwner(m)).toBeUndefined();
    expect(errors.mock.calls.map((c) => String(c[0])).join("\n")).toContain("commitChat failed");
  });

  it("with the detached cap full, a re-owe that throws once inside a cap-caused lapse lapses no second record early", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A owns an unhandled doc-less message, and is detached first.
    const m = userChat(key("m"));
    expect(chatIds(await pollAs(A))).toEqual([m]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    entryOf(A).streamEver = true;
    entryOf(A).openStreams = 0;
    noteTransportChanged(A);
    // Fill the cap with detached records that each hold a document, armed
    // after A, so the cap ranks by expiry and A goes first.
    const detach = (id: string) => {
      // Hold before detaching, so recordHoldsState is true when ranked.
      view.push({ ownerId: id, openStreams: 1, streamEver: true });
      noteTransportRegistered(id, { recordKind: "claude" });
      setDocOwner(`${id}-doc`, { ownerId: id, kind: "opened" }, "take", id);
      entryOf(id).openStreams = 0;
      noteTransportChanged(id);
      vi.advanceTimersByTime(1);
    };
    for (let i = 0; i < MAX_DETACHED_RECORDS - 1; i++) detach(`claude:filler-${run}-${i}`);
    expect(ownershipSnapshotForTests().timers).toBe(MAX_DETACHED_RECORDS);
    let throws = 1;
    setChatOwnershipFaultForTests((at) => {
      if (at === "re-owe" && throws-- > 0) throw new Error("re-owe");
    });
    // One more detached record past the cap: the cap lapses A (the oldest),
    // whose re-owe throws once.
    detach(`claude:extra-${run}`);
    const lapsed = ownershipSnapshotForTests()
      .records.filter((r) => r.lapsed)
      .map((r) => r.ownerId);
    expect(lapsed, "the cap lapsed A and nobody else").toEqual([A]);
    expect(messageOwner(m)?.ownerId, "A keeps its owner: the re-owe failed").toBe(A);
    expect(throws, "the re-owe was reached").toBe(0);
    // What A got (review round 1, item 4): a retry timer of its own, never a
    // grace, so the cap still counts exactly MAX_DETACHED_RECORDS graces.
    expect(getOwnerRecord(A)?.graceTimer, "A has no grace").toBeUndefined();
    const graces = ownershipSnapshotForTests().records.filter((r) => r.graceTimer).length;
    expect(graces).toBe(MAX_DETACHED_RECORDS);
    expect(ownershipSnapshotForTests().timers, "the graces and A's one retry").toBe(
      MAX_DETACHED_RECORDS + 1,
    );
    vi.useRealTimers();
    setChatOwnershipFaultForTests(undefined);
  });

  it("a re-owe that always throws, for several records in their graces at once, neither recurses nor overflows; quick retries then slow retries, never a grace", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // A, B and C each own an unhandled doc-less message.
    const owned = new Map<string, string>();
    for (const who of [A, B, C]) {
      const m = userChat(key(`m-${who}`));
      expect(chatIds(await pollAs(who))).toEqual([m]);
      owned.set(who, m);
    }
    let attempts = 0;
    setChatOwnershipFaultForTests((at) => {
      if (at === "re-owe") {
        attempts++;
        throw new Error("re-owe");
      }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // All three detach at once: three graces running together.
    view = [];
    for (const who of [A, B, C]) noteTransportChanged(who);
    expect(ownershipSnapshotForTests().timers).toBe(3);
    vi.advanceTimersByTime(DEFAULT_GRACE_MS + 1);
    expect(attempts, "one re-owe per lapse, no recursion").toBe(3);
    // Three quick retries each, one grace apart.
    for (let i = 0; i < 3; i++) vi.advanceTimersByTime(DEFAULT_GRACE_MS + 1);
    expect(attempts).toBe(12);
    // Then slower: one grace is not enough for the next.
    vi.advanceTimersByTime(DEFAULT_GRACE_MS + 1);
    expect(attempts).toBe(12);
    vi.advanceTimersByTime(3 * DEFAULT_GRACE_MS);
    expect(attempts).toBe(15);
    for (const who of [A, B, C]) {
      expect(getOwnerRecord(who)?.graceTimer, `${who}: never a grace`).toBeUndefined();
    }
    expect(ownershipSnapshotForTests().timers, "one retry each").toBe(3);
    expect(errors.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "Tandem keeps retrying, less often",
    );
    // The fault clears: the next retries re-owe and the records go.
    setChatOwnershipFaultForTests(undefined);
    vi.advanceTimersByTime(4 * DEFAULT_GRACE_MS + 1);
    vi.useRealTimers();
    for (const [who, m] of owned) {
      expect(messageOwner(m)).toBeUndefined();
      expect(getOwnerRecord(who)).toBeUndefined();
    }
    expect(ownershipSnapshotForTests().timers).toBe(0);
  });
});

describe("dark: the restore (review round 1, item 3)", () => {
  /**
   * A chat row that is read and unhandled, and CTRL data left pending (a
   * forged struct aimed at the server's next write, which `encodeStateAsUpdate`
   * carries into the session file).
   */
  function readRowAndPending(): string {
    const m = userChat(key("read"));
    withInternal(ctrl(), () => chatMap().set(m, { ...(row(m) as ChatMessage), read: true }));
    const S = ctrl();
    const F = new Y.Doc();
    Y.applyUpdate(F, Y.encodeStateAsUpdate(S));
    F.clientID = S.clientID;
    F.getMap(Y_MAP_CHAT).set(key("next"), { placeholder: true });
    const C = new Y.Doc();
    Y.applyUpdate(C, Y.encodeStateAsUpdate(F));
    C.getMap(Y_MAP_CHAT).set(key("next"), { author: "claude", replyTo: m, text: "" });
    Y.applyUpdate(S, Y.encodeStateAsUpdate(C, Y.encodeStateVector(F)));
    expect((S.store as { pendingStructs: unknown }).pendingStructs).not.toBeNull();
    return m;
  }
  const pending = () => (ctrl().store as { pendingStructs: unknown }).pendingStructs;

  it("flag off: no carried-over set is taken and the restored pending data is left as master leaves it", async () => {
    await close?.();
    await buildWorld("");
    readRowAndPending();
    await restart("");
    expect(ownershipSnapshotForTests().carriedOver).toEqual([]);
    expect(pending(), "master's restore keeps it").not.toBeNull();
  });

  it("the flag-on twin: the read row is carried over and the pending data is dropped", async () => {
    await close?.();
    await buildWorld("");
    const m = readRowAndPending();
    await restart("1");
    expect(ownershipSnapshotForTests().carriedOver).toEqual([m]);
    expect(pending()).toBeNull();
  });
});

describe("dark", () => {
  it("flag off: a post is master's (active-document stamp), nothing is recorded, no settles or superseded are written", async () => {
    await close?.();
    await buildWorld("");
    const [m1, m2] = [userChat(key("m1")), userChat(key("m2"))];
    const a = reader(A);
    expect(chatIds(await a.poll())).toEqual([m1, m2].sort());
    expect((await reply(A, m2)).error).toBe(false);
    await a.poll();
    expect((await post(B)).error).toBe(false);
    expect((claudeRows().at(-1) as ChatMessage).documentId).toBe(docId("front"));
    for (const r of claudeRows()) {
      expect(r.settles).toBeUndefined();
      expect(r.superseded).toBeUndefined();
    }
    const snap = ownershipSnapshotForTests();
    expect(snap.carriedOver).toEqual([]);
    expect(snap.chatAnswerers).toEqual([]);
    expect(snap.repliers).toEqual([]);
  });
});

describe("R0.3: the flip-blocker rows this PR rewords", () => {
  it("the /api/channel-reply row: an acknowledgement handles nothing but still stamps read", async () => {
    const { OWNERSHIP_FLIP_BLOCKERS } = await import("./ownership-flip-blockers.js");
    const rows = OWNERSHIP_FLIP_BLOCKERS.map((r) => r.gap);
    const channel = rows.find((g) => g.startsWith("/api/channel-reply appends")) as string;
    expect(channel).toContain("A channel-reply final reply handles its message");
    expect(channel).toContain("acknowledgement handles nothing and sets no owner");
    expect(channel).toContain("it still stamps `read`");
    expect(channel).not.toContain("an acknowledgement included");
    const never = rows.find((g) => g.startsWith("A document claimed by a poll")) as string;
    expect(never).toContain("an acknowledgement handles nothing");
    expect(never).not.toContain("acknowledged, for instance");
    // The rows the posts PR closes are gone.
    for (const closed of [
      "Posts (tandem_reply without replyTo) are accepted from any caller",
      "The batch rule is master's",
      "Answered-once is not enforced for chat",
      "A client can write server-only values",
      "Change-notice cause the chat PR owes",
    ]) {
      expect(
        rows.some((g) => g.startsWith(closed)),
        closed,
      ).toBe(false);
    }
  });
});
