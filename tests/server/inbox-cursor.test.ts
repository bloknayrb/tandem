/**
 * The caller-held `tandem_checkInbox` cursor (#2064, #2294).
 *
 * #2064: one reader's poll drained the process-wide ledger, so a second Claude
 * session never saw the items. #2294: the ledger and the chat `read` stamp were
 * committed before the response was delivered, so a lost response lost its
 * items. Under the cursor contract each reader's position lives in the cursor it
 * passes back, items repeat until acknowledged, and chat is stamped read on the
 * acknowledgement.
 *
 * Every row drives the REGISTERED handler over the in-memory MCP harness, so
 * the SDK's structured-output validation is in the loop. The cursor-less
 * contract keeps every other inbox suite green unmodified — that is the
 * compatibility proof; the rows below pin only what is new.
 */

import { readFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type * as Y from "yjs";
import { z } from "zod";
import { isStoreReadOnly } from "../../src/server/annotations/store.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { resetForTesting as resetEventQueue } from "../../src/server/events/queue.js";
import {
  appendClaudeChatMessage,
  registerAwarenessTools,
  resetInbox,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { getDocumentStore, YDocStore } from "../../src/server/mcp/document-store.js";
import {
  DeliveryRegistry,
  decodeCursor,
  deliveryRegistry,
  encodeCursor,
  MAX_CURSOR_ENTRIES,
  MAX_CURSOR_LENGTH,
  type ReaderCursor,
  type RegistryEntry,
  type ScopeView,
  seenBy,
} from "../../src/server/mcp/inbox-cursor.js";
import { checkInboxOutputShape } from "../../src/server/mcp/output-schemas.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import type { ChatMessage } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";

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
  setCtrlMode("tandem");
  ({ client, close } = await setupMcpServer([registerAwarenessTools]));
});

afterEach(async () => {
  await close?.();
  close = undefined;
});

/** Open a document; ids must be unique per test, since Y.Docs outlive a test. */
function openDoc(id: string, opts: { active?: boolean } = {}) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, "Some document text");
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  if (opts.active) setActiveDocId(id);
  return ydoc;
}

function userComment(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}) {
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 4 },
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

function userReply(ydoc: Y.Doc, id: string, annotationId: string) {
  withInternal(ydoc, () =>
    ydoc
      .getMap(Y_MAP_ANNOTATION_REPLIES)
      .set(id, { id, annotationId, author: "user", text: "a reply", timestamp: 2 }),
  );
}

function chatMap() {
  return getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT);
}

function userChat(id: string) {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () =>
    chatMap().set(id, { id, author: "user", text: "hello", timestamp: 3, read: false }),
  );
}

async function pollRaw(args: { documentId?: string; cursor?: string } = {}) {
  return client.callTool({ name: "tandem_checkInbox", arguments: args });
}

async function poll(args: { documentId?: string; cursor?: string } = {}): Promise<Inbox> {
  const result = await pollRaw(args);
  expect(parseResult(result).error, JSON.stringify(result)).toBe(false);
  return inboxSchema.parse((result as { structuredContent: unknown }).structuredContent);
}

/** Every item id a poll returned, by bucket, for whole-response comparisons. */
function ids(data: Inbox) {
  return {
    userActions: data.userActions.map((a) => a.id),
    userResponses: data.userResponses.map((a) => `${a.id}:${a.status}`),
    userReplies: data.userReplies.map((r) => r.id),
    chatMessages: data.chatMessages.map((m) => m.id),
  };
}

function allIds(data: Inbox): string[] {
  const all = ids(data);
  return [...all.userActions, ...all.userResponses, ...all.userReplies, ...all.chatMessages];
}

function captureStderr() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
}

describe("#2064: one reader's poll never hides an item from another", () => {
  it("a user reply on a Claude annotation reaches both readers, whoever polls first", async () => {
    const doc = openDoc("cur-2064", { active: true });
    claudeComment(doc, "c_parent");
    // Both sessions are already polling before the user replies.
    const a0 = (await poll({ cursor: "start" })).cursor;
    const b0 = (await poll({ cursor: "start" })).cursor;

    userReply(doc, "r_user", "c_parent");
    userComment(doc, "u_comment");
    userChat("msg_1");

    const a1 = await poll({ cursor: a0 });
    expect(ids(a1)).toEqual({
      userActions: ["u_comment"],
      userResponses: [],
      userReplies: ["r_user"],
      chatMessages: ["msg_1"],
    });
    // A acknowledges (its next poll), which stamps the chat read.
    const a2 = await poll({ cursor: a1.cursor });
    expect(allIds(a2)).toEqual([]);
    expect((chatMap().get("msg_1") as ChatMessage).read).toBe(true);

    // B is still owed every one of them.
    const b1 = await poll({ cursor: b0 });
    expect(ids(b1)).toEqual(ids(a1));
  });
});

describe("#2294: an item repeats until it is acknowledged", () => {
  it("polling again with the same cursor returns the same items; the next cursor does not", async () => {
    const doc = openDoc("cur-2294", { active: true });
    const c0 = (await poll({ cursor: "start" })).cursor;
    userComment(doc, "u_lost");
    userChat("msg_lost");

    const first = await poll({ cursor: c0 });
    expect(allIds(first)).toEqual(["u_lost", "msg_lost"]);
    // The response was lost: the caller still holds c0.
    const retry = await poll({ cursor: c0 });
    expect(ids(retry)).toEqual(ids(first));
    expect(retry.cursor).toBe(first.cursor);

    const acked = await poll({ cursor: retry.cursor });
    expect(allIds(acked)).toEqual([]);
    expect(acked.hasNew).toBe(false);
  });

  it("a response that fails validation hands out no cursor, and the next poll returns the same items", async () => {
    captureStderr();
    const doc = openDoc("cur-invalid", { active: true });
    const c0 = (await poll({ cursor: "start" })).cursor;
    userComment(doc, "u_invalid");
    vi.mocked(isStoreReadOnly).mockReturnValueOnce("no" as unknown as boolean);
    const broken = parseResult(await pollRaw({ cursor: c0 }));
    expect(broken.error).toBe(true);
    expect(allIds(await poll({ cursor: c0 }))).toEqual(["u_invalid"]);
  });
});

describe("chat read moves behind the acknowledgement", () => {
  it("stays unread on the returning poll, is stamped on the acknowledging one, and a repeat writes nothing", async () => {
    openDoc("cur-chat", { active: true });
    userChat("msg_ack");
    const returned = await poll({ cursor: "start" });
    expect(returned.chatMessages.map((m) => m.id)).toEqual(["msg_ack"]);
    expect((chatMap().get("msg_ack") as ChatMessage).read).toBe(false);

    await poll({ cursor: returned.cursor });
    expect((chatMap().get("msg_ack") as ChatMessage).read).toBe(true);

    // `afterTransaction` fires for EVERY transaction, empty ones included, so
    // this pins "opens no transaction", not just "changes nothing".
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    let transactions = 0;
    const count = () => {
      transactions += 1;
    };
    ctrl.on("afterTransaction", count);
    onTestFinished(() => ctrl.off("afterTransaction", count));
    await poll({ cursor: returned.cursor });
    expect(transactions).toBe(0);
  });

  it("a cursor-less poll still stamps chat read on return and hands back `start`", async () => {
    userChat("msg_legacy");
    const data = await poll();
    expect(data.chatMessages.map((m) => m.id)).toEqual(["msg_legacy"]);
    expect(data.cursor).toBe("start");
    expect((chatMap().get("msg_legacy") as ChatMessage).read).toBe(true);
    // An empty string is treated as omitted.
    expect((await poll({ cursor: "" })).cursor).toBe("start");
  });

  it("chat a cursor-less caller drained still reaches a cursor reader whose mark is below it", async () => {
    const before = (await poll({ cursor: "start" })).cursor;
    userChat("msg_drained");
    expect((await poll()).chatMessages.map((m) => m.id)).toEqual(["msg_drained"]);
    expect((await poll({ cursor: before })).chatMessages.map((m) => m.id)).toEqual(["msg_drained"]);
    // …but not a FRESH reader: the cursor-less return counts as acknowledged.
    expect((await poll({ cursor: "start" })).chatMessages).toEqual([]);
  });

  it("a message real Claude answered with replyTo is not repeated; one the local model answered is", async () => {
    const b0 = (await poll({ cursor: "start" })).cursor;
    userChat("msg_answered");
    userChat("msg_local");
    const a = await poll({ cursor: "start" });
    expect(a.chatMessages.map((m) => m.id).sort()).toEqual(["msg_answered", "msg_local"]);
    await client.callTool({
      name: "tandem_reply",
      arguments: { text: "on it", replyTo: "msg_answered" },
    });
    expect(
      appendClaudeChatMessage("local answer", {
        replyTo: "msg_local",
        agentIdentity: { provider: "local-ollama", displayName: "Local" },
      }).ok,
    ).toBe(true);
    expect((await poll({ cursor: b0 })).chatMessages.map((m) => m.id)).toEqual(["msg_local"]);
  });
});

describe("per-reader ledger semantics", () => {
  it("`edited` is per reader", async () => {
    const doc = openDoc("cur-edited", { active: true });
    const b0 = (await poll({ cursor: "start" })).cursor;
    userComment(doc, "u_edit");
    const a1 = await poll({ cursor: "start" });
    expect(a1.userActions[0]?.edited).toBeUndefined();
    userComment(doc, "u_edit", { content: "changed", editedAt: 50 });
    const a2 = await poll({ cursor: a1.cursor });
    expect(a2.userActions.map((a) => [a.id, a.edited])).toEqual([["u_edit", true]]);
    // B never saw the first version, so for B it is simply new.
    const b1 = await poll({ cursor: b0 });
    expect(b1.userActions.map((a) => [a.id, a.edited])).toEqual([["u_edit", undefined]]);
  });

  it("accept → poll → undo → dismiss → poll reports the dismissal (#1770)", async () => {
    const doc = openDoc("cur-1770", { active: true });
    claudeComment(doc, "c_undo");
    let c = (await poll({ cursor: "start" })).cursor;
    claudeComment(doc, "c_undo", { status: "accepted" });
    const accepted = await poll({ cursor: c });
    expect(ids(accepted).userResponses).toEqual(["c_undo:accepted"]);
    c = accepted.cursor;
    claudeComment(doc, "c_undo", { status: "pending" });
    c = (await poll({ cursor: c })).cursor;
    claudeComment(doc, "c_undo", { status: "dismissed" });
    expect(ids(await poll({ cursor: c })).userResponses).toEqual(["c_undo:dismissed"]);
  });
});

describe("an item another reader was handed is not lost when this reader's mark passes it while it does not qualify", () => {
  // Readers A and B both poll before the item exists; B is handed it first,
  // then it stops qualifying, A's mark passes it, and it qualifies again at the
  // SAME version. A must still be handed it. B is handed it again: the registry
  // cannot tell B from A without per-reader state, so this resolves toward a
  // duplicate, never a loss.
  async function twoReaders(docId: string) {
    const doc = openDoc(docId, { active: true });
    const a0 = (await poll({ cursor: "start" })).cursor;
    const b0 = (await poll({ cursor: "start" })).cursor;
    return { doc, a0, b0 };
  }

  it("a user comment dismissed and then undone", async () => {
    const { doc, a0, b0 } = await twoReaders("cur-pass-undo");
    userComment(doc, "u_c");
    const b1 = await poll({ cursor: b0 });
    expect(ids(b1).userActions).toEqual(["u_c"]);
    userComment(doc, "u_c", { status: "dismissed" });
    const a1 = await poll({ cursor: a0 });
    expect(ids(a1).userActions).toEqual([]);
    userComment(doc, "u_c", { status: "pending" });
    expect(ids(await poll({ cursor: a1.cursor })).userActions).toEqual(["u_c"]);
    expect(ids(await poll({ cursor: b1.cursor })).userActions).toEqual(["u_c"]);
  });

  it("a Claude annotation accepted, undone, and accepted again (#1770 across readers)", async () => {
    const { doc, a0, b0 } = await twoReaders("cur-pass-reaccept");
    claudeComment(doc, "c_x");
    claudeComment(doc, "c_x", { status: "accepted" });
    const b1 = await poll({ cursor: b0 });
    expect(ids(b1).userResponses).toEqual(["c_x:accepted"]);
    claudeComment(doc, "c_x", { status: "pending" });
    const a1 = await poll({ cursor: a0 });
    expect(ids(a1).userResponses).toEqual([]);
    claudeComment(doc, "c_x", { status: "accepted" });
    expect(ids(await poll({ cursor: a1.cursor })).userResponses).toEqual(["c_x:accepted"]);
  });

  it("a record deleted and restored verbatim", async () => {
    const { doc, a0, b0 } = await twoReaders("cur-pass-restore");
    userComment(doc, "u_r");
    expect(ids(await poll({ cursor: b0 })).userActions).toEqual(["u_r"]);
    withInternal(doc, () => doc.getMap(Y_MAP_ANNOTATIONS).delete("u_r"));
    const a1 = await poll({ cursor: a0 });
    expect(ids(a1).userActions).toEqual([]);
    userComment(doc, "u_r");
    expect(ids(await poll({ cursor: a1.cursor })).userActions).toEqual(["u_r"]);
  });

  it("a user reply deleted and restored verbatim", async () => {
    const { doc, a0, b0 } = await twoReaders("cur-pass-reply");
    claudeComment(doc, "c_parent");
    userReply(doc, "r_back", "c_parent");
    expect(ids(await poll({ cursor: b0 })).userReplies).toEqual(["r_back"]);
    withInternal(doc, () => doc.getMap(Y_MAP_ANNOTATION_REPLIES).delete("r_back"));
    const a1 = await poll({ cursor: a0 });
    expect(ids(a1).userReplies).toEqual([]);
    userReply(doc, "r_back", "c_parent");
    expect(ids(await poll({ cursor: a1.cursor })).userReplies).toEqual(["r_back"]);
  });

  it("the same, when the item was drained by a cursor-less poll", async () => {
    const doc = openDoc("cur-pass-legacy", { active: true });
    const a0 = (await poll({ cursor: "start" })).cursor;
    userComment(doc, "u_l");
    expect(ids(await poll()).userActions).toEqual(["u_l"]);
    userComment(doc, "u_l", { status: "dismissed" });
    const a1 = await poll({ cursor: a0 });
    expect(ids(a1).userActions).toEqual([]);
    userComment(doc, "u_l", { status: "pending" });
    expect(ids(await poll({ cursor: a1.cursor })).userActions).toEqual(["u_l"]);
    // The cursor-less reader keeps its own ledger: it had the comment already.
    expect(ids(await poll()).userActions).toEqual([]);
  });

  it("a reader that already holds a newer version does not re-owe an older one to others", async () => {
    const { doc, a0, b0 } = await twoReaders("cur-pass-regress");
    userComment(doc, "u_v", { editedAt: 5 });
    const a1 = await poll({ cursor: a0 });
    expect(ids(a1).userActions).toEqual(["u_v"]);
    // `editedAt` goes backwards (clock skew, a forged write): B is handed it.
    userComment(doc, "u_v", { editedAt: 3 });
    const b1 = await poll({ cursor: b0 });
    expect(ids(b1).userActions).toEqual(["u_v"]);
    // A's own ledger dedups it, and its pass retires B's version. B's mark
    // also covers the newer version (a lower seq), so B is not handed it again.
    await poll({ cursor: a1.cursor });
    expect(ids(await poll({ cursor: b1.cursor })).userActions).toEqual([]);
  });

  it("a single reader that was handed the item sees no change from the legacy contract", async () => {
    const doc = openDoc("cur-pass-single", { active: true });
    userComment(doc, "u_s");
    const a1 = await poll({ cursor: "start" });
    expect(ids(a1).userActions).toEqual(["u_s"]);
    userComment(doc, "u_s", { status: "dismissed" });
    const a2 = await poll({ cursor: a1.cursor });
    userComment(doc, "u_s", { status: "pending" });
    expect(ids(await poll({ cursor: a2.cursor })).userActions).toEqual([]);
  });
});

describe("documents a poll does not read keep their position", () => {
  it("a named poll does not advance another document's mark", async () => {
    const one = openDoc("cur-named-1", { active: true });
    const two = openDoc("cur-named-2");
    const a0 = (await poll({ cursor: "start" })).cursor;
    userComment(one, "u_one");
    userComment(two, "u_two");
    // Another reader is handed both first, so both are registered.
    await poll({ cursor: "start" });

    const named = await poll({ cursor: a0, documentId: "cur-named-2" });
    expect(named.userActions.map((a) => a.id)).toEqual(["u_two"]);
    const rest = await poll({ cursor: named.cursor });
    expect(rest.userActions.map((a) => a.id)).toEqual(["u_one"]);
  });

  it("a document whose pass threw keeps its mark, and its items come back", async () => {
    captureStderr();
    const broken = openDoc("cur-throw-broken");
    openDoc("cur-throw-ok", { active: true });
    const a0 = (await poll({ cursor: "start" })).cursor;
    userComment(broken, "u_broken");
    await poll({ cursor: "start" }); // registers u_broken

    const real = vi.mocked(getDocumentStore).getMockImplementation();
    vi.mocked(getDocumentStore).mockImplementation((id?: string) => {
      if (id === "cur-throw-broken") throw new Error("store resolution failed");
      return real ? real(id) : null;
    });
    const threw = await poll({ cursor: a0 });
    if (real) vi.mocked(getDocumentStore).mockImplementation(real);
    expect(threw.summary).toContain("Could not read document cur-throw-broken");

    expect((await poll({ cursor: threw.cursor })).userActions.map((a) => a.id)).toEqual([
      "u_broken",
    ]);
  });
});

describe("the Solo hold survives a mark that passes a held item", () => {
  async function shownToB(docId: string) {
    const doc = openDoc(docId, { active: true });
    openDoc(`${docId}-other`);
    const a0 = (await poll({ cursor: "start" })).cursor;
    userComment(doc, "u_held");
    expect((await poll({ cursor: "start" })).userActions.map((a) => a.id)).toEqual(["u_held"]);
    setCtrlMode("solo");
    const solo = await poll({ cursor: a0 });
    expect(solo.userActions).toEqual([]);
    // The summary never counts or names what Solo withholds.
    expect(solo.summary).toBe("No new actions.");
    return solo.cursor;
  }

  it("released on the next default poll", async () => {
    const held = await shownToB("cur-solo-plain");
    setCtrlMode("tandem");
    expect((await poll({ cursor: held })).userActions.map((a) => a.id)).toEqual(["u_held"]);
  });

  it("across a named poll of another document", async () => {
    const held = await shownToB("cur-solo-named");
    const named = await poll({ cursor: held, documentId: "cur-solo-named-other" });
    setCtrlMode("tandem");
    expect((await poll({ cursor: named.cursor })).userActions.map((a) => a.id)).toEqual(["u_held"]);
  });

  it("across a default poll on which the held document threw", async () => {
    captureStderr();
    const held = await shownToB("cur-solo-throw");
    const real = vi.mocked(getDocumentStore).getMockImplementation();
    vi.mocked(getDocumentStore).mockImplementation((id?: string) => {
      if (id === "cur-solo-throw") throw new Error("store resolution failed");
      return real ? real(id) : null;
    });
    const threw = await poll({ cursor: held });
    if (real) vi.mocked(getDocumentStore).mockImplementation(real);
    setCtrlMode("tandem");
    expect((await poll({ cursor: threw.cursor })).userActions.map((a) => a.id)).toEqual(["u_held"]);
  });
});

describe("a fresh reader's floor", () => {
  it("is not handed what another reader acknowledged, but is handed what was only returned", async () => {
    const doc = openDoc("cur-floor", { active: true });
    claudeComment(doc, "c_floor");
    const a0 = (await poll({ cursor: "start" })).cursor;
    userReply(doc, "r_acked", "c_floor");
    userReply(doc, "r_returned", "c_floor");

    const a1 = await poll({ cursor: a0 });
    expect(a1.userReplies.map((r) => r.id).sort()).toEqual(["r_acked", "r_returned"]);
    // Returned to A but not yet acknowledged: a new session gets both.
    expect((await poll({ cursor: "start" })).userReplies.map((r) => r.id).sort()).toEqual([
      "r_acked",
      "r_returned",
    ]);
    // A acknowledges. A new session is not handed the history again.
    await poll({ cursor: a1.cursor });
    expect((await poll({ cursor: "start" })).userReplies).toEqual([]);
    // Something genuinely new still reaches it.
    userReply(doc, "r_new", "c_floor");
    expect((await poll({ cursor: "start" })).userReplies.map((r) => r.id)).toEqual(["r_new"]);
  });
});

describe("cursors this server cannot vouch for read as fresh", () => {
  async function staleSummary(cursor: string) {
    openDoc(`cur-bad-${allocated++}`, { active: true });
    userChat(`msg_bad_${allocated}`);
    const data = await poll({ cursor });
    expect(data.chatMessages.map((m) => m.id)).toEqual([`msg_bad_${allocated}`]);
    return data.summary;
  }
  let allocated = 0;
  const NOTE = "The cursor was not recognised";

  it("`start` carries no note", async () => {
    expect(await staleSummary("start")).not.toContain(NOTE);
  });

  it.each([
    ["malformed", "not a cursor!"],
    ["not JSON", Buffer.from("{oops", "utf8").toString("base64url")],
    ["oversize", "A".repeat(MAX_CURSOR_LENGTH + 1)],
    [
      "__proto__ document key",
      Buffer.from(JSON.stringify({ v: 1, e: "x", m: 0, c: [0], d: { __proto__: [1] } })).toString(
        "base64url",
      ),
    ],
  ])("%s", async (_label, cursor) => {
    expect(await staleSummary(cursor)).toContain(NOTE);
  });

  it("a foreign epoch, and a reset (restart)", async () => {
    const minted = (await poll({ cursor: "start" })).cursor;
    resetInbox();
    expect(await staleSummary(minted)).toContain(NOTE);
  });

  it("CTRL_ROOM as a document key", async () => {
    const wire = { v: 1, e: deliveryRegistry.epoch, m: 0, c: [0], d: [[CTRL_ROOM, 0]] };
    expect(await staleSummary(Buffer.from(JSON.stringify(wire)).toString("base64url"))).toContain(
      NOTE,
    );
  });
});

describe("the quiet-document skip, per reader", () => {
  function countReads() {
    const reads = new Map<string, number>();
    const real = YDocStore.prototype.listAnnotations;
    const spy = vi.spyOn(YDocStore.prototype, "listAnnotations").mockImplementation(function (
      this: YDocStore,
    ) {
      reads.set(this.documentId, (reads.get(this.documentId) ?? 0) + 1);
      return real.call(this);
    });
    onTestFinished(() => spy.mockRestore());
    return (id: string) => reads.get(id) ?? 0;
  }

  it("skips a quiet background document only for a reader at or above the recorded mark", async () => {
    openDoc("cur-quiet-fg", { active: true });
    const bg = openDoc("cur-quiet-bg");
    const low = (await poll({ cursor: "start" })).cursor;
    userComment(bg, "u_quiet");
    const a1 = await poll({ cursor: "start" });
    expect(a1.userActions.map((a) => a.id)).toEqual(["u_quiet"]);
    // A's acknowledging pass is a quiet fixed point for A, and is recorded.
    const a2 = await poll({ cursor: a1.cursor });
    const reads = countReads();
    await poll({ cursor: a2.cursor });
    expect(reads("cur-quiet-bg")).toBe(0);

    // A reader whose mark predates the item is not skipped, and gets it.
    const b = await poll({ cursor: low });
    expect(reads("cur-quiet-bg")).toBe(1);
    expect(b.userActions.map((a) => a.id)).toEqual(["u_quiet"]);
  });
});

// ── The codec, directly ─────────────────────────────────────────────────────

describe("the cursor codec", () => {
  function registryWith(scopes: string[], perScope: number): DeliveryRegistry {
    const registry = new DeliveryRegistry();
    for (const scope of scopes) {
      for (let i = 0; i < perScope; i++) registry.assign("a", scope, `${scope}:ann${i}`, 0);
    }
    return registry;
  }

  function owedSeqs(view: ScopeView, entries: readonly RegistryEntry[]): number[] {
    return entries.filter((e) => !seenBy(view, e)).map((e) => e.seq);
  }

  it("round-trips a cursor", () => {
    const registry = registryWith(["doc-a", "doc-b"], 3);
    const cursor: ReaderCursor = {
      m: 6,
      docs: new Map([["doc-a", { mark: 2, held: new Set([1]) }]]),
      chat: { mark: 4, held: new Set() },
    };
    const decoded = decodeCursor(encodeCursor(cursor, registry), registry);
    expect(decoded.recognised).toBe(true);
    expect(decoded.cursor.m).toBe(6);
    expect(decoded.cursor.docs.get("doc-a")).toEqual({ mark: 2, held: new Set([1]) });
    expect(decoded.cursor.chat.mark).toBe(4);
  });

  it("folds a maximal cursor to fit, losing nothing that was owed", () => {
    // 300 documents with 23-character ids, each holding 300 seqs: far past
    // both the size budget and the entry caps.
    const scopes = Array.from({ length: 300 }, (_, i) => `doc-${String(i).padStart(19, "0")}`);
    const registry = registryWith(scopes, 310);
    const docs = new Map<string, ScopeView>();
    for (const scope of scopes) {
      const entries = registry.entriesIn(scope);
      const held = new Set(entries.slice(0, 300).map((e) => e.seq));
      docs.set(scope, { mark: entries[305]?.seq ?? 0, held });
    }
    const cursor: ReaderCursor = { m: registry.counter, docs, chat: { mark: 0, held: new Set() } };
    const encoded = encodeCursor(cursor, registry);
    expect(encoded.length).toBeLessThanOrEqual(MAX_CURSOR_LENGTH);
    const decoded = decodeCursor(encoded, registry);
    expect(decoded.recognised).toBe(true);
    expect(decoded.cursor.docs.size).toBeLessThanOrEqual(MAX_CURSOR_ENTRIES);
    for (const scope of scopes) {
      const entries = registry.entriesIn(scope);
      const before = owedSeqs(docs.get(scope) as ScopeView, entries);
      const view = decoded.cursor.docs.get(scope) ?? { mark: decoded.cursor.m, held: new Set() };
      const after = new Set(owedSeqs(view, entries));
      for (const seq of before) expect(after.has(seq), `${scope} lost seq ${seq}`).toBe(true);
    }
  });

  it("caps one held list by lowering the mark, never by dropping a held seq", () => {
    const registry = registryWith(["doc-cap"], 400);
    const entries = registry.entriesIn("doc-cap");
    const held = new Set(entries.slice(0, 300).map((e) => e.seq));
    const cursor: ReaderCursor = {
      m: registry.counter,
      docs: new Map([["doc-cap", { mark: registry.counter, held }]]),
      chat: { mark: 0, held: new Set() },
    };
    const decoded = decodeCursor(encodeCursor(cursor, registry), registry);
    const view = decoded.cursor.docs.get("doc-cap") ?? { mark: decoded.cursor.m, held: new Set() };
    expect(view.held.size).toBeLessThanOrEqual(MAX_CURSOR_ENTRIES);
    for (const seq of held) {
      const entry = entries.find((e) => e.seq === seq) as RegistryEntry;
      expect(seenBy(view, entry)).toBe(false);
    }
  });
});

describe("no per-client state", () => {
  it("the cursor module and the inbox handler never import transport or session identity", () => {
    for (const file of ["src/server/mcp/inbox-cursor.ts", "src/server/mcp/awareness.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from "[^"]*transport-registry/);
      if (file.endsWith("inbox-cursor.ts")) {
        expect(source, file).not.toMatch(/from "[^"]*sessions\/context/);
        expect(source, file).not.toMatch(/getCurrentSessionId|Mcp-Session-Id"/);
      }
    }
    // awareness.ts imports `getCurrentSessionId` for tandem_reply's
    // supervisor notification only; the inbox handler must not read it.
    const awareness = readFileSync("src/server/mcp/awareness.ts", "utf8");
    const handler = awareness.slice(
      awareness.indexOf('"tandem_checkInbox",'),
      awareness.indexOf('"tandem_reply",'),
    );
    expect(handler).not.toContain("getCurrentSessionId");
  });
});
