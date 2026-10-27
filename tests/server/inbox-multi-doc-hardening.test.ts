/**
 * PR #2225 review: hardening of the multi-document `tandem_checkInbox` (#2187).
 *
 * Every row drives the REGISTERED handler over the in-memory MCP harness, so the
 * SDK's own structured-output validation is in the loop — the failure several of
 * these rows pin is exactly that validation rejecting the WHOLE response.
 *
 *  - C: admit-before-stamp. One malformed client-written record (an annotation,
 *    a reply, a chat message, an awareness field) used to fail the entire poll
 *    after every item in it had been stamped delivered. Now it is left out,
 *    counted, logged once without its content, and retried; and nothing is
 *    committed until the whole response validates.
 *  - D: the quiet-document skip and the facts that must defeat it.
 *  - E: the delivery round stays open while an item it waits on was not handed
 *    over.
 *  - F: `alreadyPushed` answers for the item's own document.
 *  - G / H / J: the unreadable active document, a store that throws while
 *    resolving, and colliding basenames.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as Y from "yjs";
import { z } from "zod";
import { isStoreReadOnly } from "../../src/server/annotations/store.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { getDeliveryState, recordWakeForward } from "../../src/server/events/delivery-state.js";
import {
  attachObservers,
  detachObservers,
  resetForTesting as resetEventQueue,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import {
  describeIssues,
  registerAwarenessTools,
  resetInbox,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { getDocumentStore, YDocStore } from "../../src/server/mcp/document-store.js";
import { checkInboxOutputShape } from "../../src/server/mcp/output-schemas.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ACTIVITY,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
  Y_MAP_MODE,
  Y_MAP_SELECTION,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../src/shared/origins.js";
import { selectionFingerprint } from "../../src/shared/selection-fingerprint.js";
import type { ChatMessage } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";

// Pass-through mocks: each behaves exactly as the real function until a row
// overrides it for one call. `isStoreReadOnly` is the server-built field the
// backstop row corrupts; `getDocumentStore` is the store resolution H moves
// inside the per-document isolation.
vi.mock("../../src/server/annotations/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/annotations/store.js")>();
  return { ...actual, isStoreReadOnly: vi.fn(actual.isStoreReadOnly) };
});
vi.mock("../../src/server/mcp/document-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/mcp/document-store.js")>();
  return { ...actual, getDocumentStore: vi.fn(actual.getDocumentStore) };
});

const inboxSchema = z.object(checkInboxOutputShape);
type Inbox = z.infer<typeof inboxSchema>;

let client: Client;
let close: (() => Promise<void>) | undefined;

beforeEach(async () => {
  resetInbox();
  resetEventQueue();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => {
    ctrl.getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE);
    ctrl.getMap(Y_MAP_CHAT).clear();
  });
  ({ client, close } = await setupMcpServer([registerAwarenessTools]));
});

afterEach(async () => {
  await close?.();
  close = undefined;
});

/** Open a document; ids must be unique per test, since Y.Docs outlive a test. */
function openDoc(id: string, text: string, opts: { active?: boolean; filePath?: string } = {}) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, {
    id,
    filePath: opts.filePath ?? `/tmp/${id}.md`,
    format: "md",
    readOnly: false,
    source: "file",
  });
  if (opts.active) setActiveDocId(id);
  return ydoc;
}

/** A pending, Claude-facing user comment; `extra` overrides any field. */
function userComment(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}) {
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: "please look",
      status: "pending",
      timestamp: 1,
      rev: 1,
      ...extra,
    }),
  );
}

function claudeComment(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}) {
  userComment(ydoc, id, { author: "claude", content: "a suggestion", ...extra });
}

function chatMap() {
  return getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT);
}

function seedChat(key: string, value: unknown) {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => chatMap().set(key, value));
}

async function pollRaw(args: { documentId?: string } = {}) {
  return client.callTool({ name: "tandem_checkInbox", arguments: args });
}

/** A poll that must succeed; parsed with the declared output schema. */
async function poll(args: { documentId?: string } = {}): Promise<Inbox> {
  const result = await pollRaw(args);
  expect(parseResult(result).error, JSON.stringify(result)).toBe(false);
  return inboxSchema.parse((result as { structuredContent: unknown }).structuredContent);
}

/** `console.error`, captured for the test, returning the joined lines. */
function captureStderr() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  return () => spy.mock.calls.map((args) => args.map(String).join(" "));
}

/** How many times `listAnnotations` ran per document, from here on. */
function countDocumentReads() {
  const reads = new Map<string, number>();
  const real = YDocStore.prototype.listAnnotations;
  const spy = vi.spyOn(YDocStore.prototype, "listAnnotations").mockImplementation(function (
    this: YDocStore,
  ) {
    reads.set(this.documentId, (reads.get(this.documentId) ?? 0) + 1);
    return real.call(this);
  });
  onTestFinished(() => spy.mockRestore());
  return {
    of: (id: string) => reads.get(id) ?? 0,
    reset: () => reads.clear(),
  };
}

// ── C: admit before stamp ─────────────────────────────────────────────────────

describe("C: a malformed record is left out, not the whole poll", () => {
  it("returns the healthy items, counts the refused one, and stamps only what it returned", async () => {
    const stderr = captureStderr();
    const bad = openDoc("hard-c-bad", "Bad document text");
    userComment(bad, "u_bad", { content: 42 });
    const good = openDoc("hard-c-good", "Good document text", { active: true });
    userComment(good, "u_good");

    const first = await poll();
    expect(first.userActions.map((a) => a.id)).toEqual(["u_good"]);
    expect(first.hasNew).toBe(true);
    expect(first.summary).toContain(
      "1 item in hard-c-bad.md could not be returned (malformed record; details in Tandem's log).",
    );

    // The healthy item was stamped; the refused one was not, so it is retried
    // and still counted — and a drop alone is not something new to act on.
    const second = await poll();
    expect(second.userActions).toEqual([]);
    expect(second.hasNew).toBe(false);
    expect(second.summary).toContain("1 item in hard-c-bad.md could not be returned");

    // Logged once for the two polls: id and zod path + code only.
    const drops = stderr().filter((line) => line.includes("left out a malformed"));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain('"u_bad"');
    expect(drops[0]).toContain("content invalid_type");
    expect(drops[0]).toContain("hard-c-bad");

    // Healed, it is delivered — it was never marked delivered while refused.
    userComment(bad, "u_bad", { content: "now a string" });
    const healed = await poll();
    expect(healed.userActions.map((a) => a.id)).toEqual(["u_bad"]);
    expect(healed.summary).not.toContain("could not be returned");
  });

  it("admits every bucket per item", async () => {
    captureStderr();
    const doc = openDoc("hard-c-buckets", "Bucket document text", { active: true });
    // userResponses: a dismissed Claude comment with a non-string content.
    claudeComment(doc, "c_bad_response", { status: "dismissed", content: 7 });
    // userReplies: a malformed reply on a healthy (pending) Claude comment.
    claudeComment(doc, "c_parent");
    withInternal(doc, () =>
      doc.getMap(Y_MAP_ANNOTATION_REPLIES).set("r_bad", {
        id: "r_bad",
        annotationId: "c_parent",
        author: "user",
        text: 99,
        timestamp: 2,
      }),
    );
    // userActions: a healthy one alongside, which must still come back.
    userComment(doc, "u_ok");

    const data = await poll();
    expect(data.userActions.map((a) => a.id)).toEqual(["u_ok"]);
    expect(data.userResponses).toEqual([]);
    expect(data.userReplies).toEqual([]);
    expect(data.summary).toContain("2 items in hard-c-buckets.md could not be returned");
  });

  it("never counts a record a privacy gate already withheld", async () => {
    // admit runs AFTER the gates, so a private or Solo-held record — malformed
    // or not — is never counted, and its existence never reaches the summary.
    // Polled in TANDEM first: in Solo the hold masks every user record, so a
    // regression that moved admit above the audience/note gate would pass.
    setCtrlMode("tandem");
    captureStderr();
    const doc = openDoc("hard-c-private", "Private document text", { active: true });
    userComment(doc, "u_private_bad", { audience: "private", content: 42 });
    withInternal(doc, () => {
      doc.getMap(Y_MAP_ANNOTATIONS).set("n_bad", {
        id: "n_bad",
        author: "user",
        type: "note",
        audience: "private",
        range: { from: 0, to: 5 },
        content: 42,
        status: "pending",
        timestamp: 1,
      });
      // A malformed reply inside the note's thread: channelVisibleReplies
      // refuses note threads before admit can see it.
      doc.getMap(Y_MAP_ANNOTATION_REPLIES).set("r_note_bad", {
        id: "r_note_bad",
        annotationId: "n_bad",
        author: "user",
        text: 42,
        timestamp: 2,
      });
    });

    const tandem = await poll();
    expect(tandem.summary).not.toContain("could not be returned");
    expect(tandem.summary).toBe("No new actions.");

    // And the Solo hold, separately: a malformed outbound comment held in Solo
    // is not counted either.
    setCtrlMode("solo");
    userComment(doc, "u_solo_bad", { content: 42 });
    const solo = await poll();
    expect(solo.summary).not.toContain("could not be returned");
  });

  it("logs no record content and no unprintable id", async () => {
    const stderr = captureStderr();
    const doc = openDoc("hard-c-log", "Log document text", { active: true });
    // An enum mismatch, end to end. zod 4's message for it does not quote the
    // value, so the not-logged-message half is pinned by the next test.
    userComment(doc, "id with <spaces>", { status: "SECRET-STATUS-TEXT" });

    const data = await poll();
    expect(data.summary).toContain("1 item in hard-c-log.md could not be returned");
    const line = stderr().find((l) => l.includes("left out a malformed"));
    expect(line).toBeDefined();
    expect(line).toContain("(unprintable)");
    expect(line).toContain("status invalid_value");
    expect(line).not.toContain("SECRET-STATUS-TEXT");
    expect(line).not.toContain("<spaces>");
    expect(JSON.stringify(data)).not.toContain("SECRET-STATUS-TEXT");
  });

  it("describes issues by path and code only, never the message or an unprintable segment", () => {
    const line = describeIssues([
      {
        code: "custom",
        path: ["content", "SECRET <path>", Symbol("SECRET-SYMBOL"), 3],
        message: "received SECRET-MESSAGE-TEXT",
        input: "SECRET-INPUT",
      },
    ]);
    expect(line).toBe("content.?.?.3 custom");
  });

  it("logs a still-malformed record again once it is edited", async () => {
    const stderr = captureStderr();
    const doc = openDoc("hard-c-relog", "Relog document text", { active: true });
    userComment(doc, "u_relog", { content: 42, editedAt: 10 });
    await poll();
    await poll();
    userComment(doc, "u_relog", { content: 43, editedAt: 20 });
    await poll();
    expect(stderr().filter((l) => l.includes("left out a malformed"))).toHaveLength(2);
  });
});

describe("C: chat is admitted per message", () => {
  it("returns the comment, counts the chat drop, and leaves that chat unread", async () => {
    captureStderr();
    const doc = openDoc("hard-chat-doc", "Chat document text", { active: true });
    userComment(doc, "u_with_chat");
    seedChat("msg_bad", { id: "msg_bad", author: "user", text: 42, timestamp: 1, read: false });

    const first = await poll();
    expect(first.userActions.map((a) => a.id)).toEqual(["u_with_chat"]);
    expect(first.chatMessages).toEqual([]);
    expect(first.summary).toContain(
      "1 chat message could not be returned (malformed record; details in Tandem's log).",
    );
    expect((chatMap().get("msg_bad") as { read: boolean }).read).toBe(false);

    const second = await poll();
    expect(second.userActions).toEqual([]);
    expect(second.hasNew).toBe(false);
    expect(second.summary).toContain("1 chat message could not be returned");
  });

  it("returns and marks read the healthy chat beside a malformed one", async () => {
    captureStderr();
    seedChat("msg_ok", { id: "msg_ok", author: "user", text: "hi", timestamp: 1, read: false });
    seedChat("msg_broken", { id: "msg_broken", author: "user", text: "x", read: false });
    // A non-object entry is skipped, never thrown on.
    seedChat("msg_garbage", "not an object");

    const data = await poll();
    expect(data.chatMessages.map((m) => m.id)).toEqual(["msg_ok"]);
    expect(data.summary).toContain("1 chat message could not be returned");
    expect((chatMap().get("msg_ok") as ChatMessage).read).toBe(true);
    expect((chatMap().get("msg_broken") as ChatMessage).read).toBe(false);
  });
});

describe("C: client-written activity is narrowed to the declared types", () => {
  it("returns empty values for a non-boolean isTyping and non-finite numbers", async () => {
    const doc = openDoc("hard-activity", "Hello activity text", { active: true });
    userComment(doc, "u_activity");
    withInternal(doc, () => {
      const awareness = doc.getMap(Y_MAP_USER_AWARENESS);
      awareness.set(Y_MAP_ACTIVITY, { isTyping: "yes", cursor: Number.NaN, lastEdit: "soon" });
      awareness.set(Y_MAP_SELECTION, {
        from: 0,
        to: 5,
        timestamp: Number.NaN,
        textFingerprint: selectionFingerprint("Hello"),
      });
    });

    const data = await poll();
    expect(data.userActions.map((a) => a.id)).toEqual(["u_activity"]);
    expect(data.activity).toEqual({
      documentId: "hard-activity",
      isTyping: false,
      cursor: null,
      lastEdit: null,
      selectedText: "Hello",
      selectionAt: null,
    });
  });
});

describe("C: the whole-response backstop commits nothing on failure", () => {
  it("returns an error and leaves the ledgers, the chat and the round untouched", async () => {
    const stderr = captureStderr();
    const doc = openDoc("hard-backstop", "Backstop text", { active: true });
    userComment(doc, "u_backstop");
    seedChat("msg_backstop", {
      id: "msg_backstop",
      author: "user",
      text: "hi",
      timestamp: 1,
      read: false,
    });
    recordWakeForward(1_000);
    // A server-built field the SDK would reject: the only thing the backstop
    // can still catch once every client-written value is admitted or narrowed.
    vi.mocked(isStoreReadOnly).mockReturnValueOnce("no" as unknown as boolean);

    const broken = await pollRaw();
    const parsed = parseResult(broken);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("INTERNAL_ERROR");
    expect(stderr().some((l) => l.includes("storeReadOnly invalid_type"))).toBe(true);
    expect((chatMap().get("msg_backstop") as ChatMessage).read).toBe(false);
    expect(getDeliveryState(Date.now(), 1).state).toBe("awaiting-poll");

    const retried = await poll();
    expect(retried.userActions.map((a) => a.id)).toEqual(["u_backstop"]);
    expect(retried.chatMessages.map((m) => m.id)).toEqual(["msg_backstop"]);
    expect(getDeliveryState(Date.now(), 1).state).toBe("polled");
  });
});

// ── D: the quiet-document skip ────────────────────────────────────────────────

describe("D: a quiet background document is skipped only while it is a fixed point", () => {
  it("re-runs until a lazy re-anchor settles, then skips", async () => {
    const bg = openDoc("hard-d-lazy", "Background lazy text");
    claudeComment(bg, "c_lazy"); // pending Claude comment: a refresh candidate, never an item
    openDoc("hard-d-lazy-fg", "Foreground text", { active: true });
    const reads = countDocumentReads();

    await poll();
    // Positive control: poll 1 WROTE (the lazy relRange attach), so it is not
    // a fixed point and cannot be recorded.
    expect(
      (bg.getMap(Y_MAP_ANNOTATIONS).get("c_lazy") as { relRange?: unknown }).relRange,
    ).toBeDefined();
    expect(reads.of("hard-d-lazy")).toBe(1);

    await poll(); // the fixed point: runs, writes nothing, records
    expect(reads.of("hard-d-lazy")).toBe(2);

    await poll(); // skipped
    expect(reads.of("hard-d-lazy")).toBe(2);
    // The active document is never skipped.
    expect(reads.of("hard-d-lazy-fg")).toBe(3);
  });

  it("re-runs after a delete-only change, which advances no state vector", async () => {
    const bg = openDoc("hard-d-delete", "Background delete text");
    claudeComment(bg, "c_keep", { relRange: undefined });
    claudeComment(bg, "c_drop");
    openDoc("hard-d-delete-fg", "Foreground text", { active: true });
    await poll();
    await poll();
    const reads = countDocumentReads();
    await poll();
    expect(reads.of("hard-d-delete")).toBe(0); // settled and skipped

    const before = Y.encodeStateVector(bg);
    withInternal(bg, () => bg.getMap(Y_MAP_ANNOTATIONS).delete("c_drop"));
    // Why the counter is not the state vector: this change is invisible to it.
    expect(Y.encodeStateVector(bg)).toEqual(before);

    await poll();
    expect(reads.of("hard-d-delete")).toBe(1);
  });

  it("re-runs on a Solo → Tandem flip and releases the held comment", async () => {
    setCtrlMode("solo");
    const bg = openDoc("hard-d-solo", "Background solo text");
    userComment(bg, "u_held");
    openDoc("hard-d-solo-fg", "Foreground text", { active: true });
    await poll();
    await poll(); // the fixed point under Solo
    const reads = countDocumentReads();
    const held = await poll();
    expect(reads.of("hard-d-solo")).toBe(0);
    expect(held.userActions).toEqual([]);

    setCtrlMode("tandem");
    const released = await poll();
    expect(released.userActions.map((a) => a.id)).toEqual(["u_held"]);
  });

  it("re-runs after resetInbox, so an emptied ledger re-surfaces", async () => {
    const bg = openDoc("hard-d-reset", "Background reset text");
    userComment(bg, "u_reset");
    openDoc("hard-d-reset-fg", "Foreground text", { active: true });
    expect((await poll()).userActions.map((a) => a.id)).toEqual(["u_reset"]);
    await poll();
    const reads = countDocumentReads();
    await poll();
    expect(reads.of("hard-d-reset")).toBe(0);

    resetInbox();
    expect((await poll()).userActions.map((a) => a.id)).toEqual(["u_reset"]);
  });

  it("re-runs a document that becomes active, and returns its activity", async () => {
    const bg = openDoc("hard-d-active", "Background active text");
    withInternal(bg, () =>
      bg
        .getMap(Y_MAP_USER_AWARENESS)
        .set(Y_MAP_ACTIVITY, { isTyping: false, cursor: 7, lastEdit: 1 }),
    );
    openDoc("hard-d-active-fg", "Foreground text", { active: true });
    await poll();
    await poll();
    const reads = countDocumentReads();
    await poll();
    expect(reads.of("hard-d-active")).toBe(0);

    setActiveDocId("hard-d-active");
    const data = await poll();
    expect(reads.of("hard-d-active")).toBe(1);
    expect(data.activity.documentId).toBe("hard-d-active");
    expect(data.activity.cursor).toBe(7);
  });

  it("never consults the cache on a named poll", async () => {
    openDoc("hard-d-named", "Background named text");
    openDoc("hard-d-named-fg", "Foreground text", { active: true });
    await poll();
    await poll();
    const reads = countDocumentReads();
    await poll();
    expect(reads.of("hard-d-named")).toBe(0);

    await poll({ documentId: "hard-d-named" });
    expect(reads.of("hard-d-named")).toBe(1);
  });

  it("keeps re-reading a document whose record is refused", async () => {
    captureStderr();
    const bg = openDoc("hard-d-refused", "Background refused text");
    userComment(bg, "u_refused", { content: 42, relRange: undefined });
    openDoc("hard-d-refused-fg", "Foreground text", { active: true });
    await poll();
    await poll();
    const reads = countDocumentReads();
    const data = await poll();
    expect(reads.of("hard-d-refused")).toBe(1);
    expect(data.summary).toContain("1 item in hard-d-refused.md could not be returned");
  });
});

// ── E: the delivery round waits for the item ──────────────────────────────────

describe("E: the delivery round stays open while its item was not handed over", () => {
  function attachConsumer(docId: string, ydoc: Y.Doc) {
    attachObservers(docId, ydoc);
    const consumer = () => {};
    subscribe(consumer, "external");
    onTestFinished(() => {
      unsubscribe(consumer);
      detachObservers(docId);
    });
  }

  function browserComment(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}) {
    withBrowser(ydoc, () =>
      ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
        id,
        author: "user",
        type: "comment",
        audience: "outbound",
        range: { from: 0, to: 5 },
        content: "pushed",
        status: "pending",
        textSnapshot: "Backg",
        timestamp: 1,
        rev: 1,
        ...extra,
      }),
    );
  }

  it("a document isolated as unreadable holds its forward's round open", async () => {
    setCtrlMode("tandem");
    captureStderr();
    const bg = openDoc("hard-e-throw", "Background throw text");
    openDoc("hard-e-throw-fg", "Foreground text", { active: true });
    attachConsumer("hard-e-throw", bg);
    browserComment(bg, "u_e_throw");
    expect(getDeliveryState(Date.now(), 1).state).toBe("awaiting-poll");

    const real = YDocStore.prototype.listAnnotations;
    const spy = vi.spyOn(YDocStore.prototype, "listAnnotations").mockImplementation(function (
      this: YDocStore,
    ) {
      if (this.documentId === "hard-e-throw") throw new Error("read failed");
      return real.call(this);
    });
    const unreadable = await poll();
    expect(unreadable.summary).toContain("Could not read document hard-e-throw");
    expect(getDeliveryState(Date.now(), 1).state).toBe("awaiting-poll");

    spy.mockRestore();
    const delivered = await poll();
    expect(delivered.userActions.map((a) => a.id)).toEqual(["u_e_throw"]);
    expect(getDeliveryState(Date.now(), 1).state).toBe("polled");
  });

  it("a refused record does not hold the round: the summary reported it", async () => {
    setCtrlMode("tandem");
    captureStderr();
    const doc = openDoc("hard-e-drop", "Background drop text", { active: true });
    attachConsumer("hard-e-drop", doc);
    // A stale malformed record nobody is waiting on (no event: internal write).
    userComment(doc, "u_e_stale_bad", { content: 42 });
    browserComment(doc, "u_e_ok");
    expect(getDeliveryState(Date.now(), 1).state).toBe("awaiting-poll");

    const first = await poll();
    expect(first.userActions.map((a) => a.id)).toEqual(["u_e_ok"]);
    expect(getDeliveryState(Date.now(), 1).state).toBe("polled");

    // The forward IS for a malformed record. The poll reports it as a drop
    // and closes the round: holding it would pin `awaiting-poll` for as long
    // as the record stays malformed, i.e. for the life of the process.
    browserComment(doc, "u_e_bad", { content: 42 });
    expect(getDeliveryState(Date.now(), 1).state).toBe("awaiting-poll");
    const second = await poll();
    expect(second.summary).toContain("could not be returned");
    expect(getDeliveryState(Date.now(), 1).state).toBe("polled");
  });
});

// ── F: alreadyPushed is document-scoped ───────────────────────────────────────

describe("F: alreadyPushed answers for the item's own document", () => {
  it("stamps the pushed document's copy of a shared id, not the other's", async () => {
    setCtrlMode("tandem");
    const shared = "import-shared-f";
    const pushed = openDoc("hard-f-pushed", "Shared imported text");
    const quiet = openDoc("hard-f-quiet", "Shared imported text", { active: true });
    attachObservers("hard-f-pushed", pushed);
    const consumer = () => {};
    subscribe(consumer, "external");
    onTestFinished(() => {
      unsubscribe(consumer);
      detachObservers("hard-f-pushed");
    });
    withBrowser(pushed, () =>
      pushed.getMap(Y_MAP_ANNOTATIONS).set(shared, {
        id: shared,
        author: "user",
        type: "comment",
        audience: "outbound",
        range: { from: 0, to: 5 },
        content: "Word comment",
        status: "pending",
        timestamp: 1,
      }),
    );
    userComment(quiet, shared, { content: "Word comment" });

    const data = await poll();
    const byDoc = Object.fromEntries(data.userActions.map((a) => [a.documentId, a.alreadyPushed]));
    expect(byDoc).toEqual({ "hard-f-pushed": true, "hard-f-quiet": undefined });
  });
});

// ── G / H / J ─────────────────────────────────────────────────────────────────

describe("G: an unreadable active document is still named by activity", () => {
  it("names the active document and leaves its fields empty", async () => {
    captureStderr();
    const active = openDoc("hard-g-active", "Active text", { active: true });
    withInternal(active, () =>
      active
        .getMap(Y_MAP_USER_AWARENESS)
        .set(Y_MAP_ACTIVITY, { isTyping: true, cursor: 3, lastEdit: 1 }),
    );
    const spy = vi.spyOn(YDocStore.prototype, "getUserAwareness").mockImplementation(() => {
      throw new Error("awareness read failed");
    });
    onTestFinished(() => spy.mockRestore());

    const data = await poll();
    expect(data.summary).toContain("Could not read document hard-g-active");
    expect(data.activity).toEqual({
      documentId: "hard-g-active",
      isTyping: false,
      cursor: null,
      lastEdit: null,
      selectedText: null,
      selectionAt: null,
    });
  });
});

describe("H: a store that throws while resolving is isolated on a default poll", () => {
  it("skips that document and still returns the others; a named poll errors", async () => {
    captureStderr();
    openDoc("hard-h-broken", "Broken text");
    const healthy = openDoc("hard-h-healthy", "Healthy text", { active: true });
    userComment(healthy, "u_h_healthy");
    const real = vi.mocked(getDocumentStore).getMockImplementation();
    vi.mocked(getDocumentStore).mockImplementation((id?: string) => {
      if (id === "hard-h-broken") throw new Error("store resolution failed");
      return real ? real(id) : null;
    });
    onTestFinished(() => {
      if (real) vi.mocked(getDocumentStore).mockImplementation(real);
    });

    const data = await poll();
    expect(data.userActions.map((a) => a.id)).toEqual(["u_h_healthy"]);
    expect(data.summary).toContain("Could not read document hard-h-broken");

    const named = parseResult(await pollRaw({ documentId: "hard-h-broken" }));
    expect(named.error).toBe(true);
  });
});

describe("J: colliding basenames are told apart by documentId", () => {
  it("renders <basename> (<documentId>) when a background file shares the active one's name", async () => {
    const bg = openDoc("hard-j-bg", "Background text", { filePath: "/tmp/a/notes.md" });
    userComment(bg, "u_j");
    openDoc("hard-j-fg", "Foreground text", { active: true, filePath: "/tmp/b/notes.md" });

    const data = await poll();
    expect(data.summary).toContain("documents other than the active one: notes.md (hard-j-bg).");
  });

  it("keeps the bare basename when nothing collides", async () => {
    const bg = openDoc("hard-j-solo-bg", "Background text", { filePath: "/tmp/a/plan.md" });
    userComment(bg, "u_j_solo");
    openDoc("hard-j-solo-fg", "Foreground text", { active: true, filePath: "/tmp/b/notes.md" });

    const data = await poll();
    expect(data.summary).toContain("documents other than the active one: plan.md.");
  });
});

describe("the tool description", () => {
  it("says which follow-up tools find the document and which target the active one", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === "tandem_checkInbox")?.description ?? "";
    expect(description).not.toContain("because a call without one targets the active document");
    expect(description).toContain(
      "the id-keyed tools (tandem_resolveAnnotation, tandem_editAnnotation, tandem_removeAnnotation, tandem_annotationReply) find the item's document themselves",
    );
    expect(description).toContain(
      "the range-keyed ones (tandem_comment, tandem_edit) target the active document when called without one",
    );
  });
});
