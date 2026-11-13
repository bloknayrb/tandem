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
  OWED_AT_SWITCH_SENTENCE,
  registerAwarenessTools,
  resetInbox,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
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
  isLocalPeriodChat,
  loadLocalPeriodRecord,
  localPeriodRecordFor,
} from "../../src/server/models/local-period.js";
import {
  noteTransportRegistered,
  resetOwnershipForTests,
  setTransportView,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
  Y_MAP_SELECTION,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../src/shared/origins.js";
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

function userChat(id: string, text = `text of ${id}`): void {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withBrowser(ctrl, () =>
    ctrl.getMap(Y_MAP_CHAT).set(id, { id, author: "user", text, timestamp: Date.now() }),
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

function select(stamp: number): void {
  withBrowser(doc.ydoc, () =>
    doc.ydoc.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_SELECTION, {
      from: 0,
      to: 5,
      selectedText: "Hello",
      timestamp: stamp,
      textFingerprint: undefined,
    }),
  );
}

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
      vi.stubEnv("TANDEM_OWNERSHIP", ownership);
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
      withInternal(ctrl, () => ctrl.getMap(Y_MAP_CHAT).clear());
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
        expect(inbox.summary).toContain(OWED_AT_SWITCH_SENTENCE);
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
        expect(inbox.summary).not.toContain(OWED_AT_SWITCH_SENTENCE);
      });

      it("chat Claude already answered is not owed at the switch", async () => {
        userChat("answered");
        claudeReply("cr", "answered");
        userChat("pending");
        await toLocal();
        await toClaude();
        const inbox = await poll({ cursor: "start" });
        expect(chatIds(inbox)).toEqual(["pending"]);
        expect(inbox.summary).toContain(OWED_AT_SWITCH_SENTENCE);
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

      it("a selection made during the period is in neither activity nor the next chat push until the user makes a new one", async () => {
        await toLocal();
        select(111);
        await new Promise((r) => setTimeout(r, 1100));
        await toClaude();
        external = [];
        userChat("after");
        const push = external.find((e) => e.type === "chat:message");
        expect((push?.payload as { selection?: unknown }).selection).toBeUndefined();
        expect((await poll()).activity.selectedText).toBeNull();
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
        expect(inbox.summary).toContain(OWED_AT_SWITCH_SENTENCE);
      });

      it("a boot that reads Claude with a period still open closes it; one that reads local with none open begins one", async () => {
        await toLocal();
        expect(__localPeriodOpenForTests()).toBe(true);
        await toClaude("allowance");
        expect(__localPeriodOpenForTests()).toBe(false);
        bootLocalPeriod();
        expect(__localPeriodOpenForTests()).toBe(false);
      });

      it("positive control: with no local period, chat is handed and pushed as on master", async () => {
        userChat("plain");
        expect(external.filter((e) => e.type === "chat:message")).toHaveLength(1);
        expect(chatIds(await poll())).toEqual(["plain"]);
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
