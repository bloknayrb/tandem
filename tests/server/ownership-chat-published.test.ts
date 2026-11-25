/**
 * The published chat state (#2358 PR 5d, ADR-054's 5d amendment; ownership
 * design §6.5, §8.5, §10.2, §10.3): each unanswered user chat message's owner
 * facts under `Y_MAP_OWNERSHIP_CHAT`, its pickup and stall clock counted from
 * its last change of owner, the composer summary's chat waiting and chat
 * stale, a document's chat in its waiting time, the guard on the new key,
 * and the CTRL snapshot keeping the published state out.
 *
 * Everything an AI does goes through the real `tandem_checkInbox` and
 * `tandem_reply` tools with three registered records, A, B and C, and the
 * seams `src/server/index.ts` wires (the real chat side, the real oldest
 * waiting probe, the real publisher). `setDocOwner` stands in for presence
 * and claims; the user's controls are called through `controlMessageOwner`.
 *
 * Platform: in-memory fixture documents with synthetic paths; nothing is
 * gated.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { setChatRowsDeletedListener } from "../../src/server/chat-row-deletions.js";
import { broadcastOpenDocs } from "../../src/server/documents/registry.js";
import {
  addDoc,
  removeDoc,
  resetPublished,
  setActiveDocId,
} from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import {
  handOverDocumentInbox,
  oldestDocumentWaiting,
  ownershipChatSide,
  registerAwarenessTools,
  resetInbox,
  setWaitingWrittenSinceForTests,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  requestOwnershipChatPublish,
  requestOwnershipPublish,
  runOwnershipTickForTests,
  startOwnershipPublishing,
  stopOwnershipPublishingForTests,
} from "../../src/server/ownership-publish.js";
import {
  loadCtrlSession,
  restoreCtrlDoc,
  saveCtrlSession,
} from "../../src/server/session/manager.js";
import {
  captureCarriedOverChat,
  controlMessageOwner,
  forgetChatMessageOwners,
  getOwnerRecord,
  type LauncherFacts,
  messageClocksForTests,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  ownershipSummary,
  publishedChatOwners,
  resetOwnershipForTests,
  setDocOwner,
  setLauncherFactsSource,
  setOldestWaitingProbe,
  setOpenDocumentIdsSource,
  setOwnershipChatPublishSink,
  setOwnershipChatSide,
  setOwnershipFrameSink,
  setOwnershipInboxHandover,
  setOwnershipPublishSink,
  setOwnershipSeqSource,
  setOwnershipTransportMode,
  setStartOrWakeSink,
  setTandemPresenceSource,
  setTransportView,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_CHAT,
  Y_MAP_DOCUMENT_META,
  Y_MAP_OPEN_DOCUMENTS,
  Y_MAP_OWNERSHIP_CHAT,
  Y_MAP_OWNERSHIP_SUMMARY,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { BROWSER_ORIGIN, withInternal } from "../../src/shared/origins.js";
import {
  OWNERSHIP_STALE_AFTER_MS,
  type PublishedChatOwners,
} from "../../src/shared/ownership-published.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";

const A = "claude:chatpub-a";
const B = "claude:chatpub-b";
const C = "claude:chatpub-c";
const TANDEM = TANDEM_OWNER_ID;
const MIN = 60_000;
/** A client's write: neither a server helper's tag nor null. */
const CLIENT = { client: true };

const FACTS: LauncherFacts = {
  running: true,
  startPending: false,
  off: false,
  notSetUp: false,
  stayingDown: false,
  bindFailed: false,
  startable: true,
};

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs: string = A;
let run = 0;
let prefix = "";
let present = false;
const rooms: string[] = [];

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
  rooms.push(id);
  return id;
}

const ctrl = () => getOrCreateDocument(CTRL_ROOM);
const chatMap = () => ctrl().getMap(Y_MAP_CHAT);
const awareness = () => ctrl().getMap(Y_MAP_USER_AWARENESS);
const published = () => awareness().get(Y_MAP_OWNERSHIP_CHAT) as PublishedChatOwners | undefined;
const entryIn = (room: string, id: string) =>
  (
    getOrCreateDocument(room).getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_OPEN_DOCUMENTS) as
      | Array<Record<string, unknown>>
      | undefined
  )?.find((e) => e.id === id);

/** An unread user chat message under key `k`, about `documentId` if given, written at `at`. */
function userChat(k: string, documentId?: string, at: number = Date.now()): string {
  withInternal(ctrl(), () =>
    chatMap().set(k, {
      id: k,
      author: "user",
      text: `text of ${k}`,
      timestamp: at,
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
  };
}

/** A cursor-less poll as `owner`: it takes what it may and stamps it read. */
async function poll(owner: string): Promise<void> {
  const result = await as(owner, "tandem_checkInbox");
  expect(result.error, JSON.stringify(result)).toBe(false);
}

const labelOf = (owner: string) => getOwnerRecord(owner)?.label as string;

/** One microtask (a republish), then two event-loop turns (a restore). */
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/** Make a record of Tandem's Claude exist, present. */
function tandemPresent(): void {
  present = true;
  setDocOwner(docId("front"), { ownerId: TANDEM, kind: "default" }, "presence");
}

async function buildWorld(flag: "1" | "" = "1"): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `chatpub${run}`;
  callingAs = A;
  present = false;
  resetInbox();
  resetOwnershipForTests();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  clearChat();
  withInternal(ctrl(), () => {
    awareness().delete(Y_MAP_OWNERSHIP_CHAT);
    awareness().delete(Y_MAP_OWNERSHIP_SUMMARY);
  });
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
  setTandemPresenceSource(() => present);
  setOpenDocumentIdsSource(() => getOpenDocs().keys());
  setStartOrWakeSink(() => {});
  setOwnershipFrameSink(() => {});
  setLauncherFactsSource(() => FACTS);
  setOldestWaitingProbe(oldestDocumentWaiting);
  setOwnershipPublishSink(requestOwnershipPublish);
  setOwnershipChatPublishSink(requestOwnershipChatPublish);
  setOwnershipTransportMode("http");
  setCtrlMode("tandem");
  setActiveDocId(mkDoc("front"));
  ({ client, close } = await setupMcpServer(
    [registerAwarenessTools, registerDocumentTools, registerAnnotationTools],
    { dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }) },
  ));
  await client.listTools();
}

/** Publish what is open now, and start the publisher (guard, tick, chat watch). */
async function startPublishing(): Promise<void> {
  broadcastOpenDocs();
  startOwnershipPublishing();
  await settle();
}

beforeEach(async () => {
  // The fixture's rows are written now; the waiting rule's boot time is a minute ago.
  setWaitingWrittenSinceForTests(Date.now() - MIN);
  await buildWorld();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  stopOwnershipPublishingForTests();
  resetPublished();
  setChatRowsDeletedListener(undefined);
  resetOwnershipForTests();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  for (const id of rooms.splice(0)) removeDocument(id);
  clearChat();
  withInternal(ctrl(), () => {
    awareness().delete(Y_MAP_OWNERSHIP_CHAT);
    awareness().delete(Y_MAP_OWNERSHIP_SUMMARY);
  });
  setWaitingWrittenSinceForTests(Date.now());
  vi.unstubAllEnvs();
});

describe("flag off (ships dark)", () => {
  it("writes no key, ticks no clock, restores nothing and logs nothing", async () => {
    await close?.();
    await buildWorld("");
    const spies = (["log", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const d = mkDoc("d");
    await startPublishing();
    const m = userChat(key("m"));
    userChat(key("n"), d);
    await poll(A);
    expect((await as(A, "tandem_reply", { text: "done", replyTo: m })).error).toBe(false);
    requestOwnershipChatPublish();
    requestOwnershipPublish();
    runOwnershipTickForTests();
    ctrl().transact(() => awareness().set(Y_MAP_OWNERSHIP_CHAT, { forged: true }), CLIENT);
    await settle();

    expect(publishedChatOwners()).toBeUndefined();
    expect(ownershipSummary()).toBeUndefined();
    expect(messageClocksForTests()).toEqual([]);
    expect(awareness().get(Y_MAP_OWNERSHIP_SUMMARY)).toBeUndefined();
    // The forgery stands: nothing guards a key a dark server never writes.
    expect(awareness().get(Y_MAP_OWNERSHIP_CHAT)).toEqual({ forged: true });
    expect(Object.keys(entryIn(CTRL_ROOM, d) ?? {}).sort()).not.toContain("owner");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("each unanswered message's owner facts (ownership design §10.2)", () => {
  it("names its holder, how it is held, and whether Release and Assign apply", async () => {
    const held = mkDoc("held");
    const free = mkDoc("free");
    setDocOwner(held, { ownerId: B, kind: "claimed" }, "take", B);
    // Taken per message by A's poll (doc-less, claimable).
    const mine = userChat(key("mine"));
    await poll(A);
    // Written after A's poll, so it hands none of them.
    const loose = userChat(key("loose"));
    const onHeld = userChat(key("on-held"), held);
    const onFree = userChat(key("on-free"), free);
    const answered = userChat(key("answered"));
    await startPublishing();
    expect((await as(C, "tandem_reply", { text: "done", replyTo: answered })).error).toBe(false);
    await settle();

    const facts = published() ?? {};
    expect(Object.keys(facts).sort()).toEqual([loose, mine, onFree, onHeld].sort());
    const terminal = (owner: string) => ({ label: labelOf(owner), displayKind: "terminal" });
    expect(facts[loose]).toMatchObject({
      owner: null,
      heldBy: "none",
      release: false,
      assign: true,
    });
    expect(facts[mine]).toMatchObject({
      owner: terminal(A),
      heldBy: "message",
      release: true,
      assign: true,
    });
    expect(facts[onHeld]).toMatchObject({
      owner: terminal(B),
      heldBy: "document",
      release: false,
      assign: false,
    });
    expect(facts[onFree]).toMatchObject({
      owner: null,
      heldBy: "document",
      release: false,
      assign: false,
    });

    // Tandem's Claude present: the doc-less message is its, by presence.
    tandemPresent();
    await settle();
    expect(published()?.[loose]).toMatchObject({
      owner: { label: labelOf(TANDEM), displayKind: "Tandem's Claude" },
      heldBy: "presence",
      release: false,
      assign: true,
    });
  });

  it("agrees with the route: Assign is offered unless it would answer follows-document, Release only where it would act", async () => {
    const held = mkDoc("held");
    setDocOwner(held, { ownerId: B, kind: "claimed" }, "take", B);
    const mine = userChat(key("mine"));
    await poll(A);
    const loose = userChat(key("loose"));
    const onHeld = userChat(key("on-held"), held);
    // A carried-over message (the boot's restore brought it back read).
    const carried = key("carried");
    withInternal(ctrl(), () =>
      chatMap().set(carried, {
        id: carried,
        author: "user",
        text: "from before",
        timestamp: Date.now() - 10 * MIN,
        read: true,
      }),
    );
    captureCarriedOverChat(() => [carried]);
    // Present, so §7.1's table would give a doc-less message to Tandem's
    // Claude; a carried-over one is handed to nobody all the same.
    tandemPresent();
    await startPublishing();
    const facts = published() ?? {};
    expect(Object.keys(facts).sort()).toEqual([carried, loose, mine, onHeld].sort());
    expect(facts[carried]).toMatchObject({ owner: null, heldBy: "none", release: false });
    expect(facts[loose]).toMatchObject({ heldBy: "presence" });

    for (const [k, f] of Object.entries(facts)) {
      // An Assign to no such label stops at follows-document or at the label.
      expect(controlMessageOwner(k, "assign", "owner-none") === "follows-document", k).toBe(
        !f.assign,
      );
      if (!f.release) {
        const before = ownershipSnapshotForTests();
        expect(["unchanged", "follows-document"], k).toContain(
          controlMessageOwner(k, "release", undefined),
        );
        expect(ownershipSnapshotForTests(), k).toEqual(before);
      }
    }
    expect(facts[mine]?.release).toBe(true);
    expect(controlMessageOwner(mine, "release", undefined)).toBe("changed");
    await settle();
    // Released from A, it follows §7.1's table again: Tandem's Claude's, by presence.
    expect(published()?.[mine]).toMatchObject({ heldBy: "presence", release: false });
  });

  it("republishes on an open or a close that changes no owner (an unowned document, Tandem's Claude absent)", async () => {
    const d = mkDoc("d");
    const m = userChat(key("m"), d);
    await startPublishing();
    expect(published()?.[m]).toMatchObject({ heldBy: "document", assign: false });
    expect(awareness().get(Y_MAP_OWNERSHIP_SUMMARY)).toMatchObject({ chatWaiting: false });

    // Closed: nobody holds it, claimable on its own, so Assign applies and it
    // counts for the summary's chat waiting, with no tick.
    removeDoc(d);
    broadcastOpenDocs();
    await settle();
    expect(published()?.[m]).toMatchObject({ heldBy: "none", assign: true });
    expect(awareness().get(Y_MAP_OWNERSHIP_SUMMARY)).toMatchObject({ chatWaiting: true });

    // Reopened unowned: it follows its document again.
    mkDoc("d");
    broadcastOpenDocs();
    await settle();
    expect(published()?.[m]).toMatchObject({ heldBy: "document", assign: false });
    expect(awareness().get(Y_MAP_OWNERSHIP_SUMMARY)).toMatchObject({ chatWaiting: false });
  });

  it("carries no owner id, owner handle or session id", async () => {
    const held = mkDoc("held");
    setDocOwner(held, { ownerId: B, kind: "claimed" }, "take", B);
    userChat(key("mine"));
    await poll(A);
    userChat(key("on-held"), held);
    tandemPresent();
    userChat(key("loose"));
    await startPublishing();
    const wire = JSON.stringify(published());
    for (const id of [A, B, C]) expect(wire).not.toContain(id);
    expect(wire).not.toContain('"tandem"');
    expect(wire).toContain(labelOf(A));
  });

  it("is an empty object with nothing unanswered, so a client tells none from ownership off", async () => {
    await startPublishing();
    expect(published()).toEqual({});
  });
});

describe("the pickup and stall clock (ownership design §6.5)", () => {
  it("starts at arrival, holds while the holder holds, and restarts when the holder changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const m = userChat(key("m"), undefined, t0);
    await startPublishing();
    expect(published()?.[m]?.since).toBe(t0);

    vi.setSystemTime(t0 + 3 * MIN);
    await poll(A);
    await settle();
    expect(published()?.[m]?.since, "taken by A: a change of owner").toBe(t0 + 3 * MIN);

    vi.setSystemTime(t0 + 4 * MIN);
    runOwnershipTickForTests();
    expect(published()?.[m]?.since, "the same holder: the clock holds").toBe(t0 + 3 * MIN);
  });

  it("never starts in the future: a row's client-written timestamp later than now starts at now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const m = userChat(key("m"), undefined, t0 + 60 * MIN);
    await startPublishing();
    expect(published()?.[m]?.since).toBe(t0);

    vi.setSystemTime(t0 + 6 * MIN);
    runOwnershipTickForTests();
    expect(published()?.[m]?.stale, "stale five minutes after now, not after its timestamp").toBe(
      true,
    );
  });

  it("restarts at a handover and adopts the new holder without a second restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const m = userChat(key("m"), undefined, t0);
    await startPublishing();
    await poll(A);
    vi.setSystemTime(t0 + 10 * MIN);
    expect(controlMessageOwner(m, "release", undefined)).toBe("changed");
    vi.setSystemTime(t0 + 11 * MIN);
    await settle();
    expect(published()?.[m]?.since).toBe(t0 + 10 * MIN);
    runOwnershipTickForTests();
    expect(published()?.[m]?.since).toBe(t0 + 10 * MIN);
  });

  it("restarts when the document the message follows changes holder, and when presence gives it to Tandem's Claude", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const d = mkDoc("d");
    const onDoc = userChat(key("on-doc"), d, t0);
    const loose = userChat(key("loose"), undefined, t0);
    await startPublishing();
    expect(published()?.[onDoc]?.since).toBe(t0);

    vi.setSystemTime(t0 + 2 * MIN);
    setDocOwner(d, { ownerId: B, kind: "claimed" }, "take", B);
    await settle();
    expect(published()?.[onDoc]?.since).toBe(t0 + 2 * MIN);
    expect(published()?.[loose]?.since, "a doc-less message did not change holder").toBe(t0);

    vi.setSystemTime(t0 + 3 * MIN);
    tandemPresent();
    await settle();
    expect(published()?.[loose]?.since).toBe(t0 + 3 * MIN);
  });

  it("does not show a re-owed message as stale at once (the flip-blocker's case)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const m = userChat(key("m"), undefined, t0);
    await startPublishing();
    await poll(A);
    vi.setSystemTime(t0 + 20 * MIN);
    runOwnershipTickForTests();
    expect(published()?.[m]?.stale, "A has held it for twenty minutes").toBe(true);
    expect(controlMessageOwner(m, "release", undefined)).toBe("changed");
    await settle();
    expect(published()?.[m]).toMatchObject({ since: t0 + 20 * MIN, stale: false });
    vi.setSystemTime(t0 + 20 * MIN + OWNERSHIP_STALE_AFTER_MS + 1);
    runOwnershipTickForTests();
    expect(published()?.[m]?.stale).toBe(true);
  });

  it("forgets the clock of a message once it is answered or deleted", async () => {
    const m = userChat(key("m"));
    const n = userChat(key("n"));
    await startPublishing();
    expect(
      messageClocksForTests()
        .map(([k]) => k)
        .sort(),
    ).toEqual([m, n].sort());
    expect((await as(A, "tandem_reply", { text: "done", replyTo: m })).error).toBe(false);
    withInternal(ctrl(), () => chatMap().delete(n));
    await settle();
    expect(messageClocksForTests()).toEqual([]);
    expect(published()).toEqual({});
  });
});

describe("the composer summary's chat waiting and chat stale (ownership design §10.2)", () => {
  it("counts an unanswered message with no controlling badge, and goes stale five minutes after its last change of owner", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await startPublishing();
    expect(awareness().get(Y_MAP_OWNERSHIP_SUMMARY)).toMatchObject({
      chatWaiting: false,
      chatStale: false,
    });
    const m = userChat(key("m"), undefined, t0);
    await settle();
    expect(awareness().get(Y_MAP_OWNERSHIP_SUMMARY)).toMatchObject({
      chatWaiting: true,
      chatStale: false,
    });
    vi.setSystemTime(t0 + OWNERSHIP_STALE_AFTER_MS + 1);
    runOwnershipTickForTests();
    expect(awareness().get(Y_MAP_OWNERSHIP_SUMMARY)).toMatchObject({
      chatWaiting: true,
      chatStale: true,
    });
    // A final answer ends both.
    expect((await as(A, "tandem_reply", { text: "done", replyTo: m })).error).toBe(false);
    await settle();
    expect(awareness().get(Y_MAP_OWNERSHIP_SUMMARY)).toMatchObject({
      chatWaiting: false,
      chatStale: false,
    });
  });

  it("leaves out chat that follows an open document (its badge's) and anything written before this run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const d = mkDoc("d");
    userChat(key("on-doc"), d, t0);
    // Written before this server run started (Bryan's "Same rule (Recommended)").
    const old = userChat(key("old"), undefined, t0 - 2 * MIN);
    await startPublishing();
    vi.setSystemTime(t0 + 10 * MIN);
    runOwnershipTickForTests();
    expect(awareness().get(Y_MAP_OWNERSHIP_SUMMARY)).toMatchObject({
      chatWaiting: false,
      chatStale: false,
    });
    expect(published()?.[old]?.stale, "never stale: written before boot").toBe(false);
  });
});

describe("a document's waiting time counts the chat that follows it (ownership design §8.5, §10.2)", () => {
  it("raises the unowned hint from chat alone, timed by the message's clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const d = mkDoc("d");
    await startPublishing();
    userChat(key("m"), d, t0);
    await settle();
    // Attached sessions could claim it: the hint waits five minutes.
    expect(entryIn(CTRL_ROOM, d)).toMatchObject({ owner: null, hint: null });
    vi.setSystemTime(t0 + OWNERSHIP_STALE_AFTER_MS + 1);
    runOwnershipTickForTests();
    expect(entryIn(CTRL_ROOM, d)).toMatchObject({ hint: "unowned-waiting", waitingSince: t0 });
    expect(entryIn(d, d)).toMatchObject({ hint: "unowned-waiting", waitingSince: t0 });
  });

  it("restarts with a new holder, reads the holder stale when it does not check in, and clears once it is handed the message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const d = mkDoc("d");
    userChat(key("m"), d, t0);
    await startPublishing();
    vi.setSystemTime(t0 + 10 * MIN);
    setDocOwner(d, { ownerId: B, kind: "claimed" }, "take", B);
    await settle();
    expect(entryIn(CTRL_ROOM, d)).toMatchObject({ stale: null, hint: null });
    vi.setSystemTime(t0 + 10 * MIN + OWNERSHIP_STALE_AFTER_MS + 1);
    runOwnershipTickForTests();
    expect(entryIn(CTRL_ROOM, d)).toMatchObject({ stale: "not-checking-in" });
    await poll(B);
    await settle();
    expect(entryIn(CTRL_ROOM, d)).toMatchObject({ stale: null });
  });

  it("a chat write alone rewrites only the entries whose chat changed", async () => {
    const d = mkDoc("d");
    mkDoc("e");
    await startPublishing();
    const scanned: string[] = [];
    setOldestWaitingProbe((id) => {
      scanned.push(id);
      return oldestDocumentWaiting(id);
    });
    userChat(key("m"), d);
    await settle();
    expect(scanned).toEqual([d]);
    scanned.length = 0;
    userChat(key("loose"));
    await settle();
    expect(scanned, "doc-less chat changes no document's entry").toEqual([]);
  });

  it("coalesces a burst of chat writes into one write of the facts", async () => {
    await startPublishing();
    let writes = 0;
    awareness().observe((event) => {
      if (event.keysChanged.has(Y_MAP_OWNERSHIP_CHAT)) writes++;
    });
    for (let i = 0; i < 20; i++) userChat(key(`burst-${i}`));
    await settle();
    expect(writes).toBe(1);
    expect(Object.keys(published() ?? {})).toHaveLength(20);
    // A republish that changes nothing writes nothing.
    runOwnershipTickForTests();
    requestOwnershipChatPublish();
    await settle();
    expect(writes).toBe(1);
  });

  it("counts a document's chat only while it is owed: handed to its holder, it no longer waits", async () => {
    const d = mkDoc("d");
    tandemPresent();
    setDocOwner(d, { ownerId: TANDEM, kind: "default" }, "presence");
    // Tandem's Claude holds the document and its process is not running.
    setLauncherFactsSource(() => ({ ...FACTS, running: false }));
    await startPublishing();
    userChat(key("m"), d);
    await settle();
    expect(entryIn(CTRL_ROOM, d)).toMatchObject({ hint: "start-to-answer" });
    await poll(TANDEM);
    await settle();
    expect(entryIn(CTRL_ROOM, d)).toMatchObject({ hint: null, waitingSince: null });
  });
});

describe("the guard (ownership design §10.3)", () => {
  it("restores the facts after a client's write, a browser-tagged one and an untagged one, never after a server helper's", async () => {
    const m = userChat(key("m"));
    await startPublishing();
    const truth = published();
    expect(truth?.[m]).toBeDefined();
    const forged = {
      [m]: { ...truth?.[m], owner: { label: "owner-zzzz", displayKind: "Tandem's Claude" } },
    };
    for (const origin of [CLIENT, BROWSER_ORIGIN, null]) {
      ctrl().transact(() => awareness().set(Y_MAP_OWNERSHIP_CHAT, forged), origin);
      expect(published()).toEqual(forged);
      await settle();
      expect(published(), String(origin)).toEqual(truth);
    }
    withInternal(ctrl(), () => awareness().set(Y_MAP_OWNERSHIP_CHAT, forged));
    await settle();
    expect(published(), "a server helper's write is the server's own").toEqual(forged);
  });
});

describe("the CTRL snapshot keeps the published state out", () => {
  it("drops the summary and the facts on save and on restore, and leaves a snapshot without them as it was", async () => {
    const m = userChat(key("m"));
    await startPublishing();
    expect(published()?.[m]).toBeDefined();
    expect(awareness().get(Y_MAP_OWNERSHIP_SUMMARY)).toBeDefined();

    // Saved: neither key reaches the file; the live map keeps both.
    await saveCtrlSession(ctrl());
    const saved = await loadCtrlSession();
    expect(saved).not.toBeNull();
    const fromFile = new Y.Doc();
    Y.applyUpdate(fromFile, Buffer.from(saved as string, "base64"));
    expect(fromFile.getMap(Y_MAP_USER_AWARENESS).has(Y_MAP_OWNERSHIP_CHAT)).toBe(false);
    expect(fromFile.getMap(Y_MAP_USER_AWARENESS).has(Y_MAP_OWNERSHIP_SUMMARY)).toBe(false);
    expect(fromFile.getMap(Y_MAP_CHAT).has(m)).toBe(true);
    expect(published()?.[m]).toBeDefined();

    // Restored from a snapshot a lit build wrote with them: both dropped.
    const lit = new Y.Doc();
    lit.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_OWNERSHIP_CHAT, { [m]: {} });
    lit.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_OWNERSHIP_SUMMARY, { tandemPresent: true });
    const restored = new Y.Doc();
    restoreCtrlDoc(restored, Buffer.from(Y.encodeStateAsUpdate(lit)).toString("base64"));
    expect(restored.getMap(Y_MAP_USER_AWARENESS).has(Y_MAP_OWNERSHIP_CHAT)).toBe(false);
    expect(restored.getMap(Y_MAP_USER_AWARENESS).has(Y_MAP_OWNERSHIP_SUMMARY)).toBe(false);

    // Without them, a restore opens no transaction of its own.
    const plain = new Y.Doc();
    plain.getMap(Y_MAP_CHAT).set("k", { id: "k", author: "user", text: "x", timestamp: 1 });
    const into = new Y.Doc();
    let transactions = 0;
    into.on("afterTransaction", () => transactions++);
    restoreCtrlDoc(into, Buffer.from(Y.encodeStateAsUpdate(plain)).toString("base64"));
    expect(transactions).toBe(1);
    expect(Y.encodeStateAsUpdate(into)).toEqual(Y.encodeStateAsUpdate(plain));
  });
});
