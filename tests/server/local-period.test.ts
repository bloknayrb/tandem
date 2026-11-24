/**
 * Who answers chat, part A2: Claude's side (#1123). Claude is handed nothing
 * while a local model answers Tandem chat, and never local-period chat or
 * local-model activity afterwards.
 *
 * Runs the real switch (`chat-answerer.ts`, against a per-test temp dir), the
 * real event queue and observers, the real `tandem_checkInbox` handler and
 * the real wiring (`local-period-wiring.ts`), with ownership off and on. Each
 * "nothing" has a positive-control twin (the switch at Claude, or Claude's
 * own annotation). Each test names the guard it pins: guard 1 ("in the local
 * period now", `chatAnswerer()`), guard 2 ("honour local-period records", the
 * flag — turned on here through the test seam, since the flag is a literal).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { z } from "zod";

/** #1123 part B, R11.6: refuse AI chat writes for one test. Off by default. */
const refusal = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/server/license/ai-refusal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/license/ai-refusal.js")>();
  return {
    ...actual,
    aiRefusal: () =>
      refusal.on
        ? { error: "LICENSE_REQUIRED" as const, kind: "unlicensed" as const, message: "x" }
        : actual.aiRefusal(),
  };
});

import { setChatClientWritesUndone } from "../../src/server/chat-client-writes.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  getDeliveryState,
  keyedDeliveryRoundsForTests,
  recordWakeForward,
  resetDeliveryStateForTests,
  setDeliveryRoundSeam,
} from "../../src/server/events/delivery-state.js";
import {
  _pushEventForTests,
  ANSWERER_RETURN_WAKE_CONTENT,
  attachCtrlObservers,
  attachObservers,
  emitModeReleaseWake,
  getBufferedSelection,
  replaySince,
  resetForTesting,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import { wireLocalPeriod } from "../../src/server/local-period-wiring.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import {
  LOCAL_PERIOD_STATUS_LINE,
  owedAtSwitchSentence,
  ownershipChatSide,
  registerAwarenessTools,
  resetInbox,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { closeDocumentById, getOpenDocs } from "../../src/server/mcp/document-service.js";
import { snapshotUserChat } from "../../src/server/mcp/greeting-reply.js";
import {
  checkInboxLocalPeriodShape,
  checkInboxOutputShape,
  checkInboxOwnershipShape,
} from "../../src/server/mcp/output-schemas.js";
import {
  resetWakeAdvisoryForTests,
  takeWakeAdvisory,
  WAKE_ADVISORY_TEXT,
} from "../../src/server/mcp/wake-advisory.js";
import {
  __resetChatAnswererForTests,
  chatAnswerer,
  primeChatAnswerer,
  setChatAnswerer,
} from "../../src/server/models/chat-answerer.js";
import {
  __flushLocalModelAnnouncedForTests,
  __resetLocalModelAnnouncedForTests,
} from "../../src/server/models/local-model-announced.js";
import { primeLocalModelSettings } from "../../src/server/models/local-model-settings.js";
import {
  __localPeriodOpenForTests,
  __resetLocalPeriodForTests,
  __setHonourLocalPeriodRecordsForTests,
  bootLocalPeriod,
  DELETED_CLASS_CAP,
  honourLocalPeriodRecords,
  isLocalPeriodChat,
  loadLocalPeriodRecord,
  localPeriodRecordFor,
  recordBootSelections,
  subscribeLocalPeriod,
} from "../../src/server/models/local-period.js";
import { SESSION_DIR } from "../../src/server/platform.js";
import {
  clearCtrlChatDurably,
  loadCtrlSession,
  restoreCtrlDoc,
  saveCtrlSession,
} from "../../src/server/session/manager.js";
import {
  keyedDeliveryRounds,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setOwnershipChatSide,
  setTransportView,
  undoClientChatWrites,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import {
  BYO_MODELS_ENABLED,
  CTRL_ROOM,
  SELECTION_DWELL_MIN_MS,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
  Y_MAP_DWELL_MS,
  Y_MAP_SELECTION,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withBrowser, withInternal, withMcp } from "../../src/shared/origins.js";
import { selectionFingerprint } from "../../src/shared/selection-fingerprint.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";

const inboxSchema = z.object({
  ...checkInboxOutputShape,
  ...checkInboxOwnershipShape,
  ...checkInboxLocalPeriodShape,
});
type Inbox = z.infer<typeof inboxSchema>;

const LOCAL_ID = { displayName: "Local Model", modelId: "m" };

let client: Client;
let close: (() => Promise<void>) | undefined;
let dir = "";
let external: TandemEvent[] = [];
let internal: TandemEvent[] = [];
const extCb = (e: TandemEvent) => external.push(e);
const intCb = (e: TandemEvent) => internal.push(e);
let run = 0;
let doc: { id: string; ydoc: Y.Doc };

const ctrlChat = () => getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT);

function userChat(id: string, text = `text of ${id}`, documentId?: string): void {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withBrowser(ctrl, () =>
    ctrl.getMap(Y_MAP_CHAT).set(id, {
      id,
      author: "user",
      text,
      timestamp: Date.now(),
      ...(documentId ? { documentId } : {}),
    }),
  );
}

function claudeReply(id: string, replyTo: string): void {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () =>
    ctrl
      .getMap(Y_MAP_CHAT)
      .set(id, { id, author: "claude", text: "ok", timestamp: Date.now(), replyTo }),
  );
}

function annotation(id: string, extra: Record<string, unknown> = {}): void {
  withBrowser(doc.ydoc, () =>
    doc.ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: `text of ${id}`,
      status: "pending",
      timestamp: 1000,
      rev: 1,
      ...extra,
    }),
  );
}

function setStatus(id: string, status: "accepted" | "dismissed"): void {
  const map = doc.ydoc.getMap(Y_MAP_ANNOTATIONS);
  const cur = map.get(id) as Record<string, unknown>;
  withBrowser(doc.ydoc, () => map.set(id, { ...cur, status }));
}

function userReplyOn(annotationId: string, id: string): void {
  withBrowser(doc.ydoc, () =>
    doc.ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set(id, {
      id,
      annotationId,
      author: "user",
      text: `text of ${id}`,
      timestamp: 2000,
    }),
  );
}

/** The user's selection record as the editor writes it: flat offsets, the
 *  #1991 stamp and #1997's fingerprint of the flat slice. */
function select(stamp: number, from = 0, to = 5): void {
  const flat = extractText(doc.ydoc).slice(from, to);
  withBrowser(doc.ydoc, () =>
    doc.ydoc.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_SELECTION, {
      from,
      to,
      selectedText: flat,
      timestamp: stamp,
      textFingerprint: selectionFingerprint(flat),
    }),
  );
}

/** Wait out the selection dwell (set to its minimum in `beforeEach`). */
const dwell = () => new Promise((r) => setTimeout(r, SELECTION_DWELL_MIN_MS + 150));

/** The selection a chat message's push carried. The push itself must exist
 *  (round-2 item 5): a dropped event would otherwise read as "no selection". */
const pushedSelection = (id: string) => {
  const event = external.find(
    (e) => e.type === "chat:message" && (e.payload as { messageId?: string }).messageId === id,
  );
  expect(event, `the chat push for ${id}`).toBeDefined();
  return (event?.payload as { selection?: { selectedText?: string } }).selection;
};

async function poll(args: Record<string, unknown> = {}): Promise<Inbox> {
  const result = await client.callTool({ name: "tandem_checkInbox", arguments: args });
  expect(parseResult(result).error, JSON.stringify(result)).toBe(false);
  return inboxSchema.parse((result as { structuredContent: unknown }).structuredContent);
}

async function toLocal(source: "own-window" | "allowance" = "own-window"): Promise<void> {
  await setChatAnswerer("local", source);
  await __flushLocalModelAnnouncedForTests();
  expect(chatAnswerer()).toBe("local");
}

async function toClaude(source: "own-window" | "allowance" = "own-window"): Promise<void> {
  await setChatAnswerer("claude", source);
  await __flushLocalModelAnnouncedForTests();
  expect(chatAnswerer()).toBe("claude");
}

const chatIds = (inbox: Inbox) => inbox.chatMessages.map((m) => m.id).sort();
/** #1123 part B, R11: the switch-back lines in chat. */
const switchBackLines = () =>
  [...ctrlChat().values()].filter(
    (m) => (m as { chatNotice?: string }).chatNotice === "claude-again",
  ) as Array<{
    text: string;
    author: string;
    chatNotice?: string;
    replyTo?: string;
    documentId?: string;
    agentIdentity?: unknown;
  }>;

/**
 * The chat owners PR's (#2358) changes to the flag-on `tandem_checkInbox`
 * output schema, as JSON-encoded text in master's frozen dump: each `before`
 * occurs exactly once and becomes `after`.
 */
const CHAT_OWNERS_SCHEMA_CHANGES: ReadonlyArray<readonly [string, string]> = [
  [
    "(chat is shown for every document, so a chat message, or anything Tandem pushed to you, may still be about one)",
    "(a chat message you answer can still be about one of them, and so can anything Tandem pushed to you)",
  ],
  [
    '"a poll of yours claimed it",',
    '"a poll of yours claimed it",\n                                    "a chat reply of yours claimed it",',
  ],
  [
    '\\"a poll of yours claimed it\\": a tandem_checkInbox poll of yours claimed it; ',
    '\\"a poll of yours claimed it\\": a tandem_checkInbox poll of yours claimed it; \\"a chat reply of yours claimed it\\": a tandem_reply of yours to a chat message about it claimed it; ',
  ],
  [
    "an open or create of yours (tandem_open, tandem_scratchpad) made it yours",
    "an open or create of yours (tandem_open, tandem_scratchpad, or tandem_convertToMarkdown where Tandem offers it) made it yours",
  ],
  [
    "to which documents this session held, since the last poll that returned them.",
    "to which documents this session held, that no poll of this session that returned has reported yet.",
  ],
];

/**
 * #2358's posts PR's changes to the flag-on schema, applied after the chat
 * owners PR's: one new cause word, in the enum and in the cause description.
 */
const POSTS_SCHEMA_CHANGES: ReadonlyArray<readonly [string, string]> = [
  [
    '"a chat reply of yours claimed it",',
    '"a chat reply of yours claimed it",\n                                    "a chat post of yours claimed it",',
  ],
  [
    '\\"a chat reply of yours claimed it\\": a tandem_reply of yours to a chat message about it claimed it; ',
    '\\"a chat reply of yours claimed it\\": a tandem_reply of yours to a chat message about it claimed it; \\"a chat post of yours claimed it\\": a tandem_reply of yours that named no chat message (no replyTo, or one that matched none) and passed this document\'s documentId claimed it; ',
  ],
];

/**
 * #2358 PR 3b-2b4b's change to the flag-on schema: `notYours`'s description
 * gains the take-back sentence (Bryan, 2026-11-23: "Yes; tell it it was
 * taken back (Recommended)").
 */
const TAKE_BACK_SCHEMA_CHANGES: ReadonlyArray<readonly [string, string]> = [
  [
    'An item Tandem handed or pushed to you is not such a request."',
    "An item Tandem handed or pushed to you is not such a request. If Tandem's Claude took one back from you, or the user released it from you (the summary says so), an earlier request from the user does not count: call tandem_open on it only if the user asks you again after that.\"",
  ],
];

/**
 * #2358 PR 3b-2b4c's change to the flag-on schema: one new cause word, a
 * terminal's loss to Tandem's Claude, in the enum and in the cause
 * description.
 */
const TAKE_BACK_CAUSE_SCHEMA_CHANGES: ReadonlyArray<readonly [string, string]> = [
  [
    '"Tandem stopped counting this session as attached"\n',
    '"Tandem stopped counting this session as attached",\n"Tandem\'s Claude took it back"\n',
  ],
  [
    'and this session stopped holding it"',
    'and this session stopped holding it; \\"Tandem\'s Claude took it back\\": Tandem\'s Claude took it from this session, when a run of it started or when it opened the document"',
  ],
];

/**
 * #2358 PR 5a's change to the flag-on schema: three new cause words, Release
 * and Assign's, in the enum and in the cause description.
 */
const RELEASE_ASSIGN_CAUSE_SCHEMA_CHANGES: ReadonlyArray<readonly [string, string]> = [
  [
    '"Tandem\'s Claude took it back"\n',
    '"Tandem\'s Claude took it back",\n"it was released",\n"it was assigned to another session",\n"it was assigned to this session"\n',
  ],
  [
    'when a run of it started or when it opened the document"',
    'when a run of it started or when it opened the document; \\"it was released\\": it was released from this session; \\"it was assigned to another session\\": it was assigned to another session; \\"it was assigned to this session\\": it was assigned to this session"',
  ],
];

/** The chat owners PR's second session, and who the next tool call runs as. */
const LP_OTHER = "claude:lp-other";
let lpCaller = "test:caller";
const wakes = () =>
  external.filter(
    (e) =>
      e.type === "annotation:created" &&
      (e.payload as { content?: string }).content === ANSWERER_RETURN_WAKE_CONTENT,
  );

for (const ownership of ["", "1"] as const) {
  describe(`local period (ownership ${ownership ? "on" : "off"})`, () => {
    beforeEach(async () => {
      // Literal stubs, so the ownership seam's reviewed sets can see both.
      if (ownership === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
      else vi.stubEnv("TANDEM_OWNERSHIP", "");
      vi.spyOn(console, "error").mockImplementation(() => {});
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-local-period-"));
      run++;
      resetForTesting();
      resetDeliveryStateForTests();
      resetInbox();
      resetOwnershipForTests();
      lpCaller = "test:caller";
      // A second session, for the chat owners PR's cases (R7): its polls show
      // who else is handed what. Flag off it records nothing.
      setTransportView(() => [
        { ownerId: "test:caller", openStreams: 0 },
        { ownerId: LP_OTHER, openStreams: 0 },
      ]);
      noteTransportRegistered("test:caller", { recordKind: "claude" });
      noteTransportRegistered(LP_OTHER, { recordKind: "claude" });
      setOwnershipChatSide(ownershipChatSide);
      // The delivery-rounds PR: the round seam as `index.ts` wires it, so the
      // ownership-on block runs keyed rounds (R4.2) and the off block master's.
      setDeliveryRoundSeam({
        keyed: keyedDeliveryRounds,
        isDocumentOpen: (id) => getOpenDocs().has(id),
      });
      resetWakeAdvisoryForTests();
      __resetLocalPeriodForTests();
      __setHonourLocalPeriodRecordsForTests(true);
      __resetLocalModelAnnouncedForTests(dir);
      __resetChatAnswererForTests(dir);
      fs.writeFileSync(path.join(dir, "local-model-baseline.json"), '{"version":1}\n');
      primeLocalModelSettings();
      primeChatAnswerer();
      const ctrl = getOrCreateDocument(CTRL_ROOM);
      withInternal(ctrl, () => {
        ctrl.getMap(Y_MAP_CHAT).clear();
        ctrl.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_DWELL_MS, SELECTION_DWELL_MIN_MS);
      });
      setCtrlMode("tandem");
      attachCtrlObservers();
      const id = `lp${run}`;
      const ydoc = getOrCreateDocument(id);
      populateYDoc(ydoc, "Hello world, this is a test document.");
      addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
      setActiveDocId(id);
      doc = { id, ydoc };
      attachObservers(id, ydoc);
      wireLocalPeriod();
      external = [];
      internal = [];
      subscribe(extCb, "external");
      subscribe(intCb, "internal");
      ({ client, close } = await setupMcpServer(
        [registerAwarenessTools, registerDocumentTools, registerAnnotationTools],
        { dispatch: (fn) => asTestCaller(fn, { ownerId: lpCaller }) },
      ));
    });

    afterEach(async () => {
      setDeliveryRoundSeam(undefined);
      await close?.();
      close = undefined;
      unsubscribe(extCb);
      unsubscribe(intCb);
      for (const [id] of [...getOpenDocs()]) removeDoc(id);
      await __flushLocalModelAnnouncedForTests();
      __resetLocalPeriodForTests();
      __setHonourLocalPeriodRecordsForTests(null);
      __resetChatAnswererForTests();
      resetForTesting();
      resetOwnershipForTests();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fs.promises.rm(dir, { recursive: true, force: true });
    });

    if (ownership === "1") {
      describe("ownership on: chat owners (the chat owners PR, R7)", () => {
        const as = async <T>(who: string, fn: () => Promise<T>): Promise<T> => {
          lpCaller = who;
          try {
            return await fn();
          } finally {
            lpCaller = "test:caller";
          }
        };

        it("a blanked poll sets no owner and claims nothing while a claimable doc-less message and an unowned document with a comment exist", async () => {
          // Both added BEFORE the switch (review round 1, item 1): a row added
          // during the period is local-period chat and never claimable, so
          // only a pre-switch row tests the blanked poll. The active document
          // is open and nobody holds it.
          userChat("waiting-claimable");
          annotation("c-claimable");
          await toLocal();
          const before = ownershipSnapshotForTests();
          expect(before.ownerByDoc).toEqual([]);
          for (const cursor of ["start", undefined]) {
            const inbox = await poll(cursor ? { cursor } : {});
            expect(inbox.chatMessages).toEqual([]);
            expect(inbox.userActions).toEqual([]);
          }
          const after = ownershipSnapshotForTests();
          expect(after.messageOwners).toEqual(before.messageOwners);
          expect(after.ownerByDoc).toEqual([]);
          expect(after.handed).toEqual(before.handed);
          // The positive twin: the same poll after the switch back claims the
          // document and takes the message, so the fixture can fail.
          await toClaude();
          const back = await poll({ cursor: "start" });
          expect(chatIds(back)).toEqual(["waiting-claimable"]);
          expect(back.userActions.map((a) => a.id)).toEqual(["c-claimable"]);
          const claimed = ownershipSnapshotForTests();
          expect(claimed.ownerByDoc.map(([id, e]) => [id, e.ownerId])).toEqual([
            [doc.id, "test:caller"],
          ]);
          expect(claimed.messageOwners.map(([key]) => key)).toEqual(["waiting-claimable"]);
        });

        it("a local-period row is handed to nobody across the switch back, and Claude's reply to it is refused", async () => {
          await toLocal();
          userChat("during-lp");
          await toClaude();
          for (const who of ["test:caller", LP_OTHER]) {
            expect(chatIds(await as(who, () => poll({ cursor: "start" }))), who).toEqual([]);
            expect(chatIds(await as(who, () => poll())), who).toEqual([]);
          }
          const refused = parseResult(
            await client.callTool({
              name: "tandem_reply",
              arguments: { text: "hi", replyTo: "during-lp" },
            }),
          );
          expect(refused.error).toBe(true);
          expect(ownershipSnapshotForTests().messageOwners).toEqual([]);
        });

        it("a pre-switch message the caller owned and had not answered is handed to it after the switch back, and to no one else", async () => {
          userChat("pre-owned");
          // The caller's cursor poll hands it (and makes the caller its owner);
          // that cursor is never passed back.
          expect(chatIds(await poll({ cursor: "start" }))).toEqual(["pre-owned"]);
          expect(
            ownershipSnapshotForTests().messageOwners.map(([key, o]) => [key, o.ownerId]),
          ).toEqual([["pre-owned", "test:caller"]]);
          await toLocal();
          await toClaude();
          // The other session polls first (review round 1, item 12), so it is
          // not passing only because the owner's poll got there before it.
          const other = await as(LP_OTHER, () => poll({ cursor: "start" }));
          expect(chatIds(other)).toEqual([]);
          expect(chatIds(await as(LP_OTHER, () => poll()))).toEqual([]);
          expect(chatIds(await poll({ cursor: "start" }))).toEqual(["pre-owned"]);
        });
      });
    }

    describe("during the local period (guard 1)", () => {
      it("a poll returns the constant status line and field, nothing else, and the cursor as passed", async () => {
        userChat("pre");
        annotation("c-pre");
        await toLocal();
        userChat("during");
        annotation("c-during");
        for (const cursor of [undefined, "start", "not-a-cursor"]) {
          const inbox = await poll(cursor === undefined ? {} : { cursor });
          expect(inbox.summary).toBe(LOCAL_PERIOD_STATUS_LINE);
          expect(inbox.localModelAnswersChat).toBe(true);
          expect(inbox.hasNew).toBe(false);
          expect(inbox.chatMessages).toEqual([]);
          expect(inbox.userActions).toEqual([]);
          expect(inbox.userResponses).toEqual([]);
          expect(inbox.userReplies).toEqual([]);
          expect(inbox.activity.selectedText).toBeNull();
          expect(inbox.ownership).toBeUndefined();
          expect(inbox.cursor).toBe("start");
          expect(inbox.mode).toBe("tandem");
          expect(inbox.storeReadOnly).toBe(false);
        }
        // Everything owed stays owed: nothing was stamped read.
        expect((ctrlChat().get("pre") as { read?: boolean }).read).toBeUndefined();
      });

      it("the status line never tells Claude to arm a watch or where to reply", () => {
        expect(LOCAL_PERIOD_STATUS_LINE).not.toMatch(
          /\barm\b|Monitor|tandem_reply|reply|curl|ws:/i,
        );
        expect(LOCAL_PERIOD_STATUS_LINE).toMatch(/leave it running/);
      });

      it("nothing reaches an external consumer for chat, a comment, a reply, a notice, or a Solo release; internal subscribers still receive", async () => {
        annotation("mine", { author: "claude", type: "comment" });
        await toLocal();
        external = [];
        internal = [];
        userChat("during");
        annotation("c-during");
        userReplyOn("mine", "r-during");
        setStatus("mine", "accepted");
        emitModeReleaseWake();
        expect(external).toEqual([]);
        expect(internal.map((e) => e.type)).toContain("chat:message");
      });

      it("positive twin (round-2 item 12): the same five, with no local period, each reach the external consumer", async () => {
        annotation("mine", { author: "claude", type: "comment" });
        external = [];
        userChat("plain");
        annotation("c-plain");
        userReplyOn("mine", "r-plain");
        setStatus("mine", "accepted");
        emitModeReleaseWake();
        expect(external.map((e) => e.type)).toEqual([
          "chat:message",
          "annotation:created",
          "annotation:reply",
          "annotation:accepted",
          "annotation:created", // the Solo release wake
        ]);
      });

      it("a replay with any Last-Event-ID yields nothing", async () => {
        userChat("pre");
        await toLocal();
        userChat("during");
        expect(replaySince("unknown-id")).toEqual([]);
        expect(replaySince(internal[0]?.id ?? "x")).toEqual([]);
      });

      it("no wake advisory on any tool result, and the latch is not spent", async () => {
        await toLocal();
        expect(takeWakeAdvisory(0)).toBeNull();
        await toClaude();
        expect(takeWakeAdvisory(0)).toBe(WAKE_ADVISORY_TEXT);
      });

      // The delivery-rounds PR (R4.2; review round 1, item 6): keyed rounds
      // through the real local-period wiring and a real tab close, flag on.
      // Registered in the ownership-on block only (this loop stubs the flag
      // per block, so it always runs there; not keyed on the job's flag).
      if (ownership === "1") {
        it("keyed: a document round and a message round, a real switch to local (idle), a blank poll closes nothing, the tab closes, an own-window switch back discards the rest and its wake opens one key-less round the next poll closes", async () => {
          annotation("lp-c1");
          userChat("lp-m1", "hello", doc.id);
          const kinds = () =>
            keyedDeliveryRoundsForTests()
              .map((r) => r.kind)
              .sort();
          expect(kinds()).toEqual(["document", "message"]);
          await toLocal();
          // User chat during the period, so the switch back writes #2433's
          // line (the keyed-rounds suites PR, R3.2).
          userChat("lp-m2", "during the period");
          expect(getDeliveryState(Date.now(), 1)).toMatchObject({
            state: "idle",
            latencyMs: null,
            waitingMs: null,
          });
          await poll(); // the local period's blank poll
          expect(kinds(), "the blank poll closed nothing").toEqual(["document", "message"]);
          const closed = await closeDocumentById(doc.id);
          expect(closed.success).toBe(true);
          expect(kinds(), "the close dropped the document's round").toEqual(["message"]);
          const forwardsBefore = getDeliveryState(Date.now(), 1).forwardCount;
          await toClaude("own-window");
          // The switch back discarded the message round; its wake opened one key-less round.
          expect(kinds()).toEqual(["keyless"]);
          // The order at the switch back is discard, line, wake
          // (`local-period.ts`), so "rounds unchanged across the line" would
          // compare empty with empty. Instead: the line was written; exactly
          // one forward happened across the switch back (a forward of the
          // line would be a second, even one that joined the wake's key-less
          // round in the same millisecond); and the one round left was opened
          // no earlier than the wake. A line pushed as keyed chat would also
          // show as a "message" round.
          expect(switchBackLines()).toHaveLength(1);
          expect(getDeliveryState(Date.now(), 1).forwardCount).toBe(forwardsBefore + 1);
          const wake = wakes().at(-1);
          expect(wake).toBeDefined();
          const rounds = keyedDeliveryRoundsForTests();
          expect(rounds).toHaveLength(1);
          expect(rounds[0]?.kind).toBe("keyless");
          expect(rounds[0]?.forwardedAt).toBeGreaterThanOrEqual(wake?.timestamp as number);
          expect(getDeliveryState(Date.now(), 1).state).toBe("awaiting-poll");
          await poll();
          expect(kinds()).toEqual([]);
          expect(getDeliveryState(Date.now(), 1).state).toBe("polled");
        });
      }

      it("a round open at the switch is suspended: no awaiting-poll, no latency; discarded at the switch back", async () => {
        recordWakeForward(Date.now() - 1000);
        expect(getDeliveryState(Date.now(), 1).state).toBe("awaiting-poll");
        await toLocal();
        expect(getDeliveryState(Date.now(), 1).state).not.toBe("awaiting-poll");
        expect(getDeliveryState(Date.now(), 1).latencyMs).toBeNull();
        await poll();
        await toClaude("allowance");
        const after = getDeliveryState(Date.now(), 1);
        expect(after.state).not.toBe("awaiting-poll");
        expect(after.latencyMs).toBeNull();
      });
    });

    describe("after the user's switch back (guard 2)", () => {
      it("exactly one wake; the poll hands pre-switch chat with its sentence, the period's comments, and never local-period chat", async () => {
        userChat("pre");
        await toLocal();
        userChat("during");
        annotation("c-during");
        external = [];
        await toClaude();
        expect(wakes()).toHaveLength(1);
        const inbox = await poll();
        expect(chatIds(inbox)).toEqual(["pre"]);
        expect(inbox.summary).toContain(owedAtSwitchSentence(["pre"]));
        expect(inbox.summary).not.toContain("..");
        expect(inbox.userActions.map((a) => a.id)).toEqual(["c-during"]);
        expect(inbox.localModelAnswersChat).toBeUndefined();
        // A cursor reader is not handed it either.
        expect(chatIds(await poll({ cursor: "start" }))).toEqual([]);
      });

      it("a poll with no owed-at-switch chat carries no sentence", async () => {
        await toLocal();
        await toClaude();
        userChat("after");
        const inbox = await poll();
        expect(chatIds(inbox)).toEqual(["after"]);
        expect(inbox.summary).not.toContain("switched to a local model");
      });

      it("chat Claude already answered is not owed at the switch", async () => {
        userChat("answered");
        claudeReply("cr", "answered");
        userChat("pending");
        await toLocal();
        await toClaude();
        const inbox = await poll({ cursor: "start" });
        expect(chatIds(inbox)).toEqual(["pending"]);
        expect(inbox.summary).toContain(owedAtSwitchSentence(["pending"]));
      });

      it("a replay from before the period yields no local-period event and no local-model activity", async () => {
        userChat("pre");
        const before = external[external.length - 1].id;
        annotation("lm", { author: "claude", agentIdentity: LOCAL_ID });
        await toLocal();
        userChat("during");
        await toClaude();
        setStatus("lm", "accepted");
        const replayed = replaySince(before);
        expect(
          replayed.some((e) => (e.payload as { messageId?: string }).messageId === "during"),
        ).toBe(false);
        expect(replayed.some((e) => e.type === "annotation:accepted")).toBe(false);
        // Positive control: the wake itself replays.
        expect(replayed.some((e) => e.type === "annotation:created")).toBe(true);
      });

      it("a same-key re-add of a local-period row is not pushed and not handed", async () => {
        await toLocal();
        userChat("during");
        await toClaude();
        const ctrl = getOrCreateDocument(CTRL_ROOM);
        withBrowser(ctrl, () => ctrl.getMap(Y_MAP_CHAT).delete("during"));
        external = [];
        userChat("during", "edited text");
        expect(external.filter((e) => e.type === "chat:message")).toEqual([]);
        expect(chatIds(await poll())).toEqual([]);
        expect(isLocalPeriodChat("during")).toBe(true);
      });

      it("a client edit or a server rewrite of a local-period row never re-classes it", async () => {
        await toLocal();
        userChat("during");
        await toClaude();
        const ctrl = getOrCreateDocument(CTRL_ROOM);
        const row = ctrl.getMap(Y_MAP_CHAT).get("during") as Record<string, unknown>;
        withBrowser(ctrl, () =>
          ctrl.getMap(Y_MAP_CHAT).set("during", { ...row, timestamp: 0, text: "stripped" }),
        );
        withInternal(ctrl, () =>
          ctrl.getMap(Y_MAP_CHAT).set("during", { ...row, read: true, localRun: "x" }),
        );
        expect(chatIds(await poll())).toEqual([]);
      });

      it("local-model activity is never pushed or handed; a reply on Claude's own annotation is, even where the local model also replied", async () => {
        annotation("lm", { author: "claude", agentIdentity: LOCAL_ID });
        annotation("cl", { author: "claude" });
        await toLocal();
        await toClaude();
        external = [];
        setStatus("lm", "accepted");
        setStatus("cl", "dismissed");
        userReplyOn("lm", "r-lm");
        withInternal(doc.ydoc, () =>
          doc.ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("lm-reply", {
            id: "lm-reply",
            annotationId: "cl",
            author: "claude",
            text: "local says",
            timestamp: 1500,
            agentIdentity: LOCAL_ID,
          }),
        );
        userReplyOn("cl", "r-cl");
        const types = external.map((e) => `${e.type}:${JSON.stringify(e.payload).slice(0, 40)}`);
        expect(external.some((e) => e.type === "annotation:accepted")).toBe(false);
        expect(external.some((e) => e.type === "annotation:dismissed")).toBe(true);
        expect(
          external
            .filter((e) => e.type === "annotation:reply")
            .map((e) => (e.payload as { replyId: string }).replyId),
          types.join("\n"),
        ).toEqual(["r-cl"]);
        const inbox = await poll();
        expect(inbox.userResponses.map((r) => r.id)).toEqual(["cl"]);
        expect(inbox.userReplies.map((r) => r.id)).toEqual(["r-cl"]);
      });
    });

    describe("other switches", () => {
      it("a runtime unasked switch back wakes nothing", async () => {
        userChat("pre");
        await toLocal();
        external = [];
        await toClaude("allowance");
        expect(wakes()).toHaveLength(0);
        expect(chatIds(await poll())).toEqual(["pre"]);
      });

      it("a switch back while in Solo: the wake is dropped", async () => {
        await toLocal();
        setCtrlMode("solo");
        external = [];
        await toClaude();
        expect(wakes()).toHaveLength(0);
      });

      it("two local periods: a period-1 chat is never handed after period 2, and never carries the sentence", async () => {
        await toLocal();
        userChat("p1");
        await toClaude();
        userChat("between");
        await toLocal();
        await toClaude();
        const inbox = await poll();
        expect(chatIds(inbox)).toEqual(["between"]);
        expect(inbox.summary).toContain(owedAtSwitchSentence(["between"]));
        expect(inbox.summary).not.toContain("p1");
      });

      it("positive control: with no local period, chat is handed and pushed as on master", async () => {
        userChat("plain");
        expect(external.filter((e) => e.type === "chat:message")).toHaveLength(1);
        expect(chatIds(await poll())).toEqual(["plain"]);
      });
    });

    describe("the switch-back line (#1123 part B, R11)", () => {
      const LINE = "Claude was not sent the chat from while chat was set to your local model.";

      it("an own switch back after a period with user chat writes exactly one line: text, kind and fields", async () => {
        await toLocal();
        userChat("during");
        await toClaude();
        const lines = switchBackLines();
        expect(lines).toHaveLength(1);
        const [line] = lines;
        expect(line.text).toBe(LINE);
        expect(line.author).toBe("claude");
        expect(line.chatNotice).toBe("claude-again");
        expect(line.replyTo).toBeUndefined();
        expect(line.documentId).toBeUndefined();
        expect(line.agentIdentity).toBeUndefined();
      });

      it("after a period with no chat: no line", async () => {
        await toLocal();
        await toClaude();
        expect(switchBackLines()).toHaveLength(0);
      });

      it("Claude's own rows in the period do not count as chat", async () => {
        userChat("pre");
        await toLocal();
        claudeReply("late", "pre");
        await toClaude();
        expect(switchBackLines()).toHaveLength(0);
      });

      it("an unasked switch back: no line", async () => {
        await toLocal();
        userChat("during");
        await toClaude("allowance");
        expect(switchBackLines()).toHaveLength(0);
      });

      it("period 1 with chat, an unasked switch back, period 2 with none, then an own switch back: no line", async () => {
        await toLocal();
        userChat("p1");
        await toClaude("allowance");
        await toLocal();
        await toClaude();
        expect(switchBackLines()).toHaveLength(0);
      });

      it("once per own switch back: two periods with chat write two lines, one each", async () => {
        await toLocal();
        userChat("p1");
        await toClaude();
        await toLocal();
        userChat("p2");
        await toClaude();
        expect(switchBackLines()).toHaveLength(2);
      });

      it("under a licence refusal the append is refused: no line", async () => {
        await toLocal();
        userChat("during");
        refusal.on = true;
        try {
          await toClaude();
        } finally {
          refusal.on = false;
        }
        expect(switchBackLines()).toHaveLength(0);
      });

      it("is in no tandem_checkInbox result and answers nothing: the pre-switch row is still handed", async () => {
        userChat("pre");
        await toLocal();
        userChat("during");
        await toClaude();
        expect(switchBackLines()).toHaveLength(1);
        const inbox = await poll();
        expect(chatIds(inbox)).toEqual(["pre"]);
        expect(JSON.stringify(inbox)).not.toContain(LINE);
        // Still owed on the next poll as well: the line answered nothing.
        expect(JSON.stringify(await poll())).not.toContain(LINE);
      });

      if (ownership === "1") {
        // #2433's carried Low: a chat row written by the editor itself — a
        // Hocuspocus connection's update, `{ socketId }` as its origin — with
        // the client-write undo wired as `src/server/index.ts` wires it.
        describe("a client-origin chat write in the local period", () => {
          beforeEach(() => setChatClientWritesUndone(undoClientChatWrites));
          afterEach(() => setChatClientWritesUndone(undefined));

          /** Apply `rows` to CTRL's chat as a browser tab's update does. */
          function clientWrites(rows: Record<string, unknown>[]): void {
            const ctrl = getOrCreateDocument(CTRL_ROOM);
            const scratch = new Y.Doc();
            Y.applyUpdate(scratch, Y.encodeStateAsUpdate(ctrl));
            const sv = Y.encodeStateVector(scratch);
            for (const row of rows) scratch.getMap(Y_MAP_CHAT).set(row.id as string, row);
            Y.applyUpdate(ctrl, Y.encodeStateAsUpdate(scratch, sv), { socketId: "a-tab" });
            scratch.destroy();
          }

          /** Only the fields `useChatState`'s `send` writes. */
          const sent = (id: string) => ({
            id,
            author: "user",
            text: `text of ${id}`,
            timestamp: 1000,
            read: false,
          });

          it("the editor's own row is kept, classed local-period, and the switch back writes the line", async () => {
            await toLocal();
            clientWrites([sent("tab-row")]);
            expect(ctrlChat().get("tab-row")).toEqual(sent("tab-row"));
            expect(isLocalPeriodChat("tab-row")).toBe(true);
            await toClaude();
            const lines = switchBackLines();
            expect(lines).toHaveLength(1);
            expect(lines[0].text).toBe(LINE);
          });

          it("a server-only field or a fixed field's other value is rewritten; a non-user row is deleted", async () => {
            await toLocal();
            clientWrites([
              { ...sent("with-delivered"), delivered: true },
              { ...sent("read-true"), read: true },
              { id: "not-user", author: "claude", text: "x", timestamp: 1000 },
            ]);
            expect(ctrlChat().get("with-delivered")).toEqual(sent("with-delivered"));
            expect(ctrlChat().get("read-true")).toEqual(sent("read-true"));
            expect(ctrlChat().has("not-user")).toBe(false);
            // The rewritten rows are still the user's local-period chat; the
            // deleted one is not classed at all.
            expect(isLocalPeriodChat("with-delivered")).toBe(true);
            expect(isLocalPeriodChat("read-true")).toBe(true);
            expect(isLocalPeriodChat("not-user")).toBe(false);
          });
        });
      }
    });

    describe("the selection hold (decision 11, guard 2)", () => {
      it("a selection made during the period is in neither activity nor the next chat push; a new one after the switch back is, in both", async () => {
        await toLocal();
        select(111);
        await dwell();
        await toClaude();
        external = [];
        userChat("after", "x", doc.id);
        expect(pushedSelection("after")).toBeUndefined();
        expect((await poll()).activity.selectedText).toBeNull();
        // The positive twin: the user selects again.
        select(222);
        await dwell();
        userChat("after2", "x", doc.id);
        expect(pushedSelection("after2")?.selectedText).toBe("Hello");
        const inbox = await poll();
        expect(inbox.activity.selectedText).toBe("Hello");
        expect(inbox.activity.selectionAt).toBe(222);
      });

      it("a held selection remapped as the editor does after an edit above it, and after one inside it (same stamp, new range): still held, in activity and on the push", async () => {
        await toLocal();
        select(111, 6, 11); // "world"
        await dwell();
        await toClaude();
        // No edit is made here: these writes are what the editor publishes
        // when it remaps a selection on a Y-driven change, carrying its stamp
        // (#1991). Above — shifted by an insertion, same stamp.
        select(111, 9, 14);
        await dwell();
        external = [];
        userChat("a", "x", doc.id);
        expect(pushedSelection("a")).toBeUndefined();
        expect((await poll()).activity.selectedText).toBeNull();
        // Inside — its length changed, same stamp.
        select(111, 9, 12);
        await dwell();
        userChat("b", "x", doc.id);
        expect(pushedSelection("b")).toBeUndefined();
        expect((await poll()).activity.selectedText).toBeNull();
      });

      it("the selection attached is the one the user dragged to within the dwell after the switch back, judged on its own stamp", async () => {
        await toLocal();
        select(111);
        await dwell();
        await toClaude();
        select(222, 0, 3);
        select(333, 6, 11);
        await dwell();
        external = [];
        userChat("c", "x", doc.id);
        expect(pushedSelection("c")?.selectedText).toBe("world");
      });

      it("a selection buffered during the period never rides a push after it, even before a new dwell fires", async () => {
        await toLocal();
        select(111);
        await dwell(); // S1 buffered
        select(222); // S2 made within its dwell, before the switch back
        // Deterministic (round-2 item 5): S1 is what the buffer holds at the
        // switch back. Were S2's dwell to fire first, this fails rather than
        // passing on S2's stamp alone.
        expect(getBufferedSelection(doc.id)?.stamp).toBe(111);
        await toClaude(); // records S2's stamp; S1 is cleared from the buffer
        expect(getBufferedSelection(doc.id)?.stamp).not.toBe(111);
        external = [];
        userChat("d", "x", doc.id);
        expect(pushedSelection("d")).toBeUndefined();
      });

      it("with the flag on and no local period ever, a selection restored at boot is not handed until the user changes it", async () => {
        select(111);
        await dwell();
        bootLocalPeriod();
        external = [];
        userChat("e", "x", doc.id);
        expect(pushedSelection("e")).toBeUndefined();
        expect((await poll()).activity.selectedText).toBeNull();
        select(222);
        await dwell();
        userChat("f", "x", doc.id);
        expect(pushedSelection("f")?.selectedText).toBe("Hello");
      });
    });

    describe("cursors, rounds and twins", () => {
      it("a real cursor is returned byte-identical during the period, and is owed after it what it was owed", async () => {
        userChat("pre");
        const minted = (await poll({ cursor: "start" })).cursor;
        userChat("pre2");
        await toLocal();
        userChat("during");
        const blank = await poll({ cursor: minted });
        expect(blank.cursor).toBe(minted);
        await toClaude();
        const after = await poll({ cursor: minted });
        expect(chatIds(after)).toEqual(["pre2"]);
        expect(after.summary).toContain(owedAtSwitchSentence(["pre2"]));
      });

      it("after the switch back the round is fresh: a forward reads awaiting-poll and a poll records a latency", async () => {
        // A completed round before the period, so a stale latency exists.
        recordWakeForward(Date.now() - 500);
        await poll();
        expect(typeof getDeliveryState(Date.now(), 1).latencyMs).toBe("number");
        recordWakeForward(Date.now() - 1000);
        await toLocal();
        expect(getDeliveryState(Date.now(), 1).state).toBe("idle");
        await toClaude("allowance");
        // Discarded: no latency from before the period reads as this round's.
        expect(getDeliveryState(Date.now(), 1).latencyMs).toBeNull();
        recordWakeForward(Date.now() - 50);
        expect(getDeliveryState(Date.now(), 1).state).toBe("awaiting-poll");
        await poll();
        const done = getDeliveryState(Date.now(), 1);
        expect(done.state).toBe("polled");
        expect(typeof done.latencyMs).toBe("number");
      });

      it("twin of the same-key re-add: a pre-switch row deleted and re-added after the period is pushed", async () => {
        userChat("pre");
        await toLocal();
        await toClaude();
        const ctrl = getOrCreateDocument(CTRL_ROOM);
        withBrowser(ctrl, () => ctrl.getMap(Y_MAP_CHAT).delete("pre"));
        external = [];
        userChat("pre", "again");
        expect(external.filter((e) => e.type === "chat:message")).toHaveLength(1);
      });

      it("a document event during the period reaches no external consumer; after it, one does", async () => {
        await toLocal();
        external = [];
        const opened = (id: string) =>
          ({
            id,
            type: "document:opened",
            timestamp: Date.now(),
            documentId: doc.id,
            payload: { fileName: "x.md", format: "md" },
          }) as unknown as TandemEvent;
        _pushEventForTests(opened("ev-during"));
        expect(external).toEqual([]);
        await toClaude("allowance");
        _pushEventForTests(opened("ev-after"));
        expect(external.map((e) => e.id)).toContain("ev-after");
      });

      it("Clear chat drops a row's owed-at-switch entry: a same-key re-add afterwards carries no sentence", async () => {
        userChat("pre");
        await toLocal();
        await toClaude();
        await clearCtrlChatDurably(getOrCreateDocument(CTRL_ROOM));
        userChat("pre", "new");
        const inbox = await poll();
        expect(chatIds(inbox)).toEqual(["pre"]);
        expect(inbox.summary).not.toContain("switched to a local model");
      });
    });

    describe("review round 1: what the tests reviewer found unpinned", () => {
      it("the flag-on output schema carries localModelAnswersChat (R1.2)", async () => {
        const tools = await client.listTools();
        const inbox = tools.tools.find((t) => t.name === "tandem_checkInbox");
        expect(
          Object.keys(
            (inbox?.outputSchema as { properties?: Record<string, unknown> }).properties ?? {},
          ),
        ).toContain("localModelAnswersChat");
      });

      it("a row is classed before the origin skip: a user row added under the MCP origin during the period is local-period chat", async () => {
        await toLocal();
        const ctrl = getOrCreateDocument(CTRL_ROOM);
        withMcp(ctrl, () =>
          ctrl
            .getMap(Y_MAP_CHAT)
            .set("via-mcp", { id: "via-mcp", author: "user", text: "x", timestamp: Date.now() }),
        );
        expect(isLocalPeriodChat("via-mcp")).toBe(true);
        await toClaude();
        expect(chatIds(await poll())).toEqual([]);
      });

      it("the local model's own reply on Claude's annotation is never pushed (decision 7; the reply-author gate refuses any non-user reply, and A2's mark is defence in depth)", async () => {
        annotation("cl", { author: "claude" });
        external = [];
        withBrowser(doc.ydoc, () =>
          doc.ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("lm-r", {
            id: "lm-r",
            annotationId: "cl",
            author: "claude",
            text: "local says",
            timestamp: 1500,
            agentIdentity: LOCAL_ID,
          }),
        );
        expect(external.filter((e) => e.type === "annotation:reply")).toEqual([]);
        // Positive twin: the user's reply in the same thread is pushed.
        userReplyOn("cl", "u-r");
        expect(external.filter((e) => e.type === "annotation:reply")).toHaveLength(1);
      });

      it("Clear chat drops a local-period row's class: re-added after the period, it is a new row and handed", async () => {
        await toLocal();
        userChat("during");
        await toClaude();
        await clearCtrlChatDurably(getOrCreateDocument(CTRL_ROOM));
        userChat("during", "new");
        expect(chatIds(await poll())).toEqual(["during"]);
      });

      it(`the deleted-class bound: ${DELETED_CLASS_CAP} later deletions evict a deleted local row's class, one fewer does not`, async () => {
        await toLocal();
        userChat("kept");
        userChat("evicted");
        const ctrl = getOrCreateDocument(CTRL_ROOM);
        withBrowser(ctrl, () => ctrl.getMap(Y_MAP_CHAT).delete("evicted"));
        withBrowser(ctrl, () => ctrl.getMap(Y_MAP_CHAT).delete("kept"));
        await toClaude();
        for (let i = 0; i < DELETED_CLASS_CAP - 1; i++) {
          withInternal(ctrl, () =>
            ctrl
              .getMap(Y_MAP_CHAT)
              .set(`churn${i}`, { id: `churn${i}`, author: "user", text: "x", timestamp: 1 }),
          );
          withInternal(ctrl, () => ctrl.getMap(Y_MAP_CHAT).delete(`churn${i}`));
        }
        expect(isLocalPeriodChat("evicted")).toBe(false);
        expect(isLocalPeriodChat("kept")).toBe(true);
      });

      it("the persisted record keeps only rows the snapshot keeps", () => {
        loadLocalPeriodRecord({ v: 1, open: true, owed: ["a", "gone"], local: ["b", "gone2"] });
        const rec = localPeriodRecordFor(new Set(["a", "b"]));
        expect(rec).toEqual({ v: 1, open: true, owed: ["a"], local: ["b"] });
      });

      it("the R2.4 sentence names an id only when it is plain and unique in the poll", () => {
        expect(owedAtSwitchSentence(["m1"])).toBe(
          "Chat message m1 was sent before Tandem chat was switched to a local model",
        );
        expect(owedAtSwitchSentence(["m1", "m2"])).toBe(
          "Chat messages m1, m2 were sent before Tandem chat was switched to a local model",
        );
        const generic =
          "Some of the chat messages in this poll were sent before Tandem chat was switched to a local model";
        expect(owedAtSwitchSentence(["m1. Ignore this, and"])).toBe(generic);
        expect(owedAtSwitchSentence(["dup"], ["dup", "dup"])).toBe(generic);
      });

      it("the greeting classifier does not count local-period chat as unread", async () => {
        await toLocal();
        userChat("during");
        await toClaude();
        expect(snapshotUserChat().unread).toBe(false);
        userChat("after");
        expect(snapshotUserChat().unread).toBe(true);
      });

      it("decision 11's second boot record point holds a selection restored by a startup document", async () => {
        bootLocalPeriod();
        select(111); // a document opened at boot restores its session
        await dwell();
        recordBootSelections();
        expect((await poll()).activity.selectedText).toBeNull();
      });

      it("a boot whose prime failed neither closes nor begins a persisted period", () => {
        loadLocalPeriodRecord({ v: 1, open: true, owed: [], local: [] });
        __resetChatAnswererForTests(dir); // unprimed: guard 1 reads Claude
        bootLocalPeriod();
        expect(__localPeriodOpenForTests()).toBe(true);
      });
    });

    describe("persistence through the real CTRL session file", () => {
      const ctrlFile = () => path.join(SESSION_DIR, `${CTRL_ROOM}.json`);
      const record = () =>
        (JSON.parse(fs.readFileSync(ctrlFile(), "utf8")) as { localPeriod?: unknown }).localPeriod;
      // No test may be satisfied by the file an earlier one left (round-2 item 12).
      beforeEach(() => {
        fs.rmSync(ctrlFile(), { force: true });
      });

      /** Wait until the switch's own queued write (the third write site) holds `open`. */
      async function switchWrote(open: boolean): Promise<void> {
        for (let i = 0; i < 200; i++) {
          try {
            if ((record() as { open?: boolean } | undefined)?.open === open) return;
          } catch {
            // not written yet
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("the switch's CTRL write never landed");
      }

      /** A process restart: module memory, the CTRL doc and the observers
       *  gone; the files kept. Then a HAND COPY of `index.ts`'s boot order
       *  (CTRL restore, priming, then `wireLocalPeriod`), not the boot itself;
       *  the order it copies is pinned against `index.ts` by
       *  `tests/server/boot-order.test.ts`. */
      async function restartServer(answererOnDisk?: "local" | "claude"): Promise<void> {
        await __flushLocalModelAnnouncedForTests();
        unsubscribe(extCb);
        unsubscribe(intCb);
        resetForTesting();
        resetDeliveryStateForTests();
        resetInbox();
        __resetLocalPeriodForTests();
        __setHonourLocalPeriodRecordsForTests(true);
        removeDocument(CTRL_ROOM);
        if (answererOnDisk) {
          fs.writeFileSync(
            path.join(dir, "chat-answerer.json"),
            JSON.stringify({ version: 1, answerer: answererOnDisk }),
          );
        }
        __resetLocalModelAnnouncedForTests(dir);
        __resetChatAnswererForTests(dir);
        const saved = await loadCtrlSession();
        if (saved) restoreCtrlDoc(getOrCreateDocument(CTRL_ROOM), saved);
        setCtrlMode("tandem");
        attachCtrlObservers();
        attachObservers(doc.id, doc.ydoc);
        primeLocalModelSettings();
        primeChatAnswerer();
        wireLocalPeriod();
        external = [];
        internal = [];
        subscribe(extCb, "external");
        subscribe(intCb, "internal");
      }

      it("switch, shutdown, restart: the local row is not handed, the pre-switch row is, with its sentence; the file holds the classes, the owed set and the marker", async () => {
        userChat("pre");
        await toLocal();
        userChat("during");
        await saveCtrlSession(getOrCreateDocument(CTRL_ROOM)); // shutdown
        // #1123 part B, R11.3: the record gained `chat: true` (user chat was
        // sent in the open period); still `v: 1`.
        expect(record()).toEqual({
          v: 1,
          open: true,
          owed: ["pre"],
          local: ["during"],
          chat: true,
        });
        await restartServer();
        expect(chatAnswerer()).toBe("local");
        expect(__localPeriodOpenForTests()).toBe(true);
        expect(isLocalPeriodChat("during")).toBe(true);
        expect((await poll()).summary).toBe(LOCAL_PERIOD_STATUS_LINE);
        await toClaude();
        const inbox = await poll();
        expect(chatIds(inbox)).toEqual(["pre"]);
        expect(inbox.summary).toContain(owedAtSwitchSentence(["pre"]));
      });

      it("R11: a restart mid-period keeps the 'chat was sent' fact: the own switch back writes the line", async () => {
        await toLocal();
        userChat("during");
        await saveCtrlSession(getOrCreateDocument(CTRL_ROOM));
        await restartServer();
        expect(switchBackLines()).toHaveLength(0);
        await toClaude();
        expect(switchBackLines()).toHaveLength(1);
      });

      it("R11: a record with no `chat` field, or a non-literal one, reads as no chat: no line", async () => {
        for (const chat of [undefined, "true", 1]) {
          ctrlChat().forEach((_v, k) => {
            withInternal(getOrCreateDocument(CTRL_ROOM), () => ctrlChat().delete(k));
          });
          await toLocal();
          await saveCtrlSession(getOrCreateDocument(CTRL_ROOM));
          const file = JSON.parse(fs.readFileSync(ctrlFile(), "utf8"));
          file.localPeriod = { ...file.localPeriod, ...(chat === undefined ? {} : { chat }) };
          delete (file.localPeriod as { chat?: unknown }).chat;
          if (chat !== undefined) file.localPeriod.chat = chat;
          fs.writeFileSync(ctrlFile(), JSON.stringify(file));
          await restartServer();
          await toClaude();
          expect(switchBackLines(), `chat: ${String(chat)}`).toHaveLength(0);
        }
      });

      it("a period a boot begins is written at once: the file says open before any shutdown", async () => {
        userChat("pre");
        await saveCtrlSession(getOrCreateDocument(CTRL_ROOM));
        await restartServer("local");
        await switchWrote(true);
        expect(record()).toMatchObject({ open: true, owed: ["pre"] });
      });

      it("a row restored as not local-period chat and re-added under its key during a period is still not local-period chat", async () => {
        userChat("pre");
        await toLocal();
        await saveCtrlSession(getOrCreateDocument(CTRL_ROOM));
        await restartServer();
        const ctrl = getOrCreateDocument(CTRL_ROOM);
        withBrowser(ctrl, () => ctrl.getMap(Y_MAP_CHAT).delete("pre"));
        userChat("pre", "re-added during the period");
        expect(isLocalPeriodChat("pre")).toBe(false);
        await toClaude();
        expect(chatIds(await poll())).toEqual(["pre"]);
      });

      it("a crash after the switch keeps what the switch wrote", async () => {
        userChat("pre");
        userChat("pre-b");
        await toLocal();
        await switchWrote(true);
        expect(record()).toMatchObject({ open: true, owed: ["pre", "pre-b"] });
        await restartServer(); // no shutdown write
        await toClaude();
        expect(chatIds(await poll())).toEqual(["pre", "pre-b"]);
      });

      it("a boot that reads Claude with a period still open closes it, wakes nothing, and hands what was owed", async () => {
        userChat("pre");
        await toLocal();
        userChat("during");
        await saveCtrlSession(getOrCreateDocument(CTRL_ROOM));
        await restartServer("claude"); // a program set Claude while Tandem was down
        expect(chatAnswerer()).toBe("claude");
        expect(__localPeriodOpenForTests()).toBe(false);
        expect(wakes()).toHaveLength(0);
        const inbox = await poll();
        expect(chatIds(inbox)).toEqual(["pre"]);
        expect(isLocalPeriodChat("during")).toBe(true);
      });

      it("a closed period, then the file changed to local while Tandem was down: the boot begins a period and replaces the owed set", async () => {
        userChat("pre1");
        await toLocal();
        await toClaude();
        claudeReply("cr1", "pre1");
        userChat("pre2");
        await saveCtrlSession(getOrCreateDocument(CTRL_ROOM));
        expect(record()).toMatchObject({ open: false, owed: ["pre1"] });
        await restartServer("local");
        expect(__localPeriodOpenForTests()).toBe(true);
        // Replaced, not kept: pre1 is answered, pre2 is owed now.
        await switchWrote(true);
        expect(record()).toMatchObject({ open: true, owed: ["pre2"] });
        expect((await poll()).summary).toBe(LOCAL_PERIOD_STATUS_LINE);
        await toClaude();
        const inbox = await poll({ cursor: "start" });
        expect(chatIds(inbox)).toEqual(["pre2"]);
        expect(inbox.summary).toContain(owedAtSwitchSentence(["pre2"]));
      });
    });
  });
}

describe("the dark guard", () => {
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-local-period-dark-"));
    resetForTesting();
    __resetLocalPeriodForTests();
    __resetChatAnswererForTests(dir);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    __resetLocalPeriodForTests();
    __setHonourLocalPeriodRecordsForTests(null);
    __resetChatAnswererForTests();
    resetForTesting();
    vi.restoreAllMocks();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("flag off (guard 2) with a stored 'local model' (never primed, guard 1): Claude answers and nothing is withheld", () => {
    __setHonourLocalPeriodRecordsForTests(false);
    fs.writeFileSync(path.join(dir, "chat-answerer.json"), '{"version":1,"answerer":"local"}');
    expect(chatAnswerer()).toBe("claude");
    setCtrlMode("tandem");
    attachCtrlObservers();
    const seen: TandemEvent[] = [];
    const cb = (e: TandemEvent) => seen.push(e);
    subscribe(cb, "external");
    userChat("x");
    unsubscribe(cb);
    expect(seen.map((e) => e.type)).toEqual(["chat:message"]);
    expect(isLocalPeriodChat("x")).toBe(false);
  });

  it("unwired (the wiring failed at boot): the supervisor is still told of each switch, and whether it was the user's", async () => {
    __setHonourLocalPeriodRecordsForTests(true);
    __resetLocalModelAnnouncedForTests(dir);
    __resetChatAnswererForTests(dir);
    fs.writeFileSync(path.join(dir, "local-model-baseline.json"), '{"version":1}\n');
    primeLocalModelSettings();
    primeChatAnswerer();
    const told: unknown[] = [];
    subscribeLocalPeriod((c) => told.push(c));
    await setChatAnswerer("local", "own-window");
    await setChatAnswerer("claude", "own-window");
    await __flushLocalModelAnnouncedForTests();
    expect(told).toEqual([{ to: "local" }, { to: "claude", asked: true }]);
    // The period's own state is left as loaded: nothing opened it.
    expect(__localPeriodOpenForTests()).toBe(false);
  });

  it("flag off (#1123 part B, R11): the answerer is never primed, a chat classes nothing, and no line is written", async () => {
    __setHonourLocalPeriodRecordsForTests(false);
    fs.writeFileSync(path.join(dir, "chat-answerer.json"), '{"version":1,"answerer":"local"}');
    setCtrlMode("tandem");
    attachCtrlObservers();
    wireLocalPeriod();
    userChat("x");
    expect(chatAnswerer()).toBe("claude");
    expect(localPeriodRecordFor(new Set(["x"]))).toBeUndefined();
    expect(
      [...ctrlChat().values()].some(
        (m) => (m as { chatNotice?: string }).chatNotice === "claude-again",
      ),
    ).toBe(false);
  });

  it("guard 2 reads the literal flag when no test overrides it", () => {
    __setHonourLocalPeriodRecordsForTests(null);
    expect(honourLocalPeriodRecords()).toBe(BYO_MODELS_ENABLED);
  });

  it("dark tools/list: tandem_checkInbox's output schema has no local-period field and is master's shape", async () => {
    // Forced dark for this case alone (#1123: the suite holds in both states):
    // the schema carries the field exactly when the honour seam is on
    // (`awareness.ts`'s `localPeriodField`), and this case is about its absence.
    __setHonourLocalPeriodRecordsForTests(false);
    const { client: c, close: done } = await setupMcpServer([registerAwarenessTools], {
      dispatch: (fn) => asTestCaller(fn),
    });
    try {
      const tools = await c.listTools();
      const inbox = tools.tools.find((t) => t.name === "tandem_checkInbox");
      const schema = inbox?.outputSchema as { properties?: Record<string, unknown> };
      expect(Object.keys(schema.properties ?? {})).not.toContain("localModelAnswersChat");
      // Master's bytes, frozen (round-2 item 11): the schema origin/master
      // served at ed035a8 (master after #2423), dumped once with ownership off and once on. Which
      // one applies is read from the schema itself, never from the flag (only
      // ownership-anchor.test.ts may key on it). Flag off it must equal master's
      // bytes; flag on it is master's bytes with exactly #2358's chat owners PR's
      // changes applied (a new cause word, and three reworded descriptions),
      // spelled out here so any other difference fails.
      const isOwnership = Object.hasOwn(schema.properties ?? {}, "ownership");
      const frozen = isOwnership
        ? "master-checkinbox-output-schema.ownership.json"
        : "master-checkinbox-output-schema.json";
      let masterText = fs.readFileSync(
        path.join(process.cwd(), "tests/fixtures/local-period", frozen),
        "utf8",
      );
      if (isOwnership) {
        for (const [before, after] of [
          ...CHAT_OWNERS_SCHEMA_CHANGES,
          ...POSTS_SCHEMA_CHANGES,
          ...TAKE_BACK_SCHEMA_CHANGES,
          ...TAKE_BACK_CAUSE_SCHEMA_CHANGES,
          ...RELEASE_ASSIGN_CAUSE_SCHEMA_CHANGES,
        ]) {
          expect(masterText.split(before), `master carries: ${before}`).toHaveLength(2);
          masterText = masterText.replace(before, after);
        }
      }
      expect(schema).toEqual(JSON.parse(masterText));
    } finally {
      await done();
    }
  });

  it("flag off (#1123 part B, R11; review round 1 item 10): switches attempted unprimed write no line, and the CTRL file is master's shape", async () => {
    __setHonourLocalPeriodRecordsForTests(false);
    setCtrlMode("tandem");
    attachCtrlObservers();
    wireLocalPeriod();
    // Never primed, as in a dark build: whatever is attempted, the answerer
    // reads Claude and nothing reaches onSwitch.
    await expect(setChatAnswerer("local", "own-window")).resolves.toEqual({
      answerer: "claude",
      persisted: false,
    });
    userChat("during");
    await expect(setChatAnswerer("claude", "own-window")).resolves.toEqual({
      answerer: "claude",
      persisted: false,
    });
    await __flushLocalModelAnnouncedForTests();
    expect(chatAnswerer()).toBe("claude");
    expect(
      [...ctrlChat().values()].some(
        (m) => (m as { chatNotice?: string }).chatNotice === "claude-again",
      ),
    ).toBe(false);
    expect(localPeriodRecordFor(new Set(["during"]))).toBeUndefined();
    const file = path.join(SESSION_DIR, `${CTRL_ROOM}.json`);
    fs.rmSync(file, { force: true });
    await saveCtrlSession(getOrCreateDocument(CTRL_ROOM));
    // Master writes exactly these two fields (`saveCtrlSession`), in this order.
    expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")))).toEqual([
      "ydocState",
      "lastAccessed",
    ]);
  });

  it("flag off (guard 2): the CTRL session file gains no field, and a stored record is ignored", () => {
    __setHonourLocalPeriodRecordsForTests(false);
    expect(localPeriodRecordFor(new Set(["a"]))).toBeUndefined();
    loadLocalPeriodRecord({ v: 1, open: true, owed: [], local: ["a"] });
    expect(isLocalPeriodChat("a")).toBe(false);
  });

  it("flag on with priming failed (guard 1 reads Claude): guard 2 still excludes local-period chat and local-model activity", () => {
    __setHonourLocalPeriodRecordsForTests(true);
    expect(chatAnswerer()).toBe("claude");
    loadLocalPeriodRecord({ v: 1, open: true, owed: [], local: ["held-row"] });
    setCtrlMode("tandem");
    attachCtrlObservers();
    const seen: TandemEvent[] = [];
    const cb = (e: TandemEvent) => seen.push(e);
    subscribe(cb, "external");
    userChat("held-row");
    userChat("fresh-row");
    unsubscribe(cb);
    expect(isLocalPeriodChat("held-row")).toBe(true);
    expect(isLocalPeriodChat("fresh-row")).toBe(false);
    expect(seen.map((e) => (e.payload as { messageId?: string }).messageId)).toEqual(["fresh-row"]);
  });
});
