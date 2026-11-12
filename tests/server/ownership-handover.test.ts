/**
 * The document handover (#2358, ADR-054; ownership design §6.3's rule).
 *
 * When a document's ownership leaves a record, the user comments and user
 * thread replies any poll was handed on it stop counting as seen, for every
 * reader. The handover hands nothing itself: every hand-out still goes
 * through the inbox's collectors and their gates. Accept and dismiss notices
 * are left exactly as on master, and the document's `handoverSeq` becomes the
 * delivery registry's counter.
 *
 * Everything here goes through the real `tandem_checkInbox` tool, with
 * **registered owner records** (never the unregistered default test caller),
 * each reader keeping its own cursor, and with the two seams wired exactly as
 * `src/server/index.ts` wires them: an unwired sequence source answers 0 and
 * an unwired handover re-owes nothing, and either would make these vacuous.
 *
 * Flag on for the whole file, except the dark tests at the end, which seed
 * their state flag-on and then turn it off.
 *
 * Platform: documents are in-memory fixtures with synthetic paths, except the
 * `tandem_open` take, which needs a real file and builds it under
 * `os.tmpdir()` with `path.join`, as `ownership-enforcement.test.ts` does.
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
  resetDeliveryStateForTests,
} from "../../src/server/events/delivery-state.js";
import {
  resetForTesting as resetEventQueue,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import { unwatchFile } from "../../src/server/file-watcher.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import {
  handOverDocumentInbox,
  registerAwarenessTools,
  resetInbox,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { YDocStore } from "../../src/server/mcp/document-store.js";
import { decodeCursor, deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import { checkInboxOutputShape } from "../../src/server/mcp/output-schemas.js";
import { handleClose } from "../../src/server/mcp/routes/close.js";
import { DOC_OP_WAIT_MS, runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  applyUserOpenDefault,
  DEFAULT_GRACE_MS,
  getDocOwner,
  noteTransportChanged,
  noteTransportRegistered,
  onDocumentClosed,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setGraceMsForTests,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setTandemPresenceSource,
  setTransportView,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
  takeDocument,
} from "../../src/server/sessions/ownership.js";
import { getDocument, getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
} from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { makeRes } from "../helpers/route-recorder.js";

const A = "claude:handover-a";
const B = "claude:handover-b";
/** A third record: a bystander, never the holder. */
const C = "claude:handover-c";

const inboxSchema = z.object(checkInboxOutputShape);
type Inbox = z.infer<typeof inboxSchema>;

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs = A;
let run = 0;
let prefix = "";
let tmpDir = "";

const docId = (name: string) => `${prefix}-${name}`;

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 0 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

const entryOf = (ownerId: string) => view.find((e) => e.ownerId === ownerId) as TransportViewEntry;

/** Detach `ownerId` (its stream closed) while its transport stays registered: a grace starts. */
function detach(ownerId: string): void {
  const entry = entryOf(ownerId);
  entry.streamEver = true;
  entry.openStreams = 0;
  noteTransportChanged(ownerId);
}

/** Let `ownerId`'s grace run out: each document it holds goes to the default rule. */
function lapseNow(ownerId: string): void {
  vi.useFakeTimers();
  try {
    setGraceMsForTests(10);
    detach(ownerId);
    vi.advanceTimersByTime(20);
  } finally {
    vi.useRealTimers();
    // Back to the real grace: under inbox scope the lapsed record's next
    // poll may claim the document again, which arms a grace that must not
    // end mid-test.
    setGraceMsForTests(DEFAULT_GRACE_MS);
  }
}

interface Doc {
  id: string;
  ydoc: Y.Doc;
  filePath?: string;
}

function openFixture(id: string, text = "Hello world, this is a test document."): Doc {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return { id, ydoc };
}

const mkDoc = (name: string): Doc => openFixture(docId(name));

function annotation(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}): void {
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

/** Rewrite fields of a stored annotation, as a raw map write. */
function patch(ydoc: Y.Doc, id: string, fields: Record<string, unknown>): void {
  withInternal(ydoc, () => {
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const next: Record<string, unknown> = { ...(map.get(id) as Record<string, unknown>) };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    map.set(id, next);
  });
}

function reply(
  ydoc: Y.Doc,
  annotationId: string,
  id: string,
  extra: Record<string, unknown> = {},
): void {
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set(id, {
      id,
      annotationId,
      author: "user",
      text: `text of ${id}`,
      timestamp: 2000,
      ...extra,
    }),
  );
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

async function as(owner: string, tool: string, args: Record<string, unknown> = {}) {
  callingAs = owner;
  return parseResult(await client.callTool({ name: tool, arguments: args })) as {
    error: boolean;
    code?: string;
    data?: Record<string, unknown>;
  };
}

/** A cursor reader: each poll passes back the cursor its last poll returned. */
function reader(owner: string) {
  let cursor = "start";
  return {
    async poll(): Promise<Inbox> {
      const inbox = await pollAs(owner, cursor);
      cursor = inbox.cursor;
      return inbox;
    },
    get cursor() {
      return cursor;
    },
  };
}

/**
 * A cursor-less (legacy) poll, as A. Under inbox scope (the scope PR) a poll
 * reads only what its record holds or may claim, so the cursor-less reader of
 * these cases is the record that held the document (and, once ownership has
 * left it to unowned, may claim it again).
 */
const legacyPoll = () => pollAs(A);

const actionIds = (inbox: Inbox) => inbox.userActions.map((a) => a.id).sort();
const replyIds = (inbox: Inbox) => inbox.userReplies.map((r) => r.id).sort();
const responseIds = (inbox: Inbox) => inbox.userResponses.map((r) => r.id).sort();

const markOf = (id: string) => new Map(ownershipSnapshotForTests().handoverSeq).get(id);

const claim = (id: string, owner = A) =>
  setDocOwner(id, { ownerId: owner, kind: "claimed" }, "claim", owner);

/** What one document holds, so a fixture "reopen" can put it back. */
function snapshotRecords(ydoc: Y.Doc) {
  return {
    annotations: ydoc.getMap(Y_MAP_ANNOTATIONS).toJSON() as Record<string, unknown>,
    replies: ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).toJSON() as Record<string, unknown>,
  };
}

/**
 * Open a closed fixture again. A real reopen gets its annotations back from
 * the durable envelope; a fixture has none, so if the close dropped the
 * Y.Doc the records are written back as they were (same ids, same
 * `editedAt`). Whether a reopen gets the same Y.Doc instance is not relied on.
 */
function reopen(doc: Doc, records: ReturnType<typeof snapshotRecords>): Doc {
  const had = getDocument(doc.id);
  const ydoc = getOrCreateDocument(doc.id);
  if (!had) {
    populateYDoc(ydoc, "Hello world, this is a test document.");
    withInternal(ydoc, () => {
      for (const [k, v] of Object.entries(records.annotations)) {
        ydoc.getMap(Y_MAP_ANNOTATIONS).set(k, v);
      }
      for (const [k, v] of Object.entries(records.replies)) {
        ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set(k, v);
      }
    });
  }
  addDoc(doc.id, {
    id: doc.id,
    filePath: `/tmp/${doc.id}.md`,
    format: "md",
    readOnly: false,
    source: "file",
  });
  return { id: doc.id, ydoc };
}

async function closeByRoute(id: string): Promise<void> {
  const res = makeRes();
  await handleClose(
    { body: { documentId: id }, socket: { remoteAddress: "127.0.0.1" }, headers: {} } as never,
    res as never,
  );
  expect(res._status, JSON.stringify(res._body)).toBe(200);
}

/** Everything a test world needs, wired as `src/server/index.ts` wires it. */
async function buildWorld(): Promise<void> {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  run++;
  prefix = `handover${run}`;
  callingAs = A;
  resetInbox();
  resetEventQueue();
  resetDeliveryStateForTests();
  resetOwnershipForTests();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  view = [];
  setTransportView(() => view);
  register(A);
  register(B);
  register(C);
  // The two lines of `src/server/index.ts`.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setCtrlMode("tandem");
  // An active document that is none of a test's own, so those are background.
  const front = mkDoc("front");
  setActiveDocId(front.id);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-handover-"));
  await buildWorld();
  ({ client, close } = await setupMcpServer(
    [registerAwarenessTools, registerDocumentTools, registerAnnotationTools],
    { dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }) },
  ));
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [id, doc] of [...getOpenDocs()]) {
    // A real `tandem_open` started a watch; its file is about to be deleted.
    unwatchFile(doc.filePath);
    removeDoc(id);
  }
  resetOwnershipForTests();
  resetInbox();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// R1.1 + R1.2: every path, both item kinds, a fresh reader and one past the item.

interface HandoverPath {
  name: string;
  /** Open the document. Default: an in-memory fixture. */
  open?: () => Promise<Doc>;
  /** Give the document its first owner, before any item is handed. Default: A, as `claimed`. */
  own?: (doc: Doc) => Promise<void> | void;
  /** Ownership leaves that record. Returns the document as it is afterwards (a close reopens it). */
  leave: (doc: Doc) => Promise<Doc>;
  /** The record holding the document before it leaves. Default: A. */
  holder?: string;
  /**
   * The record that reads the document after the handover: its new holder,
   * or (where it becomes unowned) a record that may claim it. Default: B.
   */
  next?: string;
}

const PATHS: HandoverPath[] = [
  {
    name: "tandem_open's take, from a record that claimed by writing",
    open: async () => {
      const filePath = path.join(tmpDir, "taken.md");
      fs.writeFileSync(filePath, "Hello world, this is a test document.\n");
      const opened = await as(A, "tandem_open", { filePath });
      expect(opened.error).toBe(false);
      const id = opened.data?.documentId as string;
      return { id, ydoc: getOrCreateDocument(id), filePath };
    },
    own: async (doc) => {
      // `tandem_open` holds as `opened`, which nobody can take. Make A's hold
      // a claim, by a real write on the unowned document.
      setDocOwner(doc.id, null, "lapse");
      const wrote = await as(A, "tandem_comment", {
        from: 0,
        to: 5,
        text: "a claim",
        documentId: doc.id,
      });
      expect(wrote.error).toBe(false);
      expect(getDocOwner(doc.id)).toMatchObject({ ownerId: A, kind: "claimed" });
    },
    leave: async (doc) => {
      expect((await as(B, "tandem_open", { filePath: doc.filePath })).error).toBe(false);
      expect(getDocOwner(doc.id)).toMatchObject({ ownerId: B, kind: "opened" });
      return doc;
    },
  },
  {
    name: "a lapse to unowned",
    leave: async (doc) => {
      lapseNow(A);
      expect(getDocOwner(doc.id)).toBeUndefined();
      return doc;
    },
  },
  {
    name: "a lapse to Tandem's Claude (the default rule while it is present)",
    next: TANDEM_OWNER_ID,
    leave: async (doc) => {
      setTandemPresenceSource(() => true);
      lapseNow(A);
      expect(getDocOwner(doc.id)).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
      return doc;
    },
  },
  {
    name: "a lapse that ran out of turn, behind an operation that never settled",
    leave: async (doc) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stuck = runDocOp(doc.id, async () => {
        await gate;
      });
      vi.useFakeTimers();
      try {
        view = view.filter((e) => e.ownerId !== A);
        setGraceMsForTests(10);
        noteTransportChanged(A);
        await vi.advanceTimersByTimeAsync(10);
        // Deferred behind the running operation.
        expect(getDocOwner(doc.id)).toMatchObject({ ownerId: A });
        await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS);
        expect(getDocOwner(doc.id)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
      release();
      await stuck;
      return doc;
    },
  },
  {
    name: "any other setDocOwner change from one record to another",
    leave: async (doc) => {
      setDocOwner(doc.id, { ownerId: B, kind: "assigned" }, "take");
      expect(getDocOwner(doc.id)).toMatchObject({ ownerId: B });
      return doc;
    },
  },
  {
    name: "the take of a freshly created document another record got an entry on",
    leave: async (doc) => {
      // What `takeFreshDocument` runs at its turn in the document's queue.
      expect(takeDocument(doc.id, B)).toEqual({ ok: true, took: true });
      return doc;
    },
  },
  {
    name: "a tab close through POST /api/close, then a reopen",
    leave: async (doc) => {
      const records = snapshotRecords(doc.ydoc);
      await closeByRoute(doc.id);
      expect(getOpenDocs().has(doc.id)).toBe(false);
      expect(getDocOwner(doc.id)).toBeUndefined();
      return reopen(doc, records);
    },
  },
  {
    name: "a tab close through tandem_close, then a reopen",
    leave: async (doc) => {
      const records = snapshotRecords(doc.ydoc);
      const closed = await as(A, "tandem_close", { documentId: doc.id });
      expect(closed.error).toBe(false);
      expect(getOpenDocs().has(doc.id)).toBe(false);
      expect(getDocOwner(doc.id)).toBeUndefined();
      return reopen(doc, records);
    },
  },
];

/**
 * The tab-close paths again, with the kinds of holder a real session has: one
 * that got the document through a real `tandem_open` (`opened`), and Tandem's
 * Claude holding it by the default rule. The handover at the tab-close point
 * must not depend on the entry's kind.
 */
for (const via of ["POST /api/close", "tandem_close"] as const) {
  const closeIt = async (doc: Doc, holder: string): Promise<Doc> => {
    const records = snapshotRecords(doc.ydoc);
    if (via === "POST /api/close") await closeByRoute(doc.id);
    else expect((await as(holder, "tandem_close", { documentId: doc.id })).error).toBe(false);
    expect(getOpenDocs().has(doc.id)).toBe(false);
    expect(getDocOwner(doc.id)).toBeUndefined();
    return reopen(doc, records);
  };
  PATHS.push(
    {
      name: `a tab close through ${via} while its holder has it as opened (a real tandem_open), then a reopen`,
      open: async () => {
        const filePath = path.join(tmpDir, "opened.md");
        fs.writeFileSync(filePath, "Hello world, this is a test document.\n");
        const opened = await as(A, "tandem_open", { filePath });
        expect(opened.error).toBe(false);
        const id = opened.data?.documentId as string;
        return { id, ydoc: getOrCreateDocument(id), filePath };
      },
      own: (doc) => {
        expect(getDocOwner(doc.id)).toMatchObject({ ownerId: A, kind: "opened" });
      },
      leave: (doc) => closeIt(doc, A),
    },
    {
      name: `a tab close through ${via} while Tandem's Claude holds it by default, then a reopen`,
      holder: TANDEM_OWNER_ID,
      own: (doc) => {
        setTandemPresenceSource(() => true);
        applyUserOpenDefault(doc.id);
        expect(getDocOwner(doc.id)).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
      },
      leave: (doc) => closeIt(doc, TANDEM_OWNER_ID),
    },
  );
}

type ItemKind = "comment" | "reply";

/** Seed one item of `kind` and return how to tell whether a poll handed it. */
function seedItem(doc: Doc, kind: ItemKind): (inbox: Inbox) => boolean {
  if (kind === "comment") {
    annotation(doc.ydoc, "c1");
    return (inbox) => actionIds(inbox).includes("c1");
  }
  // A user reply on a Claude-facing thread; its pending Claude parent is not an item.
  annotation(doc.ydoc, "parent", { author: "claude" });
  reply(doc.ydoc, "parent", "r1");
  return (inbox) => replyIds(inbox).includes("r1");
}

describe.each(PATHS)("ownership leaves a record: $name (R1.1, R1.2)", (handoverPath) => {
  describe.each<ItemKind>(["comment", "reply"])("a user %s", (kind) => {
    /**
     * The holder is handed the item and acknowledges it; ownership leaves;
     * the record that reads the document next (its new holder, or one that
     * may claim it) is then handed it once, on a fresh cursor or on one whose
     * mark had already passed it.
     *
     * Under inbox scope (the scope PR) the "past" reader's mark passes the
     * item because the document was not its to answer: its default polls
     * read the document as empty while the holder had it (R1.2).
     */
    async function scenario(who: "fresh" | "past"): Promise<void> {
      const holder = handoverPath.holder ?? A;
      const nextOwner = handoverPath.next ?? B;
      const doc = await (handoverPath.open?.() ?? Promise.resolve(mkDoc("d")));
      await (handoverPath.own ?? ((d: Doc) => claim(d.id)))(doc);
      const handed = seedItem(doc, kind);

      const a = reader(holder);
      expect(handed(await a.poll()), "the holder is handed it").toBe(true);
      expect(handed(await a.poll()), "the holder acknowledged it").toBe(false);
      const b = reader(nextOwner);
      if (who === "past") {
        // Not its document: its mark passes the item unhanded.
        expect(handed(await b.poll()), "the next reader's mark passes it unhanded").toBe(false);
        expect(handed(await b.poll())).toBe(false);
      }

      const counterAtHandover = deliveryRegistry.counter;
      expect(counterAtHandover).toBeGreaterThan(0);
      const after = await handoverPath.leave(doc);
      expect(markOf(after.id), "handoverSeq is the registry's counter").toBe(counterAtHandover);

      const next = who === "fresh" ? reader(nextOwner) : b;
      expect(handed(await next.poll()), `the ${who} reader is handed it`).toBe(true);
      expect(handed(await next.poll()), "and only once").toBe(false);
    }

    it("a fresh cursor, polling before any other poll, is handed it once", async () => {
      await scenario("fresh");
    });

    it("a reader whose mark was already past it is handed it once", async () => {
      await scenario("past");
    });
  });
});

// ---------------------------------------------------------------------------
// Notices, the cursor-less reader and the previous owner's own cursor, on both
// tab-close paths and on one setDocOwner path. The annotation read that tells
// a notice's key from a comment's happens at a different point on each.

const NOTICE_PATHS = PATHS.filter(
  (p) =>
    p.name === "a lapse to unowned" ||
    p.name.startsWith("a tab close through POST /api/close") ||
    p.name.startsWith("a tab close through tandem_close"),
);

describe.each(NOTICE_PATHS)(
  "comments are owed again and notices are not: $name (R1.2, R1.3, R1.7)",
  (handoverPath) => {
    /**
     * Every notice path leaves the document unowned, so after the handover
     * one record claims it with its first poll, and under inbox scope only
     * that record reads it. `whoReads` is that record: a bystander (B), whose
     * cursor-less poll and cursor past the mark are each handed the comment,
     * or the previous holder alone (the lone-session case), on its own cursor
     * and cursor-less.
     */
    it.each(["a bystander", "the previous holder"] as const)(
      "cursor-less and past the mark, %s is handed the comment, never the notice",
      async (whoReads) => {
        // Each path's own document and holder: `claimed`, `opened` by a real
        // `tandem_open`, or Tandem's Claude by default.
        const holder = handoverPath.holder ?? A;
        const after = whoReads === "a bystander" ? B : holder;
        const doc = await (handoverPath.open?.() ?? Promise.resolve(mkDoc("d")));
        await (handoverPath.own ?? ((d: Doc) => claim(d.id)))(doc);
        annotation(doc.ydoc, "c1");
        annotation(doc.ydoc, "n1", { author: "claude", status: "accepted" });

        const a = reader(holder);
        const first = await a.poll();
        expect(actionIds(first)).toEqual(["c1"]);
        expect(responseIds(first)).toEqual(["n1"]);
        await a.poll();
        const b = reader(after);
        const passed = await b.poll();
        expect([...actionIds(passed), ...responseIds(passed)]).toEqual([]);
        // Into the cursor-less ledger first, or the cursor-less arm passes on master.
        const legacyFirst = await pollAs(holder);
        expect(actionIds(legacyFirst)).toEqual(["c1"]);
        expect(responseIds(legacyFirst)).toEqual(["n1"]);
        const legacyAgain = await pollAs(holder);
        expect([...actionIds(legacyAgain), ...responseIds(legacyAgain)]).toEqual([]);

        const counter = deliveryRegistry.counter;
        const left = await handoverPath.leave(doc);
        expect(markOf(left.id)).toBe(counter);

        const legacyAfter = await pollAs(after);
        expect(actionIds(legacyAfter), "cursor-less: the comment").toEqual(["c1"]);
        expect(responseIds(legacyAfter), "cursor-less: no notice").toEqual([]);
        expect(actionIds(await pollAs(after))).toEqual([]);
        expect(getDocOwner(left.id), "that poll claimed it").toMatchObject({ ownerId: after });

        const bAfter = await b.poll();
        expect(actionIds(bAfter), "past the mark: the comment").toEqual(["c1"]);
        expect(responseIds(bAfter), "past the mark: no notice").toEqual([]);

        // The mark outlives whatever came next (a reopen, an unowned spell).
        expect(markOf(left.id)).toBe(counter);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// The remaining cases run on one path, a lapse: every path reaches the same
// private function with nothing but the document id (pinned from source in
// `ownership-source-pins.test.ts`).

/**
 * A holds `d`, was handed the item and acknowledged it; a second cursor of
 * A's (`b`) then passed it as seen. Under inbox scope a reader past the mark
 * must be one the document is read for: after a lapse to unowned, A's next
 * poll may claim it again.
 */
async function seenByAll(_doc: Doc, handed: (inbox: Inbox) => boolean) {
  const a = reader(A);
  expect(handed(await a.poll())).toBe(true);
  expect(handed(await a.poll())).toBe(false);
  const b = reader(A);
  expect(handed(await b.poll())).toBe(false);
  expect(handed(await b.poll())).toBe(false);
  return { a, b };
}

describe("a cursor-less reader (R1.2)", () => {
  it.each<ItemKind>(["comment", "reply"])("is handed a user %s once per handover", async (kind) => {
    const doc = mkDoc("d");
    claim(doc.id);
    const handed = seedItem(doc, kind);
    expect(handed(await legacyPoll()), "handed, so it is in the cursor-less ledger").toBe(true);
    expect(handed(await legacyPoll()), "not handed twice").toBe(false);

    lapseNow(A);

    expect(handed(await legacyPoll()), "handed again after the handover").toBe(true);
    expect(handed(await legacyPoll()), "and only once").toBe(false);
  });
});

describe("gap (a), closed by inbox scope", () => {
  // The handover PR's gap (a), flipped by the scope PR: the previous owner,
  // any other session and a cursor-less poll no longer read the document, so
  // none of them can acknowledge the re-owed item away from its new holder.
  it("after a handover from A to B, A's next poll does not read the document, and a fresh cursor as B is handed the item", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    annotation(doc.ydoc, "c1");
    const handed = (inbox: Inbox) => actionIds(inbox).includes("c1");
    const a = reader(A);
    expect(handed(await a.poll())).toBe(true);
    expect(handed(await a.poll())).toBe(false);

    setDocOwner(doc.id, { ownerId: B, kind: "opened" }, "take", B);
    expect(markOf(doc.id), "the handover ran").toBeGreaterThan(0);

    // A, C and cursor-less polls by both, repeatedly: none reads the document.
    for (let i = 0; i < 2; i++) {
      expect(handed(await a.poll()), "the previous owner").toBe(false);
      expect(handed(await reader(C).poll()), "another session").toBe(false);
      expect(handed(await pollAs(A)), "cursor-less, the previous owner").toBe(false);
      expect(handed(await pollAs(C)), "cursor-less, another session").toBe(false);
    }
    const fresh = reader(B);
    expect(handed(await fresh.poll()), "a fresh cursor as B is handed it").toBe(true);
    expect(handed(await fresh.poll()), "once").toBe(false);
  });
});

describe("items on other documents are untouched (R1.2)", () => {
  it("a second document's acknowledged item stays seen after the first one's handover", async () => {
    const one = mkDoc("one");
    const two = mkDoc("two");
    claim(one.id);
    setDocOwner(two.id, { ownerId: B, kind: "opened" }, "take", B);
    annotation(one.ydoc, "c1");
    annotation(two.ydoc, "c2");
    reply(two.ydoc, "c2", "r2");

    // Each holder is handed its own document's items and acknowledges them;
    // B also takes them cursor-less (so they are in the cursor-less ledger).
    const a = reader(A);
    expect(actionIds(await a.poll())).toEqual(["c1"]);
    await a.poll();
    const b = reader(B);
    expect(actionIds(await b.poll())).toEqual(["c2"]);
    await b.poll();
    const legacy = await pollAs(B);
    expect(actionIds(legacy)).toEqual(["c2"]);
    expect(replyIds(legacy)).toEqual(["r2"]);

    lapseNow(A);
    expect(getDocOwner(two.id)).toMatchObject({ ownerId: B });
    expect(markOf(two.id)).toBeUndefined();

    // B reads both now: the first document is unowned and B may claim it.
    const fresh = await reader(B).poll();
    expect(actionIds(fresh), "fresh").toEqual(["c1"]);
    expect(replyIds(fresh)).toEqual([]);
    const past = await b.poll();
    expect(actionIds(past), "past the mark").toEqual(["c1"]);
    expect(replyIds(past)).toEqual([]);
    const legacyAfter = await pollAs(B);
    expect(actionIds(legacyAfter), "cursor-less").toEqual(["c1"]);
    expect(replyIds(legacyAfter)).toEqual([]);
  });
});

describe("an item that does not qualify at the handover is not lost (R1.2: no gate of its own)", () => {
  /**
   * Checked with B, whose mark is past the entry, and a cursor-less poll
   * only: a reader whose mark is BELOW the entry retires it for a non-held
   * reason, and the case would then pass with no handover.
   */
  async function heldThenQualifies(
    disqualify: (doc: Doc) => void,
    qualify: (doc: Doc) => void,
  ): Promise<void> {
    const doc = mkDoc("d");
    claim(doc.id);
    annotation(doc.ydoc, "c1");
    const handed = (inbox: Inbox) => actionIds(inbox).includes("c1");
    const { b } = await seenByAll(doc, handed);

    disqualify(doc);
    lapseNow(A);

    expect(handed(await b.poll()), "nobody is handed it while it does not qualify").toBe(false);
    expect(handed(await legacyPoll())).toBe(false);

    qualify(doc);
    expect(handed(await b.poll()), "handed once it qualifies").toBe(true);
    expect(handed(await b.poll()), "and only once").toBe(false);
  }

  it("held by Solo mode", async () => {
    await heldThenQualifies(
      () => setCtrlMode("solo"),
      () => setCtrlMode("tandem"),
    );
  });

  it("held under an indeterminate mode by its own stamp", async () => {
    await heldThenQualifies(
      (doc) => {
        patch(doc.ydoc, "c1", { heldInSolo: true });
        setCtrlMode(null);
      },
      () => setCtrlMode("tandem"),
    );
  });

  it("private at the handover, outbound again at the same editedAt", async () => {
    // No shipped path makes a handed comment private and outbound again: raw writes.
    await heldThenQualifies(
      (doc) => patch(doc.ydoc, "c1", { audience: "private" }),
      (doc) => patch(doc.ydoc, "c1", { audience: "outbound" }),
    );
  });

  it("resolved and never edited, then the resolve undone", async () => {
    await heldThenQualifies(
      (doc) => patch(doc.ydoc, "c1", { status: "accepted" }),
      (doc) => patch(doc.ydoc, "c1", { status: "pending" }),
    );
  });

  it("a cursor-less reader whose registry entry was already retired before the handover", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    const handed = (inbox: Inbox) => actionIds(inbox).includes("c1");
    // A cursor reader whose numeric mark predates the comment and its
    // cursor-less hand-out. (A fresh cursor would count the acknowledged
    // entry as seen and retire nothing.)
    const early = reader(A);
    await early.poll();
    await early.poll();
    annotation(doc.ydoc, "c1");

    expect(handed(await legacyPoll())).toBe(true);
    patch(doc.ydoc, "c1", { status: "accepted" });
    // Its mark is below the entry and the comment no longer qualifies: retired.
    expect(handed(await early.poll())).toBe(false);
    expect(deliveryRegistry.entriesIn(doc.id)).toEqual([]);

    lapseNow(A);
    patch(doc.ydoc, "c1", { status: "pending" });

    expect(handed(await legacyPoll()), "handed once after the Undo").toBe(true);
    expect(handed(await legacyPoll())).toBe(false);
  });

  it("a cursor-less reader's REPLY whose registry entry was already retired before the handover", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    const handed = (inbox: Inbox) => replyIds(inbox).includes("r1");
    const early = reader(A);
    await early.poll();
    await early.poll();
    annotation(doc.ydoc, "parent", { author: "claude" });
    reply(doc.ydoc, "parent", "r1");

    expect(handed(await legacyPoll())).toBe(true);
    // The thread stops being Claude-facing, so the reply no longer qualifies:
    // the early reader's mark is below its entry, which is retired.
    patch(doc.ydoc, "parent", { audience: "private" });
    expect(handed(await early.poll())).toBe(false);
    expect(deliveryRegistry.entriesIn(doc.id)).toEqual([]);

    lapseNow(A);
    patch(doc.ydoc, "parent", { audience: "outbound" });

    // Its key was still in the cursor-less reply ledger, with no registry
    // entry to derive it from.
    expect(handed(await legacyPoll()), "handed once after it qualifies again").toBe(true);
    expect(handed(await legacyPoll())).toBe(false);
  });

  it.each([
    { handover: true, expected: true },
    { handover: false, expected: false },
  ])(
    "a resolved comment that WAS edited is handed again (handover: $handover)",
    async ({ handover, expected }) => {
      const doc = mkDoc("d");
      claim(doc.id);
      // The edited version is handed and acknowledged BEFORE the resolve, so
      // without a handover its edit is accounted for and nobody is handed it.
      annotation(doc.ydoc, "c1", { editedAt: 5000 });
      const handed = (inbox: Inbox) => actionIds(inbox).includes("c1");
      const { b } = await seenByAll(doc, handed);
      patch(doc.ydoc, "c1", { status: "dismissed" });
      expect(handed(await b.poll())).toBe(false);

      if (handover) lapseNow(A);

      expect(handed(await b.poll())).toBe(expected);
      expect(handed(await b.poll())).toBe(false);
    },
  );
});

describe("privacy: a handover reveals nothing (ADR-027)", () => {
  it("private records stay out of every bucket, the summary, hasNew and the cursor's held list", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    const { ydoc } = doc;
    // Positive controls: an outbound comment (answered by Claude: gap (c)), a
    // user reply on a Claude-facing thread, and one under a RESOLVED parent.
    annotation(ydoc, "outbound");
    reply(ydoc, "outbound", "claude-answer", { author: "claude" });
    annotation(ydoc, "thread", { author: "claude" });
    reply(ydoc, "thread", "visible-reply");
    annotation(ydoc, "resolved-thread", { author: "claude", status: "accepted" });
    reply(ydoc, "resolved-thread", "reply-under-resolved");
    // Private records, each with text that must never appear.
    annotation(ydoc, "a-note", { type: "note", audience: "private", content: "SECRET-note" });
    reply(ydoc, "a-note", "note-reply", { text: "SECRET-note-reply" });
    annotation(ydoc, "private-comment", { audience: "private", content: "SECRET-private-comment" });
    annotation(ydoc, "word-import", {
      author: "import",
      type: "note",
      audience: "private",
      content: "SECRET-import",
    });
    reply(ydoc, "word-import", "import-reply", {
      author: "import",
      private: true,
      text: "SECRET-import-reply",
    });
    annotation(ydoc, "legacy-flag", { type: "flag", content: "SECRET-flag" });
    annotation(ydoc, "a-highlight", { type: "highlight", content: "SECRET-highlight" });
    reply(ydoc, "thread", "private-reply", { private: true, text: "SECRET-private-reply" });
    // A note promoted to a comment: the comment is Claude-facing, its earlier replies are not.
    annotation(ydoc, "promoted");
    reply(ydoc, "promoted", "promoted-early", { private: true, text: "SECRET-promoted-early" });

    const controls = {
      actions: ["outbound", "promoted"],
      replies: ["reply-under-resolved", "visible-reply"],
    };
    const a = reader(A);
    const first = await a.poll();
    expect(actionIds(first)).toEqual(controls.actions);
    expect(replyIds(first)).toEqual(controls.replies);
    expect(responseIds(first)).toEqual(["resolved-thread"]);
    await a.poll();
    const b = reader(B);
    const passed = await b.poll();
    expect(passed.hasNew).toBe(false);

    lapseNow(A);

    const after = await b.poll();
    // The positive control, in the same poll: these ARE handed again.
    expect(actionIds(after)).toEqual(controls.actions);
    expect(replyIds(after)).toEqual(controls.replies);
    // The notice is not, and nothing private is.
    expect(responseIds(after)).toEqual([]);
    expect(JSON.stringify(after)).not.toContain("SECRET");
    for (const id of [
      "a-note",
      "note-reply",
      "private-comment",
      "word-import",
      "import-reply",
      "legacy-flag",
      "a-highlight",
      "private-reply",
      "promoted-early",
    ]) {
      expect(JSON.stringify(after), id).not.toContain(`"${id}"`);
    }
    expect(after.hasNew).toBe(true);
    expect(after.summary).toContain("2 new: 2 comments");
    expect(after.summary).toContain("2 new replies");
    expect(after.summary).not.toMatch(/\b[3-9] new\b|note|highlight/);
    const held = decodeCursor(after.cursor).cursor.docs.get(doc.id)?.held ?? new Set();
    expect([...held]).toEqual([]);

    const again = await b.poll();
    expect(again.hasNew).toBe(false);

    // A cursor-less poll by B, which now holds the document (its cursor poll
    // above claimed it) and whose ledger held none of it, sees the same and no more.
    const legacy = await pollAs(B);
    expect(actionIds(legacy)).toEqual(controls.actions);
    expect(replyIds(legacy)).toEqual(controls.replies);
    expect(JSON.stringify(legacy)).not.toContain("SECRET");
    expect(legacy.summary).not.toMatch(/\b[3-9] new\b|note|highlight/);
  });
});

describe("an item already in a reader's held list (Solo)", () => {
  it("leaves the held list at the handover, is not handed in Solo, and is handed once when Solo lifts", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    // A second cursor of the holder's, with a numeric mark from before the
    // comment existed (under inbox scope only the holder reads the document).
    const b = reader(A);
    await b.poll();
    await b.poll();
    annotation(doc.ydoc, "c1");
    annotation(doc.ydoc, "a-note", { type: "note", audience: "private", content: "SECRET-note" });
    const handed = (inbox: Inbox) => actionIds(inbox).includes("c1");
    const a = reader(A);
    expect(handed(await a.poll())).toBe(true);
    await a.poll();
    const heldIn = (cursor: string) => [
      ...(decodeCursor(cursor).cursor.docs.get(doc.id)?.held ?? new Set<number>()),
    ];

    setCtrlMode("solo");
    // B's mark passes the comment while Solo withholds it: held in its cursor.
    expect(handed(await b.poll())).toBe(false);
    expect(heldIn(b.cursor)).toHaveLength(1);

    lapseNow(A);

    // The entry the held seq named is gone, so the list is empty; nothing
    // private ever had an entry to put there.
    const inSolo = await b.poll();
    expect(handed(inSolo)).toBe(false);
    expect(inSolo.hasNew).toBe(false);
    expect(heldIn(b.cursor)).toEqual([]);
    expect(JSON.stringify(inSolo)).not.toContain("SECRET");

    setCtrlMode("tandem");
    const lifted = await b.poll();
    expect(handed(lifted), "handed once Solo lifts").toBe(true);
    expect(JSON.stringify(lifted)).not.toContain("SECRET");
    expect(heldIn(b.cursor)).toEqual([]);
    expect(handed(await b.poll())).toBe(false);
  });
});

describe("notices behave exactly as on master (R1.3)", () => {
  type Who = "below" | "above" | "aboveUnacked" | "fresh" | "legacy";

  /**
   * One sequence, run with and without a handover, for one reader. Three
   * notices: `acked` (A was handed it and acknowledged), `unacked` (A was
   * handed it and never polled again), `unseen` (no poll returned it). The
   * user comment `u1` is the in-run proof that the handover ran.
   */
  async function noticeRun(who: Who, handover: boolean) {
    await buildWorld();
    const doc = mkDoc("d");
    claim(doc.id);
    // Every reader is a cursor of A's: under inbox scope the holder, and once
    // ownership left it, a record that may claim it, is the one that reads.
    const below = reader(A);
    await below.poll();
    await below.poll();

    annotation(doc.ydoc, "u1");
    annotation(doc.ydoc, "acked", { author: "claude", status: "accepted" });
    const a = reader(A);
    await a.poll();
    await a.poll();
    const above = reader(A);
    await above.poll();
    await above.poll();

    annotation(doc.ydoc, "unacked", { author: "claude", status: "dismissed" });
    expect(responseIds(await a.poll())).toEqual(["unacked"]);
    // A reader that was handed the unacknowledged notice and has not passed
    // its cursor back: its mark is above the notice, which nobody acknowledged.
    const aboveUnacked = reader(A);
    if (who === "aboveUnacked") {
      expect(responseIds(await aboveUnacked.poll())).toContain("unacked");
    }
    annotation(doc.ydoc, "unseen", { author: "claude", status: "accepted" });

    if (handover) lapseNow(A);

    const poll =
      who === "legacy"
        ? legacyPoll
        : who === "fresh"
          ? (() => {
              const fresh = reader(A);
              return () => fresh.poll();
            })()
          : who === "below"
            ? () => below.poll()
            : who === "aboveUnacked"
              ? () => aboveUnacked.poll()
              : () => above.poll();
    const first = await poll();
    const second = await poll();
    return {
      notices: [responseIds(first), responseIds(second)],
      comments: [actionIds(first), actionIds(second)],
      mark: markOf(doc.id),
    };
  }

  it.each<Who>(["below", "above", "aboveUnacked", "fresh", "legacy"])(
    "a reader %s the notices is handed the same notices with and without a handover",
    async (who) => {
      const without = await noticeRun(who, false);
      const withHandover = await noticeRun(who, true);
      expect(withHandover.notices).toEqual(without.notices);
      // Not vacuous: the reader is handed at least the notice no poll had returned.
      expect(without.notices[0]).toContain("unseen");
      // The handover ran in one run and not in the other.
      expect(withHandover.mark).toBeGreaterThan(0);
      expect(without.mark).toBeUndefined();
      // The handover ran: the comment is owed again wherever it had been seen.
      expect(withHandover.comments[0]).toEqual(["u1"]);
      if (who === "above" || who === "fresh") expect(without.comments[0]).toEqual([]);
      // Retiring an unacknowledged notice would hand it to this reader twice.
      if (who === "aboveUnacked") expect(withHandover.notices[0]).toEqual(["unseen"]);
    },
  );

  it("a user comment whose id ends in #accepted is re-owed as a comment", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    // Client-written ids: this comment has the very key of `x`'s accept notice.
    annotation(doc.ydoc, "x#accepted");
    annotation(doc.ydoc, "x", { author: "claude", status: "accepted" });
    const handed = (inbox: Inbox) => actionIds(inbox).includes("x#accepted");
    const { b } = await seenByAll(doc, handed);

    lapseNow(A);

    const after = await b.poll();
    expect(handed(after)).toBe(true);
    // The cost, on record: the two share one key, so giving it up also hands
    // `x`'s own accept notice once more.
    expect(responseIds(after)).toEqual(["x"]);
    const again = await b.poll();
    expect(handed(again)).toBe(false);
    expect(responseIds(again)).toEqual([]);
  });

  /**
   * The rule as the review of this PR widened it: a key is a notice's only if
   * no OTHER current record on the document has it, whatever that record is
   * at the handover. A user comment with a notice's key that is a note, a
   * highlight, a private comment or a malformed record at that moment, and a
   * comment again later, must still be owed again.
   */
  it.each<{ name: string; disguise: (doc: Doc) => void }>([
    {
      name: "a note",
      disguise: (doc) => patch(doc.ydoc, "x#accepted", { type: "note", audience: "private" }),
    },
    {
      name: "a highlight",
      disguise: (doc) => patch(doc.ydoc, "x#accepted", { type: "highlight" }),
    },
    {
      name: "a private comment",
      disguise: (doc) => patch(doc.ydoc, "x#accepted", { audience: "private" }),
    },
    {
      name: "a malformed record",
      disguise: (doc) =>
        withInternal(doc.ydoc, () =>
          doc.ydoc.getMap(Y_MAP_ANNOTATIONS).set("x#accepted", "garbage"),
        ),
    },
  ])(
    "a user comment with a notice's key that is $name at the handover is still owed again",
    async ({ disguise }) => {
      const doc = mkDoc("d");
      claim(doc.id);
      annotation(doc.ydoc, "x#accepted");
      annotation(doc.ydoc, "x", { author: "claude" });
      const handed = (inbox: Inbox) => actionIds(inbox).includes("x#accepted");
      const { b } = await seenByAll(doc, handed);
      const original = doc.ydoc.getMap(Y_MAP_ANNOTATIONS).get("x#accepted");

      disguise(doc);
      patch(doc.ydoc, "x", { status: "accepted" });
      lapseNow(A);
      withInternal(doc.ydoc, () => doc.ydoc.getMap(Y_MAP_ANNOTATIONS).set("x#accepted", original));

      expect(handed(await b.poll())).toBe(true);
      expect(handed(await b.poll())).toBe(false);
    },
  );

  it("a Claude annotation at an unrecognised stored status has its notice left alone; a key no current annotation has is forgotten", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    annotation(doc.ydoc, "u1");
    annotation(doc.ydoc, "odd", { author: "claude", status: "archived" });
    // The notice arm admits any status but pending; whether the response
    // schema then admits the item is beside the point here, so the entries
    // are made directly, as a poll that returned them would have.
    const key = (suffix: string) => `${doc.id}:${suffix}`;
    for (const base of [key("odd#archived"), key("odd#accepted"), key("deleted#accepted")]) {
      deliveryRegistry.markAcked(deliveryRegistry.assign("a", doc.id, base, 0));
    }
    const { b } = await seenByAll(doc, (inbox) => actionIds(inbox).includes("u1"));

    lapseNow(A);

    expect(deliveryRegistry.lookup("a", key("odd#archived"), 0), "current status").toBeDefined();
    expect(deliveryRegistry.lookup("a", key("odd#accepted"), 0), "superseded").toBeUndefined();
    expect(deliveryRegistry.lookup("a", key("deleted#accepted"), 0), "deleted").toBeUndefined();
    expect(actionIds(await b.poll())).toEqual(["u1"]);
  });

  it.each([
    { handover: true, expected: ["n1"] },
    { handover: false, expected: [] },
  ])(
    "a notice whose status was superseded at the handover repeats if that status recurs (handover: $handover)",
    async ({ handover, expected }) => {
      const doc = mkDoc("d");
      claim(doc.id);
      annotation(doc.ydoc, "n1", { author: "claude", status: "accepted" });
      const { b } = await seenByAll(doc, (inbox) => responseIds(inbox).includes("n1"));
      patch(doc.ydoc, "n1", { status: "pending" });

      if (handover) lapseNow(A);

      patch(doc.ydoc, "n1", { status: "accepted" });
      expect(responseIds(await b.poll())).toEqual(expected);
    },
  );
});

describe("what is not a handover (R1.1)", () => {
  it("a claim of an unowned document (by a poll or a write) and the user-open default re-owe nothing and write no mark", async () => {
    const claimed = mkDoc("claimed");
    const written = mkDoc("written");
    const defaulted = mkDoc("defaulted");
    annotation(claimed.ydoc, "c1");
    const handed = (inbox: Inbox) => actionIds(inbox);
    // A claim by a poll (the scope PR): A is handed c1 and so claims `claimed`.
    const a = reader(A);
    expect(handed(await a.poll())).toEqual(["c1"]);
    await a.poll();
    expect(getDocOwner(claimed.id)).toMatchObject({ ownerId: A, kind: "claimed" });
    const b = reader(B);
    expect(handed(await b.poll())).toEqual([]);
    expect(deliveryRegistry.counter).toBeGreaterThan(0);

    // A claim, by a real write on an unowned document.
    const wrote = await as(A, "tandem_comment", {
      from: 0,
      to: 5,
      text: "a claim",
      documentId: written.id,
    });
    expect(wrote.error).toBe(false);
    expect(getDocOwner(written.id)).toMatchObject({ ownerId: A, kind: "claimed" });
    // The user-open default, with Tandem's Claude present so it really assigns.
    setTandemPresenceSource(() => true);
    applyUserOpenDefault(defaulted.id);
    expect(getDocOwner(defaulted.id)).toMatchObject({ ownerId: TANDEM_OWNER_ID });
    // A change that leaves the owner the same.
    setDocOwner(claimed.id, { ownerId: A, kind: "opened" }, "take", A);

    expect(ownershipSnapshotForTests().handoverSeq).toEqual([]);
    expect(handed(await b.poll())).toEqual([]);

    // And the wiring is live in this run: a real handover does both.
    setTandemPresenceSource(() => false);
    const counter = deliveryRegistry.counter;
    lapseNow(A);
    expect(new Map(ownershipSnapshotForTests().handoverSeq).get(claimed.id)).toBe(counter);
    expect(handed(await b.poll())).toEqual(["c1"]);
  });
});

describe("no reader skips the document on a stale quiet record (R1.5)", () => {
  /** How many times the document's annotations were read. */
  function readsOf(id: string, spy: { mock: { contexts: unknown[] } }): number {
    return spy.mock.contexts.filter((store) => (store as YDocStore).documentId === id).length;
  }

  it.each(["cursor", "cursor-less"] as const)(
    "a %s default poll reads a quiet background document again after a handover",
    async (contract) => {
      const doc = mkDoc("background");
      claim(doc.id);
      annotation(doc.ydoc, "c1");
      const handed = (inbox: Inbox) => actionIds(inbox).includes("c1");
      // Polls are the holder's (under inbox scope only it reads the document).
      const b = reader(A);
      const poll = contract === "cursor" ? () => b.poll() : legacyPoll;
      expect(handed(await poll())).toBe(true);
      // The quiet fixed point is recorded by a pass that returns nothing.
      await poll();
      await poll();

      // A detaches; its grace is running and has not ended.
      setGraceMsForTests(60_000);
      detach(A);
      const spy = vi.spyOn(YDocStore.prototype, "listAnnotations");
      expect(handed(await poll())).toBe(false);
      expect(readsOf(doc.id, spy), "the control poll skips the quiet document").toBe(0);

      // The lapse leaves the document in the background (a take would activate it).
      lapseNow(A);
      expect(getDocOwner(doc.id)).toBeUndefined();
      spy.mockClear();

      expect(handed(await poll()), "the next default poll hands the item").toBe(true);
      // One read by the poll's pass.
      expect(readsOf(doc.id, spy)).toBe(1);
    },
  );
});

describe("handoverSeq (R1.4)", () => {
  it("is the real counter where the document becomes unowned, not setDocOwner's 0", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    annotation(doc.ydoc, "c1");
    await reader(A).poll();
    const counter = deliveryRegistry.counter;
    expect(counter).toBeGreaterThan(0);

    lapseNow(A);

    expect(getDocOwner(doc.id)).toBeUndefined();
    expect(markOf(doc.id)).toBe(counter);
  });
});

describe("the cost of a handover is bounded (counted, not timed)", () => {
  it("300 comments: one annotation read and one visit per registry entry; the poll after reads the document once", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    const N = 300;
    for (let i = 0; i < N; i++) annotation(doc.ydoc, `c${i}`);
    const a = reader(A);
    expect((await a.poll()).userActions).toHaveLength(N);
    await a.poll();
    const b = reader(B);
    expect((await b.poll()).userActions).toHaveLength(0);

    const reads = vi.spyOn(YDocStore.prototype, "listAnnotations");
    const readsOfDoc = () =>
      reads.mock.contexts.filter((store) => (store as YDocStore).documentId === doc.id).length;
    let visits = 0;
    const original = deliveryRegistry.retireWhere.bind(deliveryRegistry);
    const retire = vi.spyOn(deliveryRegistry, "retireWhere").mockImplementation((scope, drop) =>
      original(scope, (entry) => {
        visits++;
        return drop(entry);
      }),
    );

    lapseNow(A);

    // The handover: one read of the annotation store, one pass over the
    // document's registry entries (each visited once). It also walks the two
    // cursor-less ledgers once each, which hold every document's keys.
    expect(readsOfDoc()).toBe(1);
    expect(retire).toHaveBeenCalledTimes(1);
    expect(visits).toBe(N);
    expect(deliveryRegistry.entriesIn(doc.id)).toEqual([]);

    reads.mockClear();
    expect((await b.poll()).userActions).toHaveLength(N);
    // The poll after it: one read of that document's annotations.
    expect(readsOfDoc()).toBe(1);
  });
});

describe("a handover cannot fail the change it rides on (R1.9)", () => {
  const SECRET_OWNER = A;
  const SECRET_PATH = "/home/someone/private/plan.md";
  const SECRET_TEXT = "the user's own comment text";

  function captureErrors() {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    return () => spy.mock.calls.map((args) => args.map(String).join(" "));
  }

  const thrower = () => {
    throw new Error(`handover for ${SECRET_OWNER} of ${SECRET_PATH}: ${SECRET_TEXT}`);
  };

  const CHANGES: Array<{
    name: string;
    change: (doc: Doc) => Promise<void>;
    owner: string | null;
  }> = [
    {
      name: "a take",
      owner: B,
      change: async (doc) => {
        expect(takeDocument(doc.id, B)).toEqual({ ok: true, took: true });
      },
    },
    {
      name: "a lapse",
      owner: null,
      change: async () => {
        lapseNow(A);
      },
    },
    {
      name: "a close through the route",
      owner: null,
      change: async (doc) => {
        await closeByRoute(doc.id);
        expect(getOpenDocs().has(doc.id)).toBe(false);
      },
    },
    {
      name: "a close through the tool",
      owner: null,
      change: async (doc) => {
        expect((await as(A, "tandem_close", { documentId: doc.id })).error).toBe(false);
        expect(getOpenDocs().has(doc.id)).toBe(false);
      },
    },
  ];

  // A fresh world per case: the module's limiter allows one line per key a minute.
  it.each(CHANGES)(
    "$name completes when the handover throws, and the one log line carries nothing from the error",
    async ({ change, owner }) => {
      const doc = mkDoc("d");
      claim(doc.id);
      setOwnershipInboxHandover(thrower);
      const lines = captureErrors();

      await change(doc);

      expect(getDocOwner(doc.id)?.ownerId ?? null).toBe(owner);
      expect(lines()).toHaveLength(1);
      const [line] = lines();
      expect(line).toContain("[ownership] a document changed hands");
      for (const secret of [SECRET_OWNER, SECRET_PATH, SECRET_TEXT, "handover-a", doc.id]) {
        expect(line).not.toContain(secret);
      }
      // The mark is written last, so it did not move.
      expect(markOf(doc.id)).toBeUndefined();
    },
  );

  it("an annotation read that throws re-owes everything, notices included, with one fixed line", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    annotation(doc.ydoc, "c1", { content: SECRET_TEXT });
    annotation(doc.ydoc, "n1", { author: "claude", status: "accepted" });
    const { b } = await seenByAll(doc, (inbox) => actionIds(inbox).includes("c1"));
    const counter = deliveryRegistry.counter;
    const lines = captureErrors();
    vi.spyOn(YDocStore.prototype, "listAnnotations").mockImplementationOnce(() => {
      throw new Error(`cannot read ${SECRET_PATH}: ${SECRET_TEXT}`);
    });

    lapseNow(A);

    expect(getDocOwner(doc.id)).toBeUndefined();
    expect(markOf(doc.id)).toBe(counter);
    expect(lines()).toEqual([
      "[Tandem] an ownership handover found the document's annotations unreadable (or the document not open), so every item on it is owed again, accept and dismiss notices included (they may repeat).",
    ]);
    const after = await b.poll();
    expect(actionIds(after)).toEqual(["c1"]);
    // The duplicate direction: the notice repeats.
    expect(responseIds(after)).toEqual(["n1"]);
  });

  it("a sequence source that throws leaves the mark where it was and still re-owes the items", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    annotation(doc.ydoc, "c1");
    const { b } = await seenByAll(doc, (inbox) => actionIds(inbox).includes("c1"));
    const lines = captureErrors();
    setOwnershipSeqSource(thrower);

    lapseNow(A);

    expect(getDocOwner(doc.id)).toBeUndefined();
    expect(markOf(doc.id)).toBeUndefined();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).not.toContain(SECRET_TEXT);
    expect(actionIds(await b.poll())).toEqual(["c1"]);
  });

  it("a document that is not open has every key forgotten, with the fixed line", () => {
    const id = docId("never-opened");
    deliveryRegistry.markAcked(deliveryRegistry.assign("a", id, `${id}:n1#accepted`, 0));
    deliveryRegistry.markAcked(deliveryRegistry.assign("r", id, `${id}:r1`, 0));
    const lines = captureErrors();

    handOverDocumentInbox(id);

    expect(deliveryRegistry.entriesIn(id)).toEqual([]);
    expect(getDocument(id), "nothing was created").toBeUndefined();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).not.toContain(id);
  });
});

describe("the handover moves nothing and pushes nothing (R1.8)", () => {
  it("no Y.Doc transaction, no event on the push path, no change to the delivery round; and the item is re-owed", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    annotation(doc.ydoc, "c1");
    reply(doc.ydoc, "c1", "r1");
    const handed = (inbox: Inbox) =>
      actionIds(inbox).includes("c1") && replyIds(inbox).includes("r1");
    const { b } = await seenByAll(doc, handed);

    // A lapse, because a take or a close makes writes of its own.
    const events: unknown[] = [];
    const onEvent = (event: unknown) => {
      events.push(event);
    };
    subscribe(onEvent, "internal");
    subscribe(onEvent, "external");
    let transactions = 0;
    const count = () => {
      transactions++;
    };
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    doc.ydoc.on("afterTransaction", count);
    ctrl.on("afterTransaction", count);
    const snapshot = (y: Y.Doc) => JSON.stringify(y.toJSON());
    const before = { doc: snapshot(doc.ydoc), ctrl: snapshot(ctrl) };
    const now = Date.now();
    const roundBefore = JSON.stringify(getDeliveryState(now, 1));

    lapseNow(A);

    doc.ydoc.off("afterTransaction", count);
    ctrl.off("afterTransaction", count);
    unsubscribe(onEvent);
    expect(getDocOwner(doc.id)).toBeUndefined();
    expect(transactions).toBe(0);
    expect(events).toEqual([]);
    expect({ doc: snapshot(doc.ydoc), ctrl: snapshot(ctrl) }).toEqual(before);
    expect(JSON.stringify(getDeliveryState(now, 1))).toBe(roundBefore);

    // The positive: in this same run the handover re-owed the items.
    expect(handed(await b.poll())).toBe(true);
  });
});

describe("the handover at the tab-close point moves nothing and pushes nothing either (R1.8)", () => {
  it("onDocumentClosed, bracketed: no Y.Doc transaction, no event, no change to the delivery round; and the item is re-owed", async () => {
    const doc = mkDoc("d");
    claim(doc.id);
    annotation(doc.ydoc, "c1");
    const handed = (inbox: Inbox) => actionIds(inbox).includes("c1");
    const { b } = await seenByAll(doc, handed);

    const events: unknown[] = [];
    const onEvent = (event: unknown) => {
      events.push(event);
    };
    subscribe(onEvent, "internal");
    subscribe(onEvent, "external");
    let transactions = 0;
    const count = () => {
      transactions++;
    };
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    doc.ydoc.on("afterTransaction", count);
    ctrl.on("afterTransaction", count);
    const now = Date.now();
    const roundBefore = JSON.stringify(getDeliveryState(now, 1));
    const counter = deliveryRegistry.counter;

    // The tab-close point itself, which `closeDocumentById` calls between its
    // own teardown and the untrack: the close's own writes are outside it.
    onDocumentClosed(doc.id);

    doc.ydoc.off("afterTransaction", count);
    ctrl.off("afterTransaction", count);
    unsubscribe(onEvent);
    expect(getDocOwner(doc.id)).toBeUndefined();
    expect(markOf(doc.id)).toBe(counter);
    expect(transactions).toBe(0);
    expect(events).toEqual([]);
    expect(JSON.stringify(getDeliveryState(now, 1))).toBe(roundBefore);

    // The document is still open here (the untrack never ran): B is handed it.
    expect(handed(await b.poll())).toBe(true);
  });
});

describe("what a session sees beyond the brief (pinned as it stands; listed for Bryan on the PR)", () => {
  it.each([
    { handover: false, edited: true },
    { handover: true, edited: undefined },
  ])(
    "a comment edited since it was seen arrives with edited: $edited (handover: $handover)",
    async ({ handover, edited }) => {
      const doc = mkDoc("d");
      claim(doc.id);
      annotation(doc.ydoc, "c1");
      const { b } = await seenByAll(doc, (inbox) => actionIds(inbox).includes("c1"));
      patch(doc.ydoc, "c1", { content: "edited since", editedAt: 9000 });

      if (handover) lapseNow(A);

      const item = (await b.poll()).userActions.find((action) => action.id === "c1");
      expect(item).toBeDefined();
      // A handover forgets the comment was ever handed, so it arrives as new.
      expect(item?.edited).toBe(edited);
    },
  );
});

// ---------------------------------------------------------------------------
// The dark requirement. State is seeded flag-on, then the flag goes off.

describe("flag off, nothing here is reachable", () => {
  /** A holds `d`; a comment was handed to A and acknowledged; B's mark is past it. */
  async function seedFlagOn(open?: () => Promise<Doc>) {
    const doc = await (open?.() ?? Promise.resolve(mkDoc("d")));
    setDocOwner(doc.id, null, "lapse");
    claim(doc.id);
    annotation(doc.ydoc, "c1");
    const { a, b } = await seenByAll(doc, (inbox) => actionIds(inbox).includes("c1"));
    const inbox = vi.fn();
    setOwnershipInboxHandover(inbox);
    const before = ownershipSnapshotForTests();
    expect(before.ownerByDoc).toEqual([[doc.id, expect.objectContaining({ ownerId: A })]]);
    return { doc, a, b, inbox, before };
  }

  function expectDark(seeded: Awaited<ReturnType<typeof seedFlagOn>>): void {
    expect(seeded.inbox, "the inbox side was called flag-off").not.toHaveBeenCalled();
    expect(ownershipSnapshotForTests().handoverSeq).toEqual(seeded.before.handoverSeq);
  }

  it("setDocOwner: a take, a change to another record, to unowned, and a stale clearing", async () => {
    const seeded = await seedFlagOn();
    vi.stubEnv("TANDEM_OWNERSHIP", "");

    setDocOwner(seeded.doc.id, { ownerId: B, kind: "opened" }, "take", B);
    setDocOwner(seeded.doc.id, { ownerId: B, kind: "assigned" }, "take");
    setDocOwner(seeded.doc.id, null, "lapse");
    setDocOwner(seeded.doc.id, null, "stale");

    expectDark(seeded);
    // Master's behaviour: B's mark is past the comment, so it is not handed.
    expect(actionIds(await seeded.b.poll())).toEqual([]);
  });

  it("a lapse whose grace was armed flag-on and ends flag-off (to unowned and to Tandem's Claude)", async () => {
    const seeded = await seedFlagOn();
    setTandemPresenceSource(() => true);
    vi.useFakeTimers();
    try {
      setGraceMsForTests(10);
      detach(A);
      vi.stubEnv("TANDEM_OWNERSHIP", "");
      vi.advanceTimersByTime(DOC_OP_WAIT_MS + 50);
    } finally {
      vi.useRealTimers();
    }

    expectDark(seeded);
    expect(actionIds(await seeded.b.poll())).toEqual([]);
  });

  it("the real tandem_open and a real document-creating tool", async () => {
    const filePath = path.join(tmpDir, "dark.md");
    fs.writeFileSync(filePath, "Hello world, this is a test document.\n");
    const seeded = await seedFlagOn(async () => {
      const opened = await as(A, "tandem_open", { filePath });
      const id = opened.data?.documentId as string;
      return { id, ydoc: getOrCreateDocument(id), filePath };
    });
    vi.stubEnv("TANDEM_OWNERSHIP", "");

    expect((await as(B, "tandem_open", { filePath })).error).toBe(false);
    expect((await as(B, "tandem_scratchpad", {})).error).toBe(false);

    expectDark(seeded);
    expect(actionIds(await seeded.b.poll())).toEqual([]);
  });

  it.each(["route", "tool"] as const)(
    "a tab close through the real %s, then a reopen",
    async (via) => {
      const seeded = await seedFlagOn();
      const records = snapshotRecords(seeded.doc.ydoc);
      vi.stubEnv("TANDEM_OWNERSHIP", "");

      if (via === "route") await closeByRoute(seeded.doc.id);
      else expect((await as(A, "tandem_close", { documentId: seeded.doc.id })).error).toBe(false);
      expect(getOpenDocs().has(seeded.doc.id)).toBe(false);
      reopen(seeded.doc, records);

      expectDark(seeded);
      // Master: a close and reopen re-hands nothing.
      expect(actionIds(await seeded.b.poll())).toEqual([]);
      expect(actionIds(await seeded.a.poll())).toEqual([]);
    },
  );
});
