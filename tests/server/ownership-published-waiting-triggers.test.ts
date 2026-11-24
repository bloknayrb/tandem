/**
 * The republish triggers for a document's waiting (#2358 PR 5a-3 review;
 * ADR-054's 5a-3 amendment): the published `hint` and `waitingSince` follow
 * the waiting rule at once, not at the next 60-second tick, when
 *
 * - a waiting-relevant user annotation event lands (a user comment created
 *   or edited, a user reply): the `"internal"` event subscriber asks the
 *   narrow republish of that one document;
 * - the Solo/Tandem mode changes: `noteModeObserved` asks the full one;
 * - a check-in acknowledges items on a document, whoever holds it: the
 *   delivery registry's acknowledgement listener asks that document's narrow
 *   republish.
 *
 * Real pieces throughout: the annotation observers (`attachObservers`) and
 * the `CTRL_ROOM` observers, the real oldest-waiting probe
 * (`oldestDocumentWaiting`), the real registry and ownership module. No
 * tick runs in any test (`startOwnershipPublishing` arms one at 60 s; every
 * assertion is made a few microtasks after the change).
 *
 * Platform: no files; synthetic paths only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { addUserReply } from "../../src/server/annotations/lifecycle.js";
import { broadcastOpenDocs } from "../../src/server/documents/registry.js";
import {
  addDoc,
  removeDoc,
  resetPublished,
  setActiveDocId,
} from "../../src/server/documents/registry-testing.js";
import {
  _pushEventForTests,
  attachCtrlObservers,
  attachObservers,
  detachObservers,
  resetForTesting as resetEventsForTesting,
} from "../../src/server/events/queue.js";
import {
  oldestDocumentWaiting,
  resetInbox,
  setWaitingWrittenSinceForTests,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { CHAT_SCOPE, deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  requestOwnershipPublish,
  startOwnershipPublishing,
  stopOwnershipPublishingForTests,
} from "../../src/server/ownership-publish.js";
import {
  noteRecordPoll,
  noteTransportRegistered,
  resetOwnershipForTests,
  setLauncherFactsSource,
  setOldestWaitingProbe,
  setOwnershipPublishSink,
  setOwnershipTransportMode,
  setTandemPresenceSource,
  setTransportView,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_OPEN_DOCUMENTS,
} from "../../src/shared/constants.js";
import { withBrowser } from "../../src/shared/origins.js";
import { OWNERSHIP_STALE_AFTER_MS } from "../../src/shared/ownership-published.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";

const T = "claude:waiting-trigger-terminal";
const MIN = 60_000;

let view: TransportViewEntry[];
const opened: string[] = [];

const listIn = (room: string) =>
  getOrCreateDocument(room).getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_OPEN_DOCUMENTS) as
    | Array<Record<string, unknown>>
    | undefined;
const entryIn = (room: string, id: string) => listIn(room)?.find((e) => e.id === id);

/** A few microtasks: the coalesced republish runs in one. No timer, no tick. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

function mkDoc(id: string): Y.Doc {
  opened.push(id);
  const ydoc = getOrCreateDocument(id);
  if (ydoc.getXmlFragment("default").length === 0) {
    populateYDoc(ydoc, "Hello world, this is a test document for the waiting triggers.");
  }
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  attachObservers(id, ydoc);
  return ydoc;
}

/** A user comment written as the browser writes one, so the observer emits its event. */
function userComment(ydoc: Y.Doc, id: string, timestamp: number): void {
  withBrowser(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: `text of ${id}`,
      status: "pending",
      timestamp,
      rev: 1,
    }),
  );
}

function wire(flag: "1" | ""): void {
  vi.stubEnv("TANDEM_OWNERSHIP", flag);
  view = [];
  setTransportView(() => view);
  setTandemPresenceSource(() => false);
  setLauncherFactsSource(() => null);
  setOldestWaitingProbe(oldestDocumentWaiting);
  setOwnershipPublishSink(requestOwnershipPublish);
  setOwnershipTransportMode("http");
}

function clearWorld(): void {
  stopOwnershipPublishingForTests();
  resetPublished();
  resetOwnershipForTests();
  resetInbox();
  for (const id of opened) detachObservers(id);
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  for (const id of opened.splice(0)) removeDocument(id);
  removeDocument(CTRL_ROOM);
  resetEventsForTesting();
}

beforeEach(() => {
  clearWorld();
  setWaitingWrittenSinceForTests(undefined);
  wire("1");
  attachCtrlObservers();
  setCtrlMode("tandem");
});

afterEach(() => {
  clearWorld();
  setOwnershipPublishSink(() => {});
  setWaitingWrittenSinceForTests(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a waiting-relevant user annotation event republishes its document at once", () => {
  it("a new user comment on an unowned document with nobody attached publishes unowned-waiting, with no tick", async () => {
    const ydoc = mkDoc("wt-a");
    mkDoc("wt-b");
    broadcastOpenDocs();
    startOwnershipPublishing();
    await microtasks();
    expect(entryIn(CTRL_ROOM, "wt-a")).toMatchObject({ hint: null, waitingSince: null });

    // Count the probe: only the commented document is recomputed.
    const scanned: string[] = [];
    setOldestWaitingProbe((id) => {
      scanned.push(id);
      return oldestDocumentWaiting(id);
    });
    const at = Date.now() - 1000;
    userComment(ydoc, "wt-a-c1", at);
    await microtasks();
    for (const room of [CTRL_ROOM, "wt-a", "wt-b"]) {
      expect(entryIn(room, "wt-a"), room).toMatchObject({
        owner: null,
        hint: "unowned-waiting",
        waitingSince: at,
      });
    }
    expect(scanned, "the narrow republish of that document only").toEqual(["wt-a"]);
  });

  it("a user reply on a Claude-facing thread publishes unowned-waiting, with no tick", async () => {
    const ydoc = mkDoc("wt-r");
    broadcastOpenDocs();
    startOwnershipPublishing();
    withBrowser(ydoc, () =>
      ydoc.getMap(Y_MAP_ANNOTATIONS).set("wt-r-claude", {
        id: "wt-r-claude",
        author: "claude",
        type: "comment",
        audience: "outbound",
        range: { from: 0, to: 5 },
        content: "from Claude",
        status: "pending",
        timestamp: Date.now() - 5000,
        rev: 1,
      }),
    );
    await microtasks();
    expect(entryIn(CTRL_ROOM, "wt-r")).toMatchObject({ hint: null, waitingSince: null });
    const reply = addUserReply(ydoc, "wt-r-claude", "a user reply", () => {});
    expect(reply.kind).toBe("ok");
    await microtasks();
    expect(entryIn(CTRL_ROOM, "wt-r")).toMatchObject({ owner: null, hint: "unowned-waiting" });
    expect(typeof entryIn(CTRL_ROOM, "wt-r")?.waitingSince).toBe("number");
  });

  it("an event the waiting rule does not count asks nothing: a status flip, a Claude reply, chat", async () => {
    mkDoc("wt-c");
    broadcastOpenDocs();
    startOwnershipPublishing();
    await microtasks();
    const scanned: string[] = [];
    setOldestWaitingProbe((id) => {
      scanned.push(id);
      return oldestDocumentWaiting(id);
    });
    const base = { timestamp: Date.now(), documentId: "wt-c" };
    _pushEventForTests({
      ...base,
      id: "ev-wt-accepted",
      type: "annotation:accepted",
      payload: { annotationId: "a1", textSnippet: "x" },
    });
    _pushEventForTests({
      ...base,
      id: "ev-wt-claude-reply",
      type: "annotation:reply",
      payload: {
        annotationId: "a1",
        replyId: "r1",
        replyText: "t",
        replyAuthor: "claude",
        textSnippet: "x",
        parentAuthor: "user",
      },
    });
    _pushEventForTests({
      ...base,
      id: "ev-wt-chat",
      type: "chat:message",
      payload: { messageId: "m1", text: "hello", replyTo: null, anchor: null },
    });
    await microtasks();
    expect(scanned).toEqual([]);
  });
});

describe("a mode change republishes", () => {
  it("Tandem to Solo clears the hint at once, and Solo to Tandem publishes it again", async () => {
    const ydoc = mkDoc("wt-m");
    broadcastOpenDocs();
    startOwnershipPublishing();
    const at = Date.now() - 1000;
    userComment(ydoc, "wt-m-c1", at);
    await microtasks();
    expect(entryIn(CTRL_ROOM, "wt-m")).toMatchObject({ hint: "unowned-waiting", waitingSince: at });

    setCtrlMode("solo");
    await microtasks();
    expect(entryIn(CTRL_ROOM, "wt-m")).toMatchObject({ hint: null, waitingSince: null });

    setCtrlMode("tandem");
    await microtasks();
    expect(entryIn(CTRL_ROOM, "wt-m")).toMatchObject({ hint: "unowned-waiting", waitingSince: at });
  });

  it("a comment made in Solo shows when the mode returns to Tandem, with no tick", async () => {
    const ydoc = mkDoc("wt-s");
    broadcastOpenDocs();
    startOwnershipPublishing();
    setCtrlMode("solo");
    await microtasks();
    const at = Date.now() - 1000;
    // The privacy hold drops its event before any subscriber, and the rule
    // counts nothing in Solo: no hint yet.
    userComment(ydoc, "wt-s-c1", at);
    await microtasks();
    expect(entryIn(CTRL_ROOM, "wt-s")).toMatchObject({ hint: null, waitingSince: null });
    setCtrlMode("tandem");
    await microtasks();
    expect(entryIn(CTRL_ROOM, "wt-s")).toMatchObject({ hint: "unowned-waiting", waitingSince: at });
  });
});

describe("a check-in's acknowledgement republishes the documents it acknowledged items on", () => {
  it("a terminal check-in that acknowledges a claimable unowned document's item clears its hint at once", async () => {
    // T is attached, so the unowned document is claimable: its hint shows
    // only once the item has waited 5 minutes.
    view = [{ ownerId: T, openStreams: 1 }];
    noteTransportRegistered(T, { recordKind: "claude" });
    const ydoc = mkDoc("wt-k");
    mkDoc("wt-other");
    broadcastOpenDocs();
    startOwnershipPublishing();
    const at = Date.now() - OWNERSHIP_STALE_AFTER_MS - MIN;
    userComment(ydoc, "wt-k-c1", at);
    await microtasks();
    expect(entryIn(CTRL_ROOM, "wt-k")).toMatchObject({
      owner: null,
      hint: "unowned-waiting",
      waitingSince: at,
    });

    const scanned: string[] = [];
    setOldestWaitingProbe((id) => {
      scanned.push(id);
      return oldestDocumentWaiting(id);
    });
    // T's check-in: it holds nothing, so `noteRecordPoll` asks nothing; the
    // commit then acknowledges the item, as `teeLegacyCommit` does (register
    // and acknowledge; the ledger key is `awareness.ts`'s `ledgerKey`,
    // `<documentId>:<annotationId>`, for a user comment).
    noteRecordPoll(T);
    deliveryRegistry.markAcked(deliveryRegistry.assign("a", "wt-k", "wt-k:wt-k-c1", 0));
    await microtasks();
    for (const room of [CTRL_ROOM, "wt-k", "wt-other"]) {
      expect(entryIn(room, "wt-k"), room).toMatchObject({ hint: null, waitingSince: null });
    }
    expect(scanned, "only the acknowledged document is recomputed").toEqual(["wt-k"]);

    // A take-back of that acknowledgement (a refused claim's revert) asks
    // again, and the hint returns.
    const entry = deliveryRegistry.lookup("a", "wt-k:wt-k-c1", 0);
    expect(entry).toBeDefined();
    if (entry) deliveryRegistry.unacknowledge(entry);
    await microtasks();
    expect(entryIn(CTRL_ROOM, "wt-k")).toMatchObject({ hint: "unowned-waiting", waitingSince: at });
  });

  it("a chat acknowledgement recomputes no document", async () => {
    mkDoc("wt-chat");
    broadcastOpenDocs();
    startOwnershipPublishing();
    await microtasks();
    const scanned: string[] = [];
    setOldestWaitingProbe((id) => {
      scanned.push(id);
      return oldestDocumentWaiting(id);
    });
    const chat = deliveryRegistry.lookup("c", "wt-chat-row", 0);
    expect(chat).toBeUndefined();
    deliveryRegistry.markAcked(deliveryRegistry.assign("c", CHAT_SCOPE, "wt-chat-row", 0));
    await microtasks();
    expect(scanned).toEqual([]);
  });
});

describe("flag off: nothing is asked", () => {
  it("no subscriber, no acknowledgement listener, no request from a mode change", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const asked: Array<readonly string[] | undefined> = [];
    setOwnershipPublishSink((ids) => asked.push(ids));
    const ydoc = mkDoc("wt-dark");
    broadcastOpenDocs();
    const stop = startOwnershipPublishing();
    await microtasks();
    const exact = listIn(CTRL_ROOM);
    setCtrlMode("solo");
    setCtrlMode("tandem");
    expect(asked, "a dark mode change asks nothing").toEqual([]);

    // Nothing was attached while dark: with the flag on now, a new comment
    // and an acknowledgement still publish nothing, since neither the event
    // subscriber nor the registry's listener exists.
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    const scanned: string[] = [];
    setOldestWaitingProbe((id) => {
      scanned.push(id);
      return oldestDocumentWaiting(id);
    });
    userComment(ydoc, "wt-dark-c1", Date.now() - 1000);
    deliveryRegistry.markAcked(deliveryRegistry.assign("a", "wt-dark", "wt-dark:other", 0));
    await microtasks();
    expect(scanned).toEqual([]);
    expect(listIn(CTRL_ROOM)).toEqual(exact);
    for (const e of listIn(CTRL_ROOM) ?? []) expect(e).not.toHaveProperty("hint");
    stop();
  });
});
