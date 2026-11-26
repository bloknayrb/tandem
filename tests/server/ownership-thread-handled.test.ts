/**
 * #2360 PR B (ships dark behind `OWNERSHIP_ENABLED`): the handled filter
 * (`docs/plans/2360-thread-replies.md` §5, PR B; ADR-054's #2360 PR B
 * amendment). A user comment at the version a final Claude reply's
 * `answers` lists, and a user reply one lists, are not handed out by a poll,
 * not owed again by a handover and not counted as waiting. What re-opens an
 * entry: a user edit (a new `c:` key) and a new user reply (its own key). An
 * in-progress acknowledgement settles nothing. These rows close flip-blocker
 * row H; row W's are in `launcher/ownership-forward.test.ts`.
 *
 * Also here: Bryan's Q6 (a user's follow-up in a thread Claude answered is
 * start-worthy, through the reply event's `threadAnswered`), and the dark
 * rows (flag off, a forged `answers` row hides nothing and no event carries
 * the field).
 *
 * The MCP world is `ownership-thread-replies.test.ts`'s (copied, pared).
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { z } from "zod";
import { addUserReply } from "../../src/server/annotations/lifecycle.js";
import { SCHEMA_VERSION } from "../../src/server/annotations/schema.js";
import { loadAndMerge, resetForTesting as resetSync } from "../../src/server/annotations/sync.js";
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
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import {
  documentWaiting,
  handOverDocumentInbox,
  registerAwarenessTools,
  resetInbox,
  setWaitingWrittenSinceForTests,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { deliveryRegistry, documentItemKey } from "../../src/server/mcp/inbox-cursor.js";
import { checkInboxOutputShape } from "../../src/server/mcp/output-schemas.js";
import { handleModeRelease } from "../../src/server/mcp/routes/mode-release.js";
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
  undoClientChatWrites,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { isStartWorthy } from "../../src/shared/events/wake-scope.js";
import { withInternal } from "../../src/shared/origins.js";
import type { AnnotationReply } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { makeRes } from "../helpers/route-recorder.js";
import { noRelay } from "../helpers/ydoc-factory.js";

const A = "claude:handled-a";
const B = "claude:handled-b";

const inboxSchema = z.object(checkInboxOutputShape);
type Inbox = z.infer<typeof inboxSchema>;

let run = 0;
let prefix = "";
let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs = A;

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

const docOf = (name: string) => `${prefix}-${name}`;

function fixture(name: string): Y.Doc {
  const id = docOf(name);
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, "Hello world, this is a test document.");
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return ydoc;
}

const replyRow = (ydoc: Y.Doc, replyId: string) =>
  ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).get(replyId) as AnnotationReply | undefined;

/** A user reply on `annotationId`, returning its id. */
function userReply(ydoc: Y.Doc, annotationId: string, text: string): string {
  const result = addUserReply(ydoc, annotationId, text, noRelay);
  if (result.kind !== "ok") throw new Error(result.kind);
  const row = [...ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).values()].find(
    (v) => (v as AnnotationReply).text === text,
  ) as AnnotationReply;
  return row.id;
}

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

type Body = { error: boolean; code?: string; data?: Record<string, unknown> };

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

/** The comment and reply ids an inbox hands. */
const handed = (inbox: Inbox): string[] => [
  ...inbox.userActions.map((a) => String(a.id)),
  ...inbox.userReplies.map((r) => String(r.id)),
];

async function answer(owner: string, name: string, extra: Record<string, unknown> = {}) {
  const out = await as(owner, "tandem_annotationReply", {
    annotationId: "c1",
    text: "the answer",
    documentId: docOf(name),
    ...extra,
  });
  expect(out.error, JSON.stringify(out)).toBe(false);
  return out.data?.replyId as string;
}

async function buildWorld(flag: "1" | ""): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `handled${run}`;
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
  // The lines of `src/server/index.ts`.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setChatClientWritesUndone(undoClientChatWrites);
  setWaitingWrittenSinceForTests(undefined);
  setCtrlMode("tandem");
  fixture("front");
  setActiveDocId(docOf("front"));
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
  setWaitingWrittenSinceForTests(Date.now());
  setCtrlMode("tandem");
  vi.unstubAllEnvs();
});

/** A polls D twice (handed, then acknowledged): D is A's. */
async function handToA(): Promise<ReturnType<typeof reader>> {
  const r = reader(A);
  await r.poll();
  await r.poll();
  expect(getDocOwner(docOf("d"))?.ownerId).toBe(A);
  return r;
}

describe("the handled filter, flag on (#2360 PR B; row H)", () => {
  beforeEach(() => buildWorld("1"));

  it("after A answered every entry it was handed, a handover re-owes nothing on that thread, to a fresh cursor or a legacy poll", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r1 = userReply(ydoc, "c1", "first reply");
    await handToA();
    const id = await answer(A, "d");
    expect(replyRow(ydoc, id)?.answers).toEqual(["c:0", `r:${r1}`]);
    expect(documentWaiting(docOf("d"))).toBe(false);
    lapseNow(A);
    expect(getDocOwner(docOf("d"))?.ownerId).not.toBe(A);
    // Handled: neither entry is waiting, and no reader is handed either.
    expect(documentWaiting(docOf("d"))).toBe(false);
    expect(handed(await reader(B).poll())).toEqual([]);
    expect(handed(await pollAs(B))).toEqual([]);
  });

  it("the same thread unanswered is re-owed by the same handover (the anchor)", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r1 = userReply(ydoc, "c1", "first reply");
    await handToA();
    lapseNow(A);
    expect(documentWaiting(docOf("d"))).toBe(true);
    expect(handed(await reader(B).poll()).sort()).toEqual(["c1", r1].sort());
  });

  it("a handled entry's registry entry is retired at the handover, so a lost mark re-owes the item (review fix)", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r1 = userReply(ydoc, "c1", "first reply");
    // A cursor-less hand-out: its commit stamps the legacy ledgers and tees
    // the registry.
    expect(handed(await pollAs(A)).sort()).toEqual(["c1", r1].sort());
    expect(getDocOwner(docOf("d"))?.ownerId).toBe(A);
    const id = await answer(A, "d");
    expect(replyRow(ydoc, id)?.answers).toEqual(["c:0", `r:${r1}`]);
    lapseNow(A);
    expect([...deliveryRegistry.versionsOf("a", documentItemKey(docOf("d"), "c1"))]).toEqual([]);
    expect([...deliveryRegistry.versionsOf("r", documentItemKey(docOf("d"), r1))]).toEqual([]);
    // Handled: nothing handed, to either kind of reader.
    expect(handed(await pollAs(B))).toEqual([]);
    expect(handed(await reader(B).poll())).toEqual([]);
    // The mark lost (as a load sweep strips an untrusted `answers`): the
    // comment and the reply are owed again, not read as delivered for good.
    const row = replyRow(ydoc, id) as AnnotationReply;
    const { answers: _answers, ...stripped } = row;
    withInternal(ydoc, () => ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set(id, stripped));
    expect(documentWaiting(docOf("d"))).toBe(true);
    expect(handed(await reader(B).poll()).sort()).toEqual(["c1", r1].sort());
  });

  it("the Solo regression: a reply written in Solo is handed after the release, and owed again after a handover", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1", { author: "claude" });
    // Claude's own pending comment is no inbox item, so A takes D.
    setDocOwner(docOf("d"), { ownerId: A, kind: "opened" }, "take", A);
    setCtrlMode("solo");
    const held = userReply(ydoc, "c1", "written in Solo");
    // Claude answers its own thread while the reply is held: not listed.
    const id = await answer(A, "d");
    expect(replyRow(ydoc, id)?.answers).toEqual([]);
    setCtrlMode("tandem");
    const res = makeRes();
    handleModeRelease(
      {
        body: {},
        socket: { remoteAddress: "127.0.0.1" },
        headers: { origin: "http://127.0.0.1:5173" },
      } as never,
      res as never,
    );
    expect(res._status ?? 200).toBe(200);
    const r = reader(A);
    expect(handed(await r.poll())).toEqual([held]);
    lapseNow(A);
    expect(handed(await reader(B).poll())).toEqual([held]);
  });

  it("the window regression: a reply arriving while Claude answers the comment is handed out", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r = await handToA();
    const r2 = userReply(ydoc, "c1", "while you were answering");
    const id = await answer(A, "d");
    expect(replyRow(ydoc, id)?.answers).toEqual(["c:0"]);
    expect(handed(await r.poll())).toEqual([r2]);
    lapseNow(A);
    expect(handed(await reader(B).poll())).toEqual([r2]);
  });

  it("a user edit re-opens the comment: handed again, marked edited, and waiting", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r = await handToA();
    await answer(A, "d");
    seed(ydoc, "c1", { editedAt: 4242, rev: 2 });
    expect(documentWaiting(docOf("d"))).toBe(true);
    const inbox = await r.poll();
    expect(handed(inbox)).toEqual(["c1"]);
    expect(inbox.userActions[0]?.edited).toBe(true);
  });

  it("an in-progress acknowledgement settles nothing", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    await handToA();
    await answer(A, "d", { inProgress: true });
    lapseNow(A);
    expect(documentWaiting(docOf("d"))).toBe(true);
    expect(handed(await reader(B).poll())).toEqual(["c1"]);
  });

  it("an owed entry for a handled item is retired, not held, and the item is not handed (review fix)", async () => {
    const ydoc = fixture("d");
    // A second cursor of A, positioned before the comment exists.
    const late = reader(A);
    await late.poll();
    seed(ydoc, "c1");
    const r1 = userReply(ydoc, "c1", "a reply");
    await handToA();
    await answer(A, "d");
    // The late cursor's mark is below both entries: owed to it, filtered,
    // retired (a lost mark would then re-owe the item to every reader).
    expect(handed(await late.poll())).toEqual([]);
    expect([...deliveryRegistry.versionsOf("a", documentItemKey(docOf("d"), "c1"))]).toEqual([]);
    expect([...deliveryRegistry.versionsOf("r", documentItemKey(docOf("d"), r1))]).toEqual([]);
    expect(handed(await late.poll())).toEqual([]);
    expect(documentWaiting(docOf("d"))).toBe(false);
  });

  it("with the registry emptied (a restart), a handled thread neither waits nor is handed; the agreement holds", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const r1 = userReply(ydoc, "c1", "first reply");
    await handToA();
    const id = await answer(A, "d");
    expect(replyRow(ydoc, id)?.answers).toEqual(["c:0", `r:${r1}`]);
    resetInbox();
    expect(deliveryRegistry.versionsOf("a", documentItemKey(docOf("d"), "c1"))).toEqual([]);
    expect(getDocOwner(docOf("d"))?.ownerId).toBe(A);
    // A fresh reader of the holder: what the waiting rule restates.
    expect(documentWaiting(docOf("d"))).toBe(false);
    expect(handed(await reader(A).poll())).toEqual([]);
    // An edit re-opens the comment alone; the reply stays handled.
    seed(ydoc, "c1", { editedAt: 77, rev: 2 });
    expect(documentWaiting(docOf("d"))).toBe(true);
    expect(handed(await reader(A).poll())).toEqual(["c1"]);
  });

  it("a handled reply alone, with the registry emptied: not waiting, not handed", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1", { author: "claude" });
    setDocOwner(docOf("d"), { ownerId: A, kind: "opened" }, "take", A);
    const r1 = userReply(ydoc, "c1", "a reply");
    const r = reader(A);
    await r.poll();
    await r.poll();
    expect(replyRow(ydoc, await answer(A, "d"))?.answers).toEqual([`r:${r1}`]);
    resetInbox();
    expect(documentWaiting(docOf("d"))).toBe(false);
    expect(handed(await reader(A).poll())).toEqual([]);
  });

  it("a user comment whose key collides with a Claude notice's never hides the notice", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "k#accepted");
    await handToA();
    const out = await as(A, "tandem_annotationReply", {
      annotationId: "k#accepted",
      text: "the answer",
      documentId: docOf("d"),
    });
    expect(out.error, JSON.stringify(out)).toBe(false);
    expect(replyRow(ydoc, out.data?.replyId as string)?.answers).toEqual(["c:0"]);
    // The registry forgotten (its entry for the comment would itself read as
    // the notice's), so only the handled filter could hide it. Claude's own
    // annotation `k`, accepted by the user: its notice key is the user
    // comment's bare key.
    resetInbox();
    seed(ydoc, "k", { author: "claude", status: "accepted" });
    const inbox = await reader(A).poll();
    expect(inbox.userResponses.map((x) => String(x.id))).toEqual(["k"]);
  });

  it("a final reply written before #2360 (no answers) handles nothing", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    withInternal(ydoc, () =>
      ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("old", {
        id: "old",
        annotationId: "c1",
        author: "claude",
        text: "an old answer",
        timestamp: 2000,
        rev: 1,
      }),
    );
    expect(handed(await reader(B).poll())).toEqual(["c1"]);
  });

  it("a client's forged Claude row is undone and hides nothing, on a document room, an upload room and after a swap", async () => {
    const forged = (id: string) => ({
      id,
      annotationId: "c1",
      author: "claude",
      text: "forged",
      timestamp: 5000,
      rev: 9,
      answers: ["c:0"],
    });
    const CONNECTION = { socketId: "tab-1" };
    const cases: Array<[string, (id: string, ydoc: Y.Doc) => void]> = [
      ["room", (id, ydoc) => attachObservers(id, ydoc)],
      ["upload", (id, ydoc) => attachObservers(id, ydoc, { uploadDoc: true })],
      [
        "swap",
        (id, ydoc) => {
          attachObservers(id, new Y.Doc());
          reattachObservers(id, ydoc);
        },
      ],
    ];
    for (const [name, attach] of cases) {
      const ydoc = fixture(name);
      seed(ydoc, "c1");
      attach(docOf(name), ydoc);
      ydoc.transact(() => ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("f", forged("f")), CONNECTION);
      expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).has("f"), name).toBe(false);
      expect(documentWaiting(docOf(name)), name).toBe(true);
    }
    const inbox = await reader(B).poll();
    expect(handed(inbox).filter((id) => id === "c1")).toHaveLength(3);
  });

  it("a forged row saved on disk by a dark build is stripped at a flag-on load and hides nothing", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1");
    const file = {
      schemaVersion: SCHEMA_VERSION,
      docHash: "h",
      meta: { filePath: "/tmp/x.md", lastUpdated: 1, keyIdentity: 1 },
      annotations: [],
      tombstones: [],
      replies: [
        {
          id: "fr",
          annotationId: "c1",
          author: "claude",
          text: "forged",
          timestamp: 5000,
          rev: 3,
          answers: ["c:0"],
        },
      ],
    };
    const store = {
      load: async () => structuredClone(file) as never,
      queueWrite: () => {},
      flush: async () => {},
      cancelPendingWrite: () => {},
      clear: async () => {},
      isReadOnly: () => false,
      isDisabled: () => false,
    };
    const cleanup = await loadAndMerge({
      ydoc,
      store,
      docHash: `h${run}`,
      meta: { filePath: "/tmp/x.md" },
    });
    cleanup("close");
    expect(Object.keys(replyRow(ydoc, "fr") ?? {})).not.toContain("answers");
    expect(documentWaiting(docOf("d"))).toBe(true);
    expect(handed(await reader(B).poll())).toEqual(["c1"]);
  });
});

describe("dark (#2360 PR B): the filter reads nothing", () => {
  beforeEach(() => buildWorld(""));

  it("flag off, a forged answers row hides nothing from a cursor or a legacy poll", async () => {
    const ydoc = fixture("d");
    seed(ydoc, "c1", { author: "claude" });
    const r1 = userReply(ydoc, "c1", "a reply");
    seed(ydoc, "u1");
    withInternal(ydoc, () =>
      ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("forged", {
        id: "forged",
        annotationId: "c1",
        author: "claude",
        text: "forged",
        timestamp: 5000,
        rev: 1,
        answers: [`r:${r1}`],
      }),
    );
    withInternal(ydoc, () =>
      ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("forged2", {
        id: "forged2",
        annotationId: "u1",
        author: "claude",
        text: "forged",
        timestamp: 5000,
        rev: 1,
        answers: ["c:0"],
      }),
    );
    expect(handed(await reader(A).poll()).sort()).toEqual([r1, "u1"].sort());
    expect(handed(await pollAs(B)).sort()).toEqual([r1, "u1"].sort());
  });

  it("flag off, the waiting rule reads no answers row either (unreachable dark, guarded anyway)", () => {
    const ydoc = fixture("d");
    seed(ydoc, "u1");
    withInternal(ydoc, () =>
      ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("forged", {
        id: "forged",
        annotationId: "u1",
        author: "claude",
        text: "forged",
        timestamp: 5000,
        rev: 1,
        answers: ["c:0"],
      }),
    );
    expect(documentWaiting(docOf("d"))).toBe(true);
  });
});

describe("a follow-up in a thread Claude answered starts Claude (#2360 PR B; Bryan's Q6)", () => {
  let events: TandemEvent[] = [];
  const sink = (e: TandemEvent) => {
    events.push(e);
  };
  beforeEach(() => {
    resetEventQueue();
    events = [];
    subscribe(sink, "internal");
    setCtrlMode("tandem");
  });
  afterEach(() => {
    unsubscribe(sink);
    setChatClientWritesUndone(undefined);
  });

  function threadWith(name: string, claudeRow: Record<string, unknown> | null): Y.Doc {
    const ydoc = new Y.Doc();
    seed(ydoc, "c1");
    // Attached first: the attach-time load sweep strips `answers` from rows
    // already there (PR A), and a server write after it is kept.
    attachObservers(name, ydoc);
    if (claudeRow) {
      withInternal(ydoc, () =>
        ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("cr", {
          id: "cr",
          annotationId: "c1",
          author: "claude",
          text: "Claude's answer",
          timestamp: 2000,
          rev: 1,
          ...claudeRow,
        }),
      );
    }
    return ydoc;
  }

  const followUp = (ydoc: Y.Doc) => {
    events = [];
    userReply(ydoc, "c1", `follow-up ${run++}`);
    const event = events.find((e) => e.type === "annotation:reply");
    expect(event).toBeDefined();
    return event as TandemEvent;
  };

  it("flag on: a user reply after a final Claude reply carries threadAnswered and is start-worthy", () => {
    setChatClientWritesUndone(() => true);
    const event = followUp(threadWith("q6-final", { answers: ["c:0"] }));
    expect(event.payload).toMatchObject({ replyAuthor: "user", threadAnswered: true });
    expect(isStartWorthy(event)).toBe(true);
  });

  it("flag on: an in-progress, a pre-#2360 or no Claude reply leaves it not start-worthy", () => {
    setChatClientWritesUndone(() => true);
    for (const [name, row] of [
      ["q6-progress", { inProgress: true }],
      ["q6-legacy", {}],
      ["q6-none", null],
    ] as const) {
      const event = followUp(threadWith(name, row));
      expect(Object.keys(event.payload), name).not.toContain("threadAnswered");
      expect(isStartWorthy(event), name).toBe(false);
    }
  });

  it("the local model's reply does not count", () => {
    setChatClientWritesUndone(() => true);
    const event = followUp(
      threadWith("q6-local", {
        answers: ["c:0"],
        agentIdentity: { kind: "local-model", model: "m" },
      }),
    );
    expect(Object.keys(event.payload)).not.toContain("threadAnswered");
  });

  it("dark (flag off, or unwired): the payload is master's and the follow-up is not start-worthy", () => {
    for (const grant of [() => false, undefined]) {
      setChatClientWritesUndone(grant);
      const event = followUp(threadWith(`q6-dark-${String(grant)}`, { answers: ["c:0"] }));
      expect(Object.keys(event.payload).sort()).toEqual(
        [
          "annotationId",
          "parentAuthor",
          "replyAuthor",
          "replyId",
          "replyText",
          "textSnippet",
        ].sort(),
      );
      expect(isStartWorthy(event)).toBe(false);
    }
  });
});

describe("the flip-blocker rows PR B closes (#2360)", () => {
  it("rows H and W and the chat replyTo row are gone; the PR A document-room row stays", async () => {
    const { OWNERSHIP_FLIP_BLOCKERS } = await import("./ownership-flip-blockers.js");
    const rows = OWNERSHIP_FLIP_BLOCKERS.map((r) => r.gap);
    for (const closed of [
      "The handled filter for comment threads",
      "Answered work starts Tandem's Claude",
      "A Claude chat row forged by a browser client",
    ]) {
      expect(
        rows.some((g) => g.startsWith(closed)),
        closed,
      ).toBe(false);
    }
    expect(rows.some((g) => g.startsWith("#2360 PR A drops update data"))).toBe(true);
  });
});
