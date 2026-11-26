/**
 * #2360 PR A (ships dark behind `OWNERSHIP_ENABLED`): Claude replies inside a
 * user's comment thread, and the reply records what it `answers`
 * (`docs/plans/2360-thread-replies.md`, rev 3; ADR-054's #2360 PR A
 * amendment).
 *
 * Flag on for the MCP worlds (each stubs `TANDEM_OWNERSHIP=1`); the dark rows
 * stub `""`, so they pin master's behaviour in the flag-on job too. The seam
 * rows take `parents` explicitly and need no flag.
 *
 * Every `answers` row here is read straight off the stored reply; PR B's
 * handled filter, which reads them, is pinned in
 * `ownership-thread-handled.test.ts`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { z } from "zod";
import {
  addUserReply,
  createAnnotationLifecycle,
  type ReplyParents,
} from "../../src/server/annotations/lifecycle.js";
import {
  AnnotationReplyRecordSchemaV1,
  SCHEMA_VERSION,
} from "../../src/server/annotations/schema.js";
import { loadAndMerge, resetForTesting as resetSync } from "../../src/server/annotations/sync.js";
import {
  carryThreadFieldsTrustOnRename,
  copyThreadFieldsTrust,
  threadFieldsTrusted,
  threadFieldsTrustedForDoc,
} from "../../src/server/annotations/thread-answers-trust.js";
import {
  boundThreadAnswers,
  commentEntryKey,
  visibleThreadEntries,
} from "../../src/server/annotations/thread-handled.js";
import { setChatClientWritesUndone } from "../../src/server/chat-client-writes.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  attachObservers,
  reattachObservers,
  resetForTesting as resetEventQueue,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import { prepareExportComments } from "../../src/server/file-io/docx-comment-export.js";
import {
  dispatch as localDispatch,
  replyToAnnotationDescription,
  TOOLS,
} from "../../src/server/local-model/tools.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import {
  handOverDocumentInbox,
  registerAwarenessTools,
  resetInbox,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { deliveryRegistry, documentItemKey } from "../../src/server/mcp/inbox-cursor.js";
import { checkInboxOutputShape } from "../../src/server/mcp/output-schemas.js";
import {
  decodeSessionToScratchDoc,
  deleteSession,
  loadCtrlSession,
  loadSession,
  restoreCtrlDoc,
  restoreYDoc,
  saveCtrlSession,
  saveSession,
} from "../../src/server/session/manager.js";
import {
  DEFAULT_GRACE_MS,
  getDocOwner,
  noteTransportChanged,
  noteTransportRegistered,
  resetOwnershipForTests,
  setDocOwner,
  setGraceMsForTests,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setTransportView,
  type TransportViewEntry,
  threadReplyWritesForTests,
  undoClientChatWrites,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  THREAD_ANSWER_KEY_MAX,
  THREAD_ANSWERS_MAX,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
} from "../../src/shared/constants.js";
import { INTERNAL_ORIGIN, withInternal } from "../../src/shared/origins.js";
import type { AnnotationReply } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { noRelay } from "../helpers/ydoc-factory.js";

const A = "claude:thread-a";
const B = "claude:thread-b";

const inboxSchema = z.object(checkInboxOutputShape);
type Inbox = z.infer<typeof inboxSchema>;

let run = 0;
let prefix = "";

/** A comment-shaped record under `id`, user-authored and Claude-facing unless overridden. */
function seed(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}): void {
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
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

function fixture(name: string, text = "Hello world, this is a test document."): Y.Doc {
  const id = `${prefix}-${name}`;
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return ydoc;
}

const replyRow = (ydoc: Y.Doc, replyId: string) =>
  ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).get(replyId) as AnnotationReply | undefined;

const repliesJson = (ydoc: Y.Doc) => JSON.stringify(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).toJSON());

// ---------------------------------------------------------------------------
// The seam: the privacy table, by `parents` (no flag: the seam reads none).

describe("the reply seam's parents discriminant (#2360; ADR-027 order unchanged)", () => {
  const reply = (ydoc: Y.Doc, id: string, parents: ReplyParents) =>
    createAnnotationLifecycle(ydoc).reply(
      id,
      "probe",
      { kind: "none" },
      parents,
      { kind: "untracked" },
      noRelay,
    );

  const ROWS: Array<{
    name: string;
    record: Record<string, unknown>;
    on: string;
    off: string;
  }> = [
    {
      name: "user note",
      record: { type: "note", audience: "private" },
      on: "invalid-note",
      off: "invalid-note",
    },
    {
      name: "legacy flag",
      record: { type: "flag", audience: undefined },
      on: "invalid-note",
      off: "invalid-note",
    },
    {
      name: "user private comment",
      record: { audience: "private" },
      on: "invalid-note",
      off: "invalid-note",
    },
    {
      name: "Claude private comment",
      record: { author: "claude", audience: "private" },
      on: "invalid-note",
      off: "invalid-note",
    },
    {
      name: "untriaged imported comment",
      record: { author: "import", audience: undefined, importSource: { author: "Colleague" } },
      on: "invalid-note",
      off: "invalid-note",
    },
    {
      name: "user highlight",
      record: { type: "highlight", audience: "private" },
      on: "not-owned",
      off: "not-owned",
    },
    {
      name: "imported outbound comment",
      record: { author: "import" },
      on: "not-owned",
      off: "not-owned",
    },
    {
      name: "dismissed user comment",
      record: { status: "dismissed" },
      on: "not-pending",
      off: "not-owned",
    },
    { name: "Claude-facing user comment", record: {}, on: "ok", off: "not-owned" },
    {
      name: "promoted note",
      record: { promotedFrom: "note", editedAt: 2000 },
      on: "ok",
      off: "not-owned",
    },
  ];

  it.each(ROWS)("$name: $on with claude-facing-comment, $off with own", ({ record, on, off }) => {
    setCtrlMode("tandem");
    const ydoc = new Y.Doc();
    seed(ydoc, "p", record);
    const before = repliesJson(ydoc);
    const own = reply(ydoc, "p", "own");
    expect(own.kind).toBe(off);
    if (off !== "ok") expect(repliesJson(ydoc), "a refusal writes nothing").toBe(before);
    const lit = reply(ydoc, "p", "claude-facing-comment");
    expect(lit.kind).toBe(on);
    if (on !== "ok") expect(repliesJson(ydoc), "a refusal writes nothing").toBe(before);
  });

  it("a user comment the Solo hold hides answers not-found, and writes nothing (Q5)", () => {
    const ydoc = new Y.Doc();
    seed(ydoc, "p");
    setCtrlMode("solo");
    try {
      expect(reply(ydoc, "p", "claude-facing-comment")).toStrictEqual({
        kind: "not-found",
        id: "p",
      });
      expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
      // Claude's own parent is not on the relaxed arm: Solo does not refuse it.
      seed(ydoc, "own", { author: "claude" });
      expect(reply(ydoc, "own", "claude-facing-comment").kind).toBe("ok");
    } finally {
      setCtrlMode("tandem");
    }
  });

  it("untracked writes neither field; in-progress writes only inProgress", () => {
    setCtrlMode("tandem");
    const ydoc = new Y.Doc();
    seed(ydoc, "p");
    const lifecycle = createAnnotationLifecycle(ydoc);
    const plain = lifecycle.reply(
      "p",
      "x",
      { kind: "none" },
      "claude-facing-comment",
      { kind: "untracked" },
      noRelay,
    );
    const ack = lifecycle.reply(
      "p",
      "y",
      { kind: "none" },
      "claude-facing-comment",
      { kind: "in-progress" },
      noRelay,
    );
    if (plain.kind !== "ok" || ack.kind !== "ok") throw new Error("expected ok");
    expect(Object.keys(replyRow(ydoc, plain.replyId) ?? {})).not.toContain("answers");
    expect(Object.keys(replyRow(ydoc, plain.replyId) ?? {})).not.toContain("inProgress");
    expect(replyRow(ydoc, ack.replyId)?.inProgress).toBe(true);
    expect(Object.keys(replyRow(ydoc, ack.replyId) ?? {})).not.toContain("answers");
  });
});

// ---------------------------------------------------------------------------
// The pure rule and the bounds.

describe("thread entry keys and the bounds (#2360)", () => {
  it("a non-finite editedAt keys as c:0; an edit makes a new key", () => {
    expect(commentEntryKey(Number.NaN)).toBe("c:0");
    expect(commentEntryKey(Number.POSITIVE_INFINITY)).toBe("c:0");
    expect(commentEntryKey(undefined)).toBe("c:0");
    expect(commentEntryKey(1234)).toBe("c:1234");
    const parent = { id: "p", author: "user", editedAt: 5 };
    expect(visibleThreadEntries(parent, [], "tandem").map((e) => e.key)).toEqual(["c:5"]);
    expect(
      visibleThreadEntries({ ...parent, editedAt: 6 }, [], "tandem").map((e) => e.key),
    ).toEqual(["c:6"]);
  });

  it("a held or Claude-authored reply is no entry; a hidden parent has none", () => {
    const parent = { id: "p", author: "claude" };
    const replies = [
      { id: "r1", author: "user" as const },
      { id: "r2", author: "user" as const, heldInSolo: true },
      { id: "r3", author: "claude" as const },
    ];
    expect(visibleThreadEntries(parent, replies, "tandem").map((e) => e.key)).toEqual(["r:r1"]);
    expect(visibleThreadEntries({ id: "u", author: "user" }, replies, "solo")).toEqual([]);
  });

  it("over both bounds the kept prefix is written, and the same row survives the durable schema", () => {
    setCtrlMode("tandem");
    const ydoc = new Y.Doc();
    seed(ydoc, "p");
    const long = `r:${"x".repeat(THREAD_ANSWER_KEY_MAX)}`;
    const keys = [long, ...Array.from({ length: THREAD_ANSWERS_MAX + 5 }, (_, i) => `r:k${i}`)];
    const result = createAnnotationLifecycle(ydoc).reply(
      "p",
      "answer",
      { kind: "none" },
      "claude-facing-comment",
      {
        kind: "final",
        visibleEntries: () => keys.map((key) => ({ key, kind: "r" as const, id: key, version: 0 })),
        handed: () => true,
      },
      noRelay,
    );
    if (result.kind !== "ok") throw new Error(result.kind);
    const row = replyRow(ydoc, result.replyId) as AnnotationReply;
    expect(row.answers).toEqual(boundThreadAnswers(keys));
    expect(row.answers).toHaveLength(THREAD_ANSWERS_MAX);
    expect(row.answers?.[0]).toBe("r:k0");
    expect(row.answers).not.toContain(long);
    // The durable schema (`normalizeReply`'s parse) keeps the row and its answers.
    const parsed = AnnotationReplyRecordSchemaV1.safeParse(row);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.answers).toEqual(row.answers);
    // A forged over-long list is dropped, never the reply.
    const forged = AnnotationReplyRecordSchemaV1.safeParse({ ...row, answers: [long] });
    expect(forged.success).toBe(true);
    expect(forged.data?.answers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The MCP world, flag on: answers, the second step, answered-once, Solo.

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs = A;

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 0 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

function lapseNow(ownerId: string): void {
  vi.useFakeTimers();
  try {
    setGraceMsForTests(10);
    const entry = view.find((e) => e.ownerId === ownerId) as TransportViewEntry;
    entry.streamEver = true;
    entry.openStreams = 0;
    noteTransportChanged(ownerId);
    vi.advanceTimersByTime(20);
  } finally {
    vi.useRealTimers();
    setGraceMsForTests(DEFAULT_GRACE_MS);
  }
}

type Body = {
  error: boolean;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
  details?: Record<string, unknown>;
};

async function as(owner: string, tool: string, args: Record<string, unknown> = {}): Promise<Body> {
  callingAs = owner;
  return parseResult(await client.callTool({ name: tool, arguments: args })) as Body;
}

async function pollAs(owner: string, cursor?: string): Promise<Inbox> {
  callingAs = owner;
  const result = await client.callTool({
    name: "tandem_checkInbox",
    arguments: cursor === undefined ? {} : { cursor },
  });
  expect(parseResult(result).error, JSON.stringify(result)).toBe(false);
  return inboxSchema.parse((result as { structuredContent: unknown }).structuredContent);
}

function reader(owner: string) {
  let cursor = "start";
  return {
    async poll(): Promise<Inbox> {
      const inbox = await pollAs(owner, cursor);
      cursor = inbox.cursor;
      return inbox;
    },
  };
}

async function buildWorld(flag: "1" | ""): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `thread${run}`;
  callingAs = A;
  resetInbox();
  resetEventQueue();
  resetOwnershipForTests();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  view = [];
  setTransportView(() => view);
  register(A);
  register(B);
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setChatClientWritesUndone(undoClientChatWrites);
  setCtrlMode("tandem");
  const front = fixture("front");
  setActiveDocId(`${prefix}-front`);
  void front;
  ({ client, close } = await setupMcpServer(
    [registerAwarenessTools, registerDocumentTools, registerAnnotationTools],
    { dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }) },
  ));
}

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  resetOwnershipForTests();
  resetInbox();
  resetEventQueue();
  resetSync();
  setChatClientWritesUndone(undefined);
  setCtrlMode("tandem");
  vi.unstubAllEnvs();
});

describe("answers, flag on (#2360 §3)", () => {
  beforeEach(() => buildWorld("1"));

  const docOf = (name: string) => `${prefix}-${name}`;
  const answer = async (owner: string, name: string, extra: Record<string, unknown> = {}) => {
    const out = await as(owner, "tandem_annotationReply", {
      annotationId: "c1",
      text: "the answer",
      documentId: docOf(name),
      ...extra,
    });
    expect(out.error, JSON.stringify(out)).toBe(false);
    return out.data?.replyId as string;
  };

  it("lists the user comment it was handed and that was acknowledged", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r = reader(A);
    expect((await r.poll()).userActions.map((a) => a.id)).toContain("c1");
    await r.poll(); // acknowledges
    expect(getDocOwner(docOf("d"))?.ownerId).toBe(A);
    const id = await answer(A, "d");
    expect(replyRow(ydoc, id)?.answers).toEqual(["c:0"]);
  });

  it("an edit makes a new key, and the earlier key is not listed again", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r = reader(A);
    await r.poll();
    await r.poll();
    expect(replyRow(ydoc, await answer(A, "d"))?.answers).toEqual(["c:0"]);
    seed(ydoc, "c1", { editedAt: 4242, rev: 2 });
    await r.poll();
    await r.poll();
    expect(replyRow(ydoc, await answer(A, "d"))?.answers).toEqual(["c:4242"]);
  });

  it("the second step appends what the next acknowledging poll confirms and was handed before the reply", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r = reader(A);
    await r.poll(); // handed, not yet acknowledged
    const first = await answer(A, "d");
    expect(replyRow(ydoc, first)?.answers).toEqual([]);
    // R2 arrives after the reply: handed by the next poll, so never listed.
    expect(addUserReply(ydoc, "c1", "and another thing", noRelay).kind).toBe("ok");
    const r2 = [...ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).values()].find(
      (v) => (v as AnnotationReply).text === "and another thing",
    ) as AnnotationReply;
    await r.poll(); // acknowledges c1; hands R2
    expect(replyRow(ydoc, first)?.answers).toEqual(["c:0"]);
    await r.poll(); // acknowledges R2, handed after the reply: not appended
    expect(replyRow(ydoc, first)?.answers).toEqual(["c:0"]);
    // The cursor has seen past the reply's seqAtAccept: it is forgotten, so
    // later polls stop re-walking it.
    expect(threadReplyWritesForTests(A)).toEqual([]);
    // A later answer lists R2, not c:0 again.
    expect(replyRow(ydoc, await answer(A, "d"))?.answers).toEqual([`r:${r2.id}`]);
  });

  it("an entry handed after the reply is not appended even when one acknowledgement confirms both", async () => {
    // Two cursors of one session: the second reader is handed the comment
    // and R2 together (R2 written after the reply), and its next poll
    // confirms both at once. Only the comment was handed before the reply.
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    await reader(A).poll(); // hands c1; never acknowledged
    const first = await answer(A, "d");
    expect(addUserReply(ydoc, "c1", "after the reply", noRelay).kind).toBe("ok");
    const second = reader(A);
    await second.poll(); // hands c1 and R2
    await second.poll(); // confirms both
    expect(replyRow(ydoc, first)?.answers).toEqual(["c:0"]);
  });

  it("a reply arriving after the last poll is not listed", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r = reader(A);
    await r.poll();
    await r.poll();
    expect(addUserReply(ydoc, "c1", "late", noRelay).kind).toBe("ok");
    expect(replyRow(ydoc, await answer(A, "d"))?.answers).toEqual(["c:0"]);
  });

  it("after a restart (the writer map lost) the second step appends nothing", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r = reader(A);
    await r.poll();
    const first = await answer(A, "d");
    expect(threadReplyWritesForTests(A)).toHaveLength(1);
    // A restart forgets the writer map (server memory only). The rest of the
    // world is put back by hand so the next poll can acknowledge.
    resetOwnershipForTests();
    view = [];
    setTransportView(() => view);
    register(A);
    register(B);
    setOwnershipSeqSource(() => deliveryRegistry.counter);
    setOwnershipInboxHandover(handOverDocumentInbox);
    setDocOwner(docOf("d"), { ownerId: A, kind: "claimed" }, "claim", A);
    await r.poll();
    expect(replyRow(ydoc, first)?.answers).toEqual([]);
  });

  it("condition (b) counts only entries registered after the caller's hold began (PR A's known gap, closed by PR B)", async () => {
    // A claim of an unowned document is not a handover, so an entry handed
    // and acknowledged while it was unowned (here put in the registry by
    // hand) stays live. B claims by writing (its first reply lists nothing:
    // condition (c)); its next reply lists nothing either, because the entry
    // sits at or below B's hold mark (`holdSinceSeq`): B was never handed it.
    // Before PR B this listed `c:0` (the "KNOWN GAP" pin).
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const entry = deliveryRegistry.assign("a", docOf("d"), documentItemKey(docOf("d"), "c1"), 0);
    deliveryRegistry.markAcked(entry);
    expect(replyRow(ydoc, await answer(B, "d"))?.answers).toEqual([]);
    expect(getDocOwner(docOf("d"))?.ownerId).toBe(B);
    expect(entry.seq).toBeLessThanOrEqual(getDocOwner(docOf("d"))?.holdSinceSeq as number);
    expect(replyRow(ydoc, await answer(B, "d"))?.answers).toEqual([]);
  });

  it("the second step also lists only entries registered after the hold began", async () => {
    // The same world, then two cursor polls by B: a cursor's mark reads the
    // other reader's acknowledged entry as seen, but B was never handed it,
    // so the second step appends nothing to B's reply.
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const entry = deliveryRegistry.assign("a", docOf("d"), documentItemKey(docOf("d"), "c1"), 0);
    deliveryRegistry.markAcked(entry);
    const first = await answer(B, "d");
    expect(getDocOwner(docOf("d"))?.ownerId).toBe(B);
    expect(threadReplyWritesForTests(B)).toHaveLength(1);
    const r = reader(B);
    await r.poll();
    await r.poll();
    expect(replyRow(ydoc, first)?.answers).toEqual([]);
  });

  it("the hold mark survives a same-holder rewrite of the entry (a change of kind): both steps still list", async () => {
    // A holds D, is handed and acknowledges the comment, then its own entry
    // is rewritten with another kind (as `tandem_open` or a Release to
    // default do): `sinceSeq` moves, the hold mark does not.
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r = reader(A);
    await r.poll();
    await r.poll();
    const before = getDocOwner(docOf("d"));
    expect(before?.ownerId).toBe(A);
    deliveryRegistry.assign("a", docOf("d"), documentItemKey(docOf("d"), "unrelated"), 0);
    setDocOwner(docOf("d"), { ownerId: A, kind: "opened" }, "take", A);
    const after = getDocOwner(docOf("d"));
    expect(after?.sinceSeq).toBeGreaterThan(before?.sinceSeq as number);
    expect(after?.holdSinceSeq).toBe(before?.holdSinceSeq);
    expect(replyRow(ydoc, await answer(A, "d"))?.answers).toEqual(["c:0"]);
  });

  it("the second step after a same-holder rewrite still appends what the hold was handed", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r = reader(A);
    await r.poll(); // handed, not yet acknowledged
    deliveryRegistry.assign("a", docOf("d"), documentItemKey(docOf("d"), "unrelated"), 0);
    setDocOwner(docOf("d"), { ownerId: A, kind: "opened" }, "take", A);
    const id = await answer(A, "d");
    expect(replyRow(ydoc, id)?.answers).toEqual([]);
    await r.poll(); // acknowledges: the second step appends
    expect(replyRow(ydoc, id)?.answers).toEqual(["c:0"]);
  });

  it("condition (c): a caller that does not hold the document lists nothing, even a live acknowledged entry", async () => {
    // A live, acknowledged entry on an UNOWNED document (put in the registry
    // by hand: a handover would have retired it). B's write claims the
    // document only at its outcome, so while the seam computes `answers` B
    // holds nothing, and lists nothing.
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const entry = deliveryRegistry.assign("a", docOf("d"), documentItemKey(docOf("d"), "c1"), 0);
    deliveryRegistry.markAcked(entry);
    expect(getDocOwner(docOf("d"))).toBeUndefined();
    const id = await answer(B, "d");
    expect(replyRow(ydoc, id)?.answers).toEqual([]);
    expect(getDocOwner(docOf("d"))?.ownerId).toBe(B);
  });

  it("a session that claims after a lapse lists nothing", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r = reader(A);
    await r.poll();
    await r.poll();
    lapseNow(A);
    expect(getDocOwner(docOf("d"))?.ownerId).not.toBe(A);
    const id = await answer(B, "d");
    expect(replyRow(ydoc, id)?.answers).toEqual([]);
  });

  it("a Solo-held reply, an unhanded Solo-edge reply and a private reply are not listed", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1", { author: "claude" });
    const r = reader(A);
    // A Solo-held reply: stamped heldInSolo, invisible until release.
    setCtrlMode("solo");
    expect(addUserReply(ydoc, "c1", "held", noRelay).kind).toBe("ok");
    setCtrlMode("tandem");
    // A private reply (forged into the map server-side).
    withInternal(ydoc, () =>
      ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("rp", {
        id: "rp",
        annotationId: "c1",
        author: "user",
        text: "private",
        timestamp: 3000,
        rev: 1,
        private: true,
      }),
    );
    await r.poll();
    await r.poll();
    // A reply with no stamp that was never handed (written after the polls).
    expect(addUserReply(ydoc, "c1", "edge", noRelay).kind).toBe("ok");
    const id = await answer(A, "d");
    expect(replyRow(ydoc, id)?.answers).toEqual([]);
  });

  it("answered-once on a user comment with no replies; inProgress sets no answerer", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    setDocOwner(docOf("d"), { ownerId: A, kind: "opened" }, "take");
    const ack = await answer(A, "d", { inProgress: true });
    expect(replyRow(ydoc, ack)?.inProgress).toBe(true);
    expect(replyRow(ydoc, ack)?.answers).toBeUndefined();
    expect(threadReplyWritesForTests(A)).toEqual([]);
    // The acknowledgement answered nothing: another record may still answer.
    setDocOwner(docOf("d"), { ownerId: B, kind: "opened" }, "take");
    await answer(B, "d");
    // B's final reply answered the comment item: A is now refused.
    setDocOwner(docOf("d"), { ownerId: A, kind: "opened" }, "take");
    const refused = await as(A, "tandem_annotationReply", {
      annotationId: "c1",
      text: "me too",
      documentId: docOf("d"),
    });
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.details?.reason).toBe("answered");
  });

  it("inProgress with suggestedText is refused by its arguments and writes nothing", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const out = await as(A, "tandem_annotationReply", {
      annotationId: "c1",
      text: "x",
      inProgress: true,
      suggestedText: "y",
      documentId: docOf("d"),
    });
    expect(out.code).toBe("INVALID_ARGUMENT");
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
    expect(getDocOwner(docOf("d"))).toBeUndefined();
  });

  it("the NOT_OWNED remedy no longer names tandem_reply; the description and schema are the lit ones", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "h1", { type: "highlight", audience: "outbound" });
    const out = await as(A, "tandem_annotationReply", {
      annotationId: "h1",
      text: "x",
      documentId: docOf("d"),
    });
    expect(out.code).toBe("NOT_OWNED");
    expect(out.message).not.toContain("tandem_reply");
    const tool = (await client.listTools()).tools.find((t) => t.name === "tandem_annotationReply");
    expect(tool?.description).not.toContain("tandem_reply");
    // PR C review: a user's highlight is NOT_OWNED (above); a highlight Claude
    // authored passes the author arm and is refused not-repliable.
    expect(tool?.description).toContain(
      "An imported record or a user's highlight returns NOT_OWNED",
    );
    expect(tool?.description).toContain(
      "Private notes, private comments and a highlight Claude authored return INVALID_ARGUMENT",
    );
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("inProgress");
  });

  it("answers and inProgress never reach tandem_getAnnotations or tandem_exportAnnotations", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    setDocOwner(docOf("d"), { ownerId: A, kind: "opened" }, "take");
    await answer(A, "d");
    await answer(A, "d", { inProgress: true });
    const got = await as(A, "tandem_getAnnotations", { documentId: docOf("d") });
    const exported = await as(A, "tandem_exportAnnotations", {
      documentId: docOf("d"),
      format: "json",
    });
    for (const out of [got, exported]) {
      const text = JSON.stringify(out.data);
      expect(text).toContain("the answer");
      expect(text).not.toContain("answers");
      expect(text).not.toContain("inProgress");
    }
  });
});

describe("dark (#2360): master's behaviour, byte for byte", () => {
  beforeEach(() => buildWorld(""));

  it("a user comment keeps NOT_OWNED naming tandem_reply; no inProgress input; nothing written", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const out = await as(A, "tandem_annotationReply", {
      annotationId: "c1",
      text: "x",
      documentId: `${prefix}-d`,
    });
    expect(out.code).toBe("NOT_OWNED");
    expect(out.message).toContain("tandem_reply");
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
    const tool = (await client.listTools()).tools.find((t) => t.name === "tandem_annotationReply");
    expect(tool?.description).toContain("answer it in chat with tandem_reply");
    // Byte for byte (PR C review edited only the lit text).
    expect(tool?.description).toBe(
      "Reply in the thread of a pending annotation Claude authored (ANNOTATION_RESOLVED once it is " +
        "accepted or dismissed). A user-authored or imported record — including a promoted note or " +
        "imported comment, which is stored as a user comment — returns NOT_OWNED; answer it in chat with " +
        "tandem_reply, or leave a fresh tandem_comment. Private notes and private comments return " +
        "INVALID_ARGUMENT.",
    );
    expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain("inProgress");
  });

  it("a reply on Claude's own comment carries neither field", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1", { author: "claude" });
    const out = await as(A, "tandem_annotationReply", {
      annotationId: "c1",
      text: "x",
      documentId: `${prefix}-d`,
    });
    expect(out.error).toBe(false);
    const row = replyRow(ydoc, out.data?.replyId as string) as AnnotationReply;
    expect(Object.keys(row)).not.toContain("answers");
    expect(Object.keys(row)).not.toContain("inProgress");
  });
});

// ---------------------------------------------------------------------------
// The local model (Bryan's Q2, "Yes, settles nothing").

describe("the local model's reply_to_annotation (#2360, Q2)", () => {
  const ctx = (ydoc: Y.Doc) => ({
    ydoc,
    canEdit: () => true,
    agentIdentity: { provider: "local-ollama" as const, displayName: "Local" },
  });

  it("unwired, the gate answers own even flag on (fails closed)", () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    setChatClientWritesUndone(undefined);
    setCtrlMode("tandem");
    const ydoc = new Y.Doc();
    seed(ydoc, "c1");
    const out = localDispatch(
      "reply_to_annotation",
      { annotation_id: "c1", text: "hi" },
      ctx(ydoc),
    );
    expect((out.result as { error?: string }).error).toBe("NOT_OWNED");
    vi.unstubAllEnvs();
  });

  it.each(["1", ""])("flag %j: user comment, user note", (flag) => {
    if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
    else vi.stubEnv("TANDEM_OWNERSHIP", "");
    // As `index.ts` wires it: the local model reads the flag through this seam.
    setChatClientWritesUndone(undoClientChatWrites);
    setCtrlMode("tandem");
    const ydoc = new Y.Doc();
    seed(ydoc, "c1");
    seed(ydoc, "n1", { type: "note", audience: "private" });
    const onComment = localDispatch(
      "reply_to_annotation",
      { annotation_id: "c1", text: "hi" },
      ctx(ydoc),
    );
    const onNote = localDispatch(
      "reply_to_annotation",
      { annotation_id: "n1", text: "hi" },
      ctx(ydoc),
    );
    expect((onNote.result as { error?: string }).error).toBe("INVALID_ARGUMENT");
    if (flag === "1") {
      expect((onComment.result as { ok?: boolean }).ok).toBe(true);
      const id = (onComment.result as { reply_id: string }).reply_id;
      const row = replyRow(ydoc, id) as AnnotationReply;
      // Settles nothing: no answers, never a final Claude reply.
      expect(Object.keys(row)).not.toContain("answers");
      expect(row.agentIdentity?.displayName).toBe("Local");
    } else {
      expect((onComment.result as { error?: string }).error).toBe("NOT_OWNED");
    }
    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------------------
// The undo of client writes and the pending guard.

describe("a client connection's change to the replies map (#2360 §3)", () => {
  const CONNECTION = { socketId: "tab-1" };
  let events: TandemEvent[] = [];
  const sink = (e: TandemEvent) => {
    events.push(e);
  };

  beforeEach(() => {
    resetEventQueue();
    events = [];
    subscribe(sink, "internal");
    setChatClientWritesUndone(() => true);
    setCtrlMode("tandem");
  });
  afterEach(() => {
    unsubscribe(sink);
  });

  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    annotationId: "c1",
    author: "claude",
    text: "forged",
    timestamp: 5000,
    rev: 9,
    answers: ["c:0"],
    ...extra,
  });

  function roomWith(name: string, opts?: { uploadDoc?: boolean }): Y.Doc {
    const ydoc = new Y.Doc();
    seed(ydoc, "c1");
    withInternal(ydoc, () =>
      ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("legit", row("legit", { answers: [] })),
    );
    attachObservers(name, ydoc, opts);
    return ydoc;
  }

  const asClient = (ydoc: Y.Doc, fn: () => void) => ydoc.transact(fn, CONNECTION);

  it("an add is deleted and pushes no event; a change and a delete are put back", () => {
    const ydoc = roomWith("undo-1");
    const replies = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const before = replies.get("legit");
    const warn = vi.spyOn(console, "warn");
    asClient(ydoc, () => replies.set("forged", row("forged", { author: "user" })));
    expect(replies.has("forged")).toBe(false);
    expect(events.filter((e) => e.type === "annotation:reply")).toEqual([]);
    // Derivation skipped the repaired transaction outright: it did not even
    // try to project the (now deleted) row.
    expect(warn.mock.calls.flat().join("\n")).not.toContain("refused to project reply");
    warn.mockRestore();
    asClient(ydoc, () => replies.set("legit", { ...(before as object), answers: ["c:9"] }));
    expect(replies.get("legit")).toEqual(before);
    asClient(ydoc, () => replies.delete("legit"));
    expect(replies.get("legit")).toEqual(before);
  });

  it("on an upload document, and after a swap", () => {
    const upload = roomWith("undo-upload", { uploadDoc: true });
    asClient(upload, () => upload.getMap(Y_MAP_ANNOTATION_REPLIES).set("f", row("f")));
    expect(upload.getMap(Y_MAP_ANNOTATION_REPLIES).has("f")).toBe(false);

    roomWith("undo-swap");
    const swapped = new Y.Doc();
    seed(swapped, "c1");
    reattachObservers("undo-swap", swapped);
    asClient(swapped, () => swapped.getMap(Y_MAP_ANNOTATION_REPLIES).set("f", row("f")));
    expect(swapped.getMap(Y_MAP_ANNOTATION_REPLIES).has("f")).toBe(false);
  });

  it("a non-object earlier value is not restored", () => {
    const ydoc = roomWith("undo-raw");
    const replies = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    withInternal(ydoc, () => replies.set("raw", "not an object"));
    asClient(ydoc, () => replies.set("raw", row("raw")));
    expect(replies.has("raw")).toBe(false);
    withInternal(ydoc, () => replies.set("raw2", "not an object"));
    asClient(ydoc, () => replies.delete("raw2"));
    expect(replies.has("raw2")).toBe(false);
  });

  it("a restore with no origin is not undone", () => {
    const ydoc = roomWith("undo-restore");
    const other = new Y.Doc();
    other.getMap(Y_MAP_ANNOTATION_REPLIES).set("restored", row("restored", { answers: [] }));
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(other));
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).has("restored")).toBe(true);
  });

  it("dark, nothing is undone", () => {
    setChatClientWritesUndone(() => false);
    const ydoc = roomWith("undo-dark");
    asClient(ydoc, () => ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("forged", row("forged")));
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).has("forged")).toBe(true);
  });

  it.each([true, false])(
    "pending structs from a client are dropped only when undone (%s)",
    (undone) => {
      setChatClientWritesUndone(() => undone);
      const ydoc = roomWith(`pending-${undone}`);
      const tab = new Y.Doc();
      Y.applyUpdate(tab, Y.encodeStateAsUpdate(ydoc));
      const vector = Y.encodeStateVector(tab);
      tab.getMap("scratch").set("k1", 1);
      const mid = Y.encodeStateVector(tab);
      tab.getMap("scratch").set("k2", 2);
      void vector;
      // Only the second update reaches the server: it depends on the first.
      const second = Y.encodeStateAsUpdate(tab, mid);
      Y.applyUpdate(ydoc, second, CONNECTION);
      const pending = (ydoc.store as { pendingStructs: unknown }).pendingStructs;
      if (undone) expect(pending).toBeNull();
      else expect(pending).not.toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// Rows already on disk: the envelope path, the session path, the CTRL path.

describe("rows already on disk (#2360 §3)", () => {
  const forged = {
    id: "fr",
    annotationId: "c1",
    author: "claude",
    text: "forged",
    timestamp: 5000,
    rev: 3,
    answers: ["c:0"],
    inProgress: false,
  };
  const user = {
    id: "ur",
    annotationId: "c1",
    author: "user",
    text: "hi",
    timestamp: 4000,
    rev: 2,
  };

  function envelope(meta: Record<string, unknown>, replies: unknown[]) {
    return {
      schemaVersion: SCHEMA_VERSION,
      docHash: "h",
      meta: { filePath: "/tmp/x.md", lastUpdated: 1, keyIdentity: 1, ...meta },
      annotations: [],
      tombstones: [],
      replies,
    };
  }

  async function load(file: ReturnType<typeof envelope>, ydoc = new Y.Doc()) {
    const writes: unknown[] = [];
    const store = {
      load: async () => structuredClone(file) as never,
      queueWrite: (fn: () => unknown) => writes.push(fn()),
      flush: async () => {},
      cancelPendingWrite: () => {},
      clear: async () => {},
      isReadOnly: () => false,
      isDisabled: () => false,
    };
    // The strip's own origin: the merge's writes are `file-sync`, master's.
    let transactions = 0;
    ydoc.on("afterTransaction", (txn: Y.Transaction) => {
      if (txn.origin === INTERNAL_ORIGIN) transactions++;
    });
    const hash = `h${run++}`;
    const cleanup = await loadAndMerge({
      ydoc,
      store,
      docHash: hash,
      meta: { filePath: "/tmp/x.md" },
    });
    cleanup("close");
    const rows = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).toJSON() as Record<
      string,
      Record<string, unknown>
    >;
    return {
      rows,
      writes: writes as Array<{ meta: Record<string, unknown> }>,
      transactions,
      hash,
    };
  }

  it("flag on, unmarked: stripped, and the rewrite carries the marker", async () => {
    setChatClientWritesUndone(() => true);
    const { rows, writes } = await load(envelope({}, [forged, user]));
    expect(Object.keys(rows.fr)).not.toContain("answers");
    expect(Object.keys(rows.fr)).not.toContain("inProgress");
    expect(rows.ur).toMatchObject({ text: "hi" });
    expect(writes.at(-1)?.meta.threadAnswersTrusted).toBe(true);
  });

  it("flag on, marked: kept", async () => {
    setChatClientWritesUndone(() => true);
    const ydoc = new Y.Doc();
    const { rows } = await load(envelope({ threadAnswersTrusted: true }, [forged]), ydoc);
    expect(rows.fr.answers).toEqual(["c:0"]);
    // A content reload of the same open document re-attaches its observers
    // with no file-sync context bound: the load's trust still holds.
    attachObservers(`trusted-${run}`, ydoc);
    expect((ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).get("fr") as AnnotationReply).answers).toEqual([
      "c:0",
    ]);
    // A Y.Doc no load trusted, with no context, is swept at attach.
    const stray = new Y.Doc();
    withInternal(stray, () => stray.getMap(Y_MAP_ANNOTATION_REPLIES).set("fr", forged));
    attachObservers(`stray-${run}`, stray);
    expect(Object.keys(stray.getMap(Y_MAP_ANNOTATION_REPLIES).get("fr") as object)).not.toContain(
      "answers",
    );
  });

  it("trust survives a Hocuspocus swap and a later content reload (PR A review, item 1)", async () => {
    setChatClientWritesUndone(() => true);
    const oldDoc = new Y.Doc();
    const { hash } = await load(envelope({ threadAnswersTrusted: true }, [forged]), oldDoc);
    // `onDocSwapped`: a fresh Y.Doc with the same rows replaces the old one.
    const swapped = new Y.Doc();
    Y.applyUpdate(swapped, Y.encodeStateAsUpdate(oldDoc));
    copyThreadFieldsTrust(oldDoc, swapped);
    reattachObservers(`swap-${run}`, swapped);
    // `clearAndReload`: the file-sync context is cleared, then the observers
    // re-attach (no context bound), which runs the sweep.
    attachObservers(`swap-${run}`, swapped, { uploadDoc: false });
    expect((swapped.getMap(Y_MAP_ANNOTATION_REPLIES).get("fr") as AnnotationReply).answers).toEqual(
      ["c:0"],
    );
    // Belt and braces: a Y.Doc found trusted through its context's hash is
    // remembered, so the same reload finds it with no context at all.
    const viaHash = new Y.Doc();
    expect(threadFieldsTrustedForDoc(viaHash, hash)).toBe(true);
    expect(threadFieldsTrustedForDoc(viaHash, undefined)).toBe(true);
    // An untrusted old doc passes nothing on.
    const untrusted = new Y.Doc();
    const next = new Y.Doc();
    copyThreadFieldsTrust(untrusted, next);
    expect(threadFieldsTrustedForDoc(next, undefined)).toBe(false);
  });

  it("onDocSwapped carries the trust, and restoreCtrlDoc strips first (pinned from source)", () => {
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
    const lifecycle = read("src/server/bootstrap/hocuspocus-lifecycle.ts");
    const swap = lifecycle.slice(lifecycle.indexOf("onDocSwapped("));
    expect(swap.indexOf("copyThreadFieldsTrust(oldDoc, newDoc);")).toBeGreaterThan(-1);
    expect(swap.indexOf("copyThreadFieldsTrust(oldDoc, newDoc);")).toBeLessThan(
      swap.indexOf("reattachObservers("),
    );
    const manager = read("src/server/session/manager.ts");
    const restore = manager.slice(manager.indexOf("export function restoreCtrlDoc("));
    // The strip is the first statement after the apply (item 2).
    expect(restore).toMatch(
      /Y\.applyUpdate\(doc, new Uint8Array\(state\)\);\n(?:\s*\/\/[^\n]*\n)*\s*stripUntrustedChatSettles\(doc\);/,
    );
  });

  it("the session path: a session file a dark build wrote is stripped at a lit restore; one a lit build wrote is kept (item 3)", async () => {
    const filePath = path.join(os.tmpdir(), `tandem-thread-session-${run++}.md`);
    const save = async (lit: boolean) => {
      setChatClientWritesUndone(() => lit);
      const doc = new Y.Doc();
      doc.getMap(Y_MAP_ANNOTATION_REPLIES).set("fr", forged);
      await saveSession(filePath, "md", doc);
    };
    const restore = async () => {
      setChatClientWritesUndone(() => true);
      const session = await loadSession(filePath);
      const doc = new Y.Doc();
      restoreYDoc(doc, session as NonNullable<typeof session>);
      return doc.getMap(Y_MAP_ANNOTATION_REPLIES).get("fr") as Record<string, unknown>;
    };
    try {
      await save(false);
      expect(Object.keys(await restore())).not.toContain("answers");
      await save(true);
      expect((await restore()).answers).toEqual(["c:0"]);
      // Dark, nothing is trusted: the restore strips even a marked file.
      setChatClientWritesUndone(() => false);
      const session = await loadSession(filePath);
      const doc = new Y.Doc();
      restoreYDoc(doc, session as NonNullable<typeof session>);
      expect(Object.keys(doc.getMap(Y_MAP_ANNOTATION_REPLIES).get("fr") as object)).not.toContain(
        "answers",
      );
    } finally {
      await deleteSession(filePath);
    }
  });

  it("a rename carries trust only from a marked, trusted old envelope (#2574 review)", async () => {
    setChatClientWritesUndone(() => true);
    const { hash: oldHash } = await load(envelope({ threadAnswersTrusted: true }, [forged]));
    expect(threadFieldsTrusted(oldHash)).toBe(true);
    // Marked and trusted: the new hash is trusted, so the RMW snapshot
    // carries the marker and the re-wire's load keeps the rows.
    expect(carryThreadFieldsTrustOnRename(oldHash, `new-${run}`, true)).toBe(true);
    expect(threadFieldsTrusted(`new-${run}`)).toBe(true);
    // An unmarked old envelope (fold 0 could bring its rows in) moves nothing,
    // and a stale trust on the new hash is dropped.
    expect(carryThreadFieldsTrustOnRename(oldHash, `new-${run}`, false)).toBe(false);
    expect(threadFieldsTrusted(`new-${run}`)).toBe(false);
    // An old hash this process never trusted moves nothing.
    expect(carryThreadFieldsTrustOnRename(`never-${run}`, `new2-${run}`, true)).toBe(false);
    expect(threadFieldsTrusted(`new2-${run}`)).toBe(false);
    // Dark, nothing is trusted.
    setChatClientWritesUndone(() => false);
    expect(carryThreadFieldsTrustOnRename(oldHash, `new3-${run}`, true)).toBe(false);
  });

  it("the rename carries trust before its RMW snapshot (pinned from source)", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/server/mcp/document-service.ts"),
      "utf8",
    );
    const carry = src.indexOf("carryThreadFieldsTrustOnRename(oldHash, newHash, oldFileMarked);");
    expect(carry).toBeGreaterThan(src.indexOf("mergeEnvelopeForward(doc, oldFile, newHash);"));
    expect(carry).toBeLessThan(src.indexOf("// RMW step 1: write the NEW envelope"));
    expect(src).toContain("oldFileMarked = oldFile.meta.threadAnswersTrusted === true;");
  });

  it("the corrupt-winner fallback strips an unmarked session's fields before the clone (#2574 review)", async () => {
    const filePath = path.join(os.tmpdir(), `tandem-thread-fallback-${run++}.md`);
    const save = async (lit: boolean) => {
      setChatClientWritesUndone(() => lit);
      const doc = new Y.Doc();
      doc.getMap(Y_MAP_ANNOTATION_REPLIES).set("fr", forged);
      await saveSession(filePath, "md", doc);
    };
    const decode = async (lit: boolean) => {
      setChatClientWritesUndone(() => lit);
      const session = await loadSession(filePath);
      const scratch = decodeSessionToScratchDoc(session as NonNullable<typeof session>);
      try {
        return scratch.getMap(Y_MAP_ANNOTATION_REPLIES).get("fr") as Record<string, unknown>;
      } finally {
        scratch.destroy();
      }
    };
    try {
      await save(false);
      expect(Object.keys(await decode(true))).not.toContain("answers");
      await save(true);
      expect((await decode(true)).answers).toEqual(["c:0"]);
      expect(Object.keys(await decode(false))).not.toContain("answers");
    } finally {
      await deleteSession(filePath);
    }
  });

  it("flag off, a marked envelope with no rows is rewritten without the marker", async () => {
    setChatClientWritesUndone(() => false);
    const { writes } = await load(envelope({ threadAnswersTrusted: true }, []));
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0]?.meta ?? {})).not.toContain("threadAnswersTrusted");
  });

  it("flag off, marked: stripped, and rewritten without the marker", async () => {
    setChatClientWritesUndone(() => false);
    const { rows, writes } = await load(envelope({ threadAnswersTrusted: true }, [forged]));
    expect(Object.keys(rows.fr)).not.toContain("answers");
    expect(writes.length).toBeGreaterThan(0);
    expect(Object.keys(writes.at(-1)?.meta ?? {})).not.toContain("threadAnswersTrusted");
  });

  it("flag off, a store with no such fields loads exactly as before: no strip, no marker", async () => {
    setChatClientWritesUndone(() => false);
    for (const preloaded of [false, true]) {
      const ydoc = new Y.Doc();
      if (preloaded) {
        withInternal(ydoc, () => ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("ur", user));
      }
      const { rows, writes, transactions } = await load(envelope({}, [user]), ydoc);
      expect(rows.ur).toEqual(user);
      expect(transactions, "the strip opened no transaction").toBe(0);
      for (const w of writes) expect(Object.keys(w.meta)).not.toContain("threadAnswersTrusted");
    }
  });

  it("the session path: a forged row already in the Y.Doc is stripped flag on, fast path and full merge", async () => {
    setChatClientWritesUndone(() => true);
    for (const file of [envelope({}, []), envelope({}, [user])]) {
      const ydoc = new Y.Doc();
      Y.applyUpdate(
        ydoc,
        (() => {
          const s = new Y.Doc();
          s.getMap(Y_MAP_ANNOTATION_REPLIES).set("fr", forged);
          return Y.encodeStateAsUpdate(s);
        })(),
      );
      const { rows } = await load(file, ydoc);
      expect(Object.keys(rows.fr)).not.toContain("answers");
    }
  });

  it("CTRL: a Claude row's settles saved dark is stripped at a lit restore; saved lit, it is kept", async () => {
    const write = async (undone: boolean) => {
      setChatClientWritesUndone(() => undone);
      const ctrl = new Y.Doc();
      ctrl.getMap(Y_MAP_CHAT).set("m1", {
        id: "m1",
        author: "claude",
        text: "hi",
        timestamp: 1,
        replyTo: "u1",
        settles: ["u0"],
        superseded: true,
      });
      await saveCtrlSession(ctrl);
    };
    const read = async () => {
      setChatClientWritesUndone(() => true);
      const state = await loadCtrlSession();
      const ctrl = new Y.Doc();
      restoreCtrlDoc(ctrl, state as string);
      return ctrl.getMap(Y_MAP_CHAT).get("m1") as Record<string, unknown>;
    };
    await write(false);
    const dark = await read();
    expect(Object.keys(dark)).not.toContain("settles");
    expect(Object.keys(dark)).not.toContain("superseded");
    expect(dark.replyTo).toBe("u1");
    await write(true);
    const lit = await read();
    expect(lit.settles).toEqual(["u0"]);
    // A lit build's mark counts only for a lit restore.
    await write(true);
    setChatClientWritesUndone(() => false);
    const state = await loadCtrlSession();
    const ctrl = new Y.Doc();
    restoreCtrlDoc(ctrl, state as string);
    expect(Object.keys(ctrl.getMap(Y_MAP_CHAT).get("m1") as object)).not.toContain("settles");
  });
});

// ---------------------------------------------------------------------------
// The reply event and the .docx export.

describe("the reply event and the .docx export (#2360)", () => {
  it("a reply row's answers and inProgress never reach the annotation:reply payload", () => {
    resetEventQueue();
    const events: TandemEvent[] = [];
    const sink = (e: TandemEvent) => {
      events.push(e);
    };
    subscribe(sink, "internal");
    try {
      setChatClientWritesUndone(() => false);
      setCtrlMode("tandem");
      const ydoc = new Y.Doc();
      seed(ydoc, "c1", { author: "claude" });
      attachObservers("event-doc", ydoc);
      const other = new Y.Doc();
      other.getMap(Y_MAP_ANNOTATION_REPLIES).set("r1", {
        id: "r1",
        annotationId: "c1",
        author: "user",
        text: "hi",
        timestamp: 1,
        rev: 1,
        answers: ["c:0"],
        inProgress: true,
      });
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(other));
      const reply = events.find((e) => e.type === "annotation:reply");
      expect(reply).toBeDefined();
      expect(JSON.stringify(reply?.payload)).not.toMatch(/answers|inProgress/);
    } finally {
      unsubscribe(sink);
    }
  });

  it("an inProgress reply is not exported", () => {
    setCtrlMode("tandem");
    const ydoc = new Y.Doc();
    populateYDoc(ydoc, "Hello world, this is a test document.");
    seed(ydoc, "c1", { author: "claude", range: { from: 0, to: 5 }, textSnapshot: "Hello" });
    const lifecycle = createAnnotationLifecycle(ydoc);
    lifecycle.reply("c1", "on it", { kind: "none" }, "own", { kind: "in-progress" }, noRelay);
    lifecycle.reply("c1", "the answer", { kind: "none" }, "own", { kind: "untracked" }, noRelay);
    const exported = JSON.stringify(prepareExportComments(ydoc));
    expect(exported).toContain("the answer");
    expect(exported).not.toContain("on it");
  });
});

// ---------------------------------------------------------------------------
// #2360 PR C, the switch: the model-facing and shipped text.

describe("the local model's reply_to_annotation description (#2360 PR C)", () => {
  /** The text before #2360, byte for byte: what every dark build must send. */
  const DARK =
    "Reply to a pending comment thread you or another AI authored, by its annotation id. Comments written by the user cannot be replied to (NOT_OWNED, or INVALID_ARGUMENT for a private one); leave a new comment_on_quote instead.";

  /** What the model is sent: the tool's entry, serialized as a request body serializes it. */
  const sent = () =>
    JSON.parse(JSON.stringify(TOOLS.find((t) => t.name === "reply_to_annotation"))) as {
      description: string;
    };

  it.each([
    ["flag off, wired", "", true],
    ["flag off, unwired", "", false],
    ["flag on, unwired (fails closed)", "1", false],
  ])("%s: byte-identical to the text before #2360", (_name, flag, wired) => {
    vi.stubEnv("TANDEM_OWNERSHIP", flag);
    setChatClientWritesUndone(wired ? undoClientChatWrites : undefined);
    expect(replyToAnnotationDescription()).toBe(DARK);
    expect(sent().description).toBe(DARK);
  });

  it("flag on, wired: it no longer says the user's comments are refused", () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    setChatClientWritesUndone(undoClientChatWrites);
    const text = sent().description;
    expect(text).toBe(replyToAnnotationDescription());
    expect(text).not.toBe(DARK);
    expect(text).not.toMatch(/written by the user cannot/);
    expect(text).toMatch(/one the user wrote and shared with you/);
    // The refusals that stay are still named, each with the records it
    // covers: an AI-authored highlight passes the author arm and is refused
    // not-repliable (INVALID_ARGUMENT); only the user's highlight is NOT_OWNED.
    expect(text).toContain(
      "A private note or comment, or a highlight an AI authored, returns INVALID_ARGUMENT",
    );
    expect(text).toContain("an imported record or the user's highlight NOT_OWNED");
  });
});

describe("the switch's shipped text (#2360 PR C)", () => {
  it("row S is gone from the flip blockers", async () => {
    const { OWNERSHIP_FLIP_BLOCKERS } = await import("./ownership-flip-blockers.js");
    expect(
      OWNERSHIP_FLIP_BLOCKERS.some((r) => r.gap.startsWith("#2360's switch has not merged")),
    ).toBe(false);
  });

  it("docs/mcp-tools.md describes the tool as live, inProgress included", () => {
    const doc = fs.readFileSync(path.join(process.cwd(), "docs/mcp-tools.md"), "utf8");
    const start = doc.indexOf("### tandem_annotationReply");
    expect(start).toBeGreaterThan(-1);
    const section = doc.slice(start, doc.indexOf("\n### ", start + 1));
    expect(section).not.toMatch(/Ships dark \(#2360/);
    expect(section).toMatch(/\| `inProgress` \| boolean \| no \|/);
    expect(section).toMatch(/one the user shared with Claude/);
  });
});
