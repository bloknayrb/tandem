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
import type * as Y from "yjs";
import { z } from "zod";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  getDeliveryState,
  recordWakeForward,
  resetDeliveryStateForTests,
} from "../../src/server/events/delivery-state.js";
import {
  _pushEventForTests,
  ANSWERER_RETURN_WAKE_CONTENT,
  attachCtrlObservers,
  attachObservers,
  emitModeReleaseWake,
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
  registerAwarenessTools,
  resetInbox,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
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
  noteTransportRegistered,
  resetOwnershipForTests,
  setTransportView,
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

const pushedSelection = (id: string) =>
  (
    external.find(
      (e) => e.type === "chat:message" && (e.payload as { messageId?: string }).messageId === id,
    )?.payload as { selection?: { selectedText?: string } } | undefined
  )?.selection;

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
      setTransportView(() => [{ ownerId: "test:caller", openStreams: 0 }]);
      noteTransportRegistered("test:caller", { recordKind: "claude" });
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
        { dispatch: (fn) => asTestCaller(fn) },
      ));
    });

    afterEach(async () => {
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

      it("Claude edits above, and separately inside, a held selection: still held, in activity and on the push", async () => {
        await toLocal();
        select(111, 6, 11); // "world"
        await dwell();
        await toClaude();
        // The editor remaps a selection on a Y-driven change and carries its
        // stamp (#1991): above — shifted by the insertion, same stamp.
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
        await toClaude(); // records S2's stamp; S1 is still in the buffer
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
       *  gone; the files kept. Then the boot order of `index.ts`. */
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
        expect(record()).toEqual({ v: 1, open: true, owed: ["pre"], local: ["during"] });
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

  it("guard 2 reads the literal flag when no test overrides it", () => {
    __setHonourLocalPeriodRecordsForTests(null);
    expect(honourLocalPeriodRecords()).toBe(BYO_MODELS_ENABLED);
  });

  it("dark tools/list: tandem_checkInbox's output schema has no local-period field and is master's shape", async () => {
    __setHonourLocalPeriodRecordsForTests(null);
    const { client: c, close: done } = await setupMcpServer([registerAwarenessTools], {
      dispatch: (fn) => asTestCaller(fn),
    });
    try {
      const tools = await c.listTools();
      const inbox = tools.tools.find((t) => t.name === "tandem_checkInbox");
      const props = Object.keys(
        (inbox?.outputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      ).sort();
      expect(props).not.toContain("localModelAnswersChat");
      // Master's shape (with ownership's own field when that flag is on).
      expect(props.filter((k) => k !== "ownership")).toEqual(
        Object.keys(checkInboxOutputShape).sort(),
      );
    } finally {
      await done();
    }
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
