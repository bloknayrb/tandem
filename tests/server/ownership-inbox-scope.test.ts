/**
 * Inbox scope (#2358 scope PR, ADR-054; ownership design §6.2, §6.6, §6.8 as
 * amended by the scope PR's brief): a poll reads only the open documents its
 * caller holds or may claim, acknowledges only those (and documents that are
 * not open), and claims an unowned document that yields it an item.
 *
 * Everything goes through the real `tandem_checkInbox` tool, with **two
 * registered owner records, A and B, each holding a different document and
 * each with its own cursor**, plus an unowned document. Both seams are wired
 * exactly as `src/server/index.ts` wires them (the sequence source and the
 * inbox handover): an unwired one answers 0 or re-owes nothing, and the
 * `sinceSeq` and handover assertions would run against no-ops.
 *
 * Flag on for the whole file, except the dark tests at the end, which build
 * their server with the flag off. A server's `ownership` field is decided
 * when it is registered, so every world stubs the flag before it builds its
 * server.
 *
 * Platform: in-memory fixtures with synthetic paths; nothing touches the
 * filesystem, so nothing is gated.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { z } from "zod";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import {
  handOverDocumentInbox,
  registerAwarenessTools,
  resetInbox,
  setInboxResponseCorruptorForTests,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { YDocStore } from "../../src/server/mcp/document-store.js";
import { decodeCursor, deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  checkInboxOutputShape,
  checkInboxOwnershipShape,
} from "../../src/server/mcp/output-schemas.js";
import { DOC_OP_WAIT_MS, runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  beginWriteClaim,
  getDocOwner,
  type InboxClaimCheck,
  inboxOwnership,
  inboxScopeOf as inboxScopeOfReal,
  noteTransportChanged,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setGraceMsForTests,
  setInboxClaimCheckForTests,
  setInboxScopeReadForTests,
  setLossForTests,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setTandemPresenceSource,
  setTransportView,
  settleWriteClaim,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
} from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";

/** Counts each document's store resolution, so the cost test sees an excluded store never opened. */
const storeOpens = vi.hoisted(() => new Map<string, number>());
vi.mock("../../src/server/mcp/document-store.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/server/mcp/document-store.js")>();
  return {
    ...real,
    getDocumentStore: (id: string) => {
      storeOpens.set(id, (storeOpens.get(id) ?? 0) + 1);
      return real.getDocumentStore(id);
    },
  };
});

const A = "claude:scope-a";
const B = "claude:scope-b";
/** A registered record holding nothing: the fresh-cursor bystander. */
const C = "claude:scope-c";

const inboxSchema = z.object({ ...checkInboxOutputShape, ...checkInboxOwnershipShape });
type Inbox = z.infer<typeof inboxSchema>;

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs = A;
let run = 0;
let prefix = "";

const docId = (name: string) => `${prefix}-${name}`;

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 0 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

interface Doc {
  id: string;
  ydoc: Y.Doc;
}

function mkDoc(name: string, text = "Hello world, this is a test document."): Doc {
  const id = docId(name);
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return { id, ydoc };
}

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

async function pollAs(owner: string, args: Record<string, unknown> = {}): Promise<Inbox> {
  callingAs = owner;
  const result = await client.callTool({ name: "tandem_checkInbox", arguments: args });
  expect(parseResult(result).error, JSON.stringify(result)).toBe(false);
  return inboxSchema.parse((result as { structuredContent: unknown }).structuredContent);
}

/** A cursor reader: each poll passes back the cursor its last poll returned. */
function reader(owner: string) {
  let cursor = "start";
  return {
    async poll(documentId?: string): Promise<Inbox> {
      const inbox = await pollAs(owner, {
        cursor,
        ...(documentId !== undefined ? { documentId } : {}),
      });
      cursor = inbox.cursor;
      return inbox;
    },
    get cursor() {
      return cursor;
    },
  };
}

const itemIds = (inbox: Inbox) =>
  [
    ...inbox.userActions.map((a) => a.id),
    ...inbox.userResponses.map((r) => r.id),
    ...inbox.userReplies.map((r) => r.id),
  ].sort();

const ownerOf = (id: string) => getDocOwner(id)?.ownerId;

/** Each listed document's decoded position in a cursor. */
function positions(cursor: string) {
  const decoded = decodeCursor(cursor).cursor;
  return {
    m: decoded.m,
    docs: new Map([...decoded.docs].map(([id, v]) => [id, { mark: v.mark, held: [...v.held] }])),
  };
}

// The exact strings (the scope PR, R1.10), spelled out rather than built
// from `ownership-refusal.ts`, so a change to them fails here.
const GUARD = "only if the user asked you, in your own conversation, to work on it";
const NOT_A_REQUEST = "An item Tandem handed or pushed to you is not such a request.";
const EXCLUDED_NAMED = (id: string) =>
  `Document ${id} is open but is not yours to answer right now (another session may be answering it, or a write on it is still running), so nothing on it was returned and only chat is shown; its \`activity\` is empty because it is not yours to answer now, not because it could not be read. Call tandem_open on it ${GUARD}: opening it may take it from that session. ${NOT_A_REQUEST}`;
const EXCLUDED_ALL_ACTIVE = `Nothing on the open documents is yours to answer right now (another session may be answering them, or a write on one is still running); the active document's \`activity\` is empty because it is not yours to answer now, not because it could not be read. Call tandem_open on one ${GUARD}. ${NOT_A_REQUEST}`;

let docA: Doc;
let docB: Doc;
let docU: Doc;
let front: Doc;

/** The world: A holds `a`, B holds `b`, `u` is unowned; the active `front` is unowned and empty. */
async function buildWorld(flag: "1" | "" = "1"): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `scope${run}`;
  resetInbox();
  resetOwnershipForTests();
  storeOpens.clear();
  view = [];
  setTransportView(() => view);
  register(A);
  register(B);
  register(C);
  // The two lines of `src/server/index.ts`.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setCtrlMode("tandem");
  front = mkDoc("front");
  setActiveDocId(front.id);
  docA = mkDoc("a");
  docB = mkDoc("b");
  docU = mkDoc("u");
  setDocOwner(docA.id, { ownerId: A, kind: "opened" }, "take", A);
  setDocOwner(docB.id, { ownerId: B, kind: "opened" }, "take", B);
  ({ client, close } = await setupMcpServer(
    [registerAwarenessTools, registerDocumentTools, registerAnnotationTools],
    { dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }) },
  ));
}

beforeEach(async () => {
  await buildWorld();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setInboxResponseCorruptorForTests(undefined);
  for (const [id] of [...getOpenDocs()]) removeDoc(id);
  resetOwnershipForTests();
  resetInbox();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("R1.1: a default poll reads what its caller holds or may claim, and no other document", () => {
  it("A is handed A's and the unowned document's items, B the reverse of B's; the unowned one becomes A's", async () => {
    annotation(docA.ydoc, "ca");
    annotation(docB.ydoc, "cb");
    annotation(docU.ydoc, "cu");
    const a = reader(A);
    const b = reader(B);

    const counterBefore = deliveryRegistry.counter;
    const first = await a.poll();
    expect(itemIds(first)).toEqual(["ca", "cu"]);
    expect(ownerOf(docU.id), "A's poll claimed the unowned document").toBe(A);
    const entry = getDocOwner(docU.id);
    expect(entry?.kind).toBe("claimed");
    // sinceSeq is the counter before this poll's pass over `u`: the item this
    // pass registered on it is above it, so it counts as handed (design §8.5).
    const registered = deliveryRegistry.entriesIn(docU.id);
    expect(registered).toHaveLength(1);
    expect(entry?.sinceSeq).toBeGreaterThanOrEqual(counterBefore);
    expect(entry?.sinceSeq).toBeLessThan(registered[0]?.seq as number);
    expect(first.ownership).toEqual({ holding: [docA.id, docU.id].sort(), notYours: [docB.id] });

    const second = await b.poll();
    expect(itemIds(second)).toEqual(["cb"]);
    expect(second.ownership?.holding).toEqual([docB.id]);
    expect([...(second.ownership?.notYours ?? [])].sort()).toEqual([docA.id, docU.id].sort());
    expect(ownerOf(docU.id)).toBe(A);
  });

  it("the cursor-less contract is scoped the same way", async () => {
    annotation(docA.ydoc, "ca");
    annotation(docB.ydoc, "cb");
    annotation(docU.ydoc, "cu");
    expect(itemIds(await pollAs(B))).toEqual(["cb", "cu"]);
    expect(ownerOf(docU.id)).toBe(B);
    expect(itemIds(await pollAs(A))).toEqual(["ca"]);
  });

  it("an excluded document's store is never opened, and nothing on it is registered", async () => {
    annotation(docB.ydoc, "cb");
    await reader(A).poll();
    expect(storeOpens.get(docB.id) ?? 0).toBe(0);
    expect(deliveryRegistry.entriesIn(docB.id)).toEqual([]);
  });

  it("R1.6: a notice a handover kept sits below the claim's sinceSeq; what the claiming pass registered is above it", async () => {
    // B holds `u` and is handed a comment and an accept notice there.
    setDocOwner(docU.id, { ownerId: B, kind: "opened" }, "take", B);
    annotation(docU.ydoc, "cu");
    annotation(docU.ydoc, "n", { author: "claude", status: "accepted" });
    expect(itemIds(await reader(B).poll())).toEqual(["cu", "n"]);
    const noticeKey = `${docU.id}:n#accepted`;
    const kept = deliveryRegistry.lookup("a", noticeKey, 0);
    expect(kept, "the notice's entry").toBeDefined();
    // Ownership leaves B to unowned: the handover retires the comment's
    // entry and keeps the notice's.
    setDocOwner(docU.id, null, "lapse");
    expect(deliveryRegistry.lookup("a", noticeKey, 0)).toBe(kept);
    expect(deliveryRegistry.entriesIn(docU.id).map((e) => e.base)).toEqual([noticeKey]);

    // A's poll is handed both (the notice was never acknowledged) and claims `u`.
    expect(itemIds(await reader(A).poll())).toEqual(["cu", "n"]);
    const entry = getDocOwner(docU.id);
    expect(entry).toMatchObject({ ownerId: A, kind: "claimed" });
    const sinceSeq = entry?.sinceSeq as number;
    // Design §8.5 counts as handed only live entries ABOVE sinceSeq: the
    // kept notice is below it (never counted), the comment's new entry,
    // registered by this very pass, is above it.
    expect(kept?.seq).toBeLessThanOrEqual(sinceSeq);
    const comment = deliveryRegistry.entriesIn(docU.id).find((e) => e.base === `${docU.id}:cu`);
    expect(comment?.seq).toBeGreaterThan(sinceSeq);
  });

  it("a stale entry reads as unowned: the poll that claims it runs a handover in the commit (a duplicate, never a loss)", async () => {
    // Fabricated, as in the handover tests: no production path writes an
    // entry for a record that does not exist.
    setDocOwner(docU.id, { ownerId: "claude:scope-ghost", kind: "claimed" }, "claim");
    annotation(docU.ydoc, "cu");
    const a = reader(A);
    const first = await a.poll();
    expect(itemIds(first)).toContain("cu");
    expect(ownerOf(docU.id)).toBe(A);
    expect(
      new Map(ownershipSnapshotForTests().handoverSeq).get(docU.id),
      "the claim ran a handover",
    ).toBeGreaterThan(0);
    // The handover re-owed what this very poll handed: A is handed it again, once.
    expect(itemIds(await a.poll())).toContain("cu");
    expect(itemIds(await a.poll())).not.toContain("cu");
  });
});

describe("R1.2, R1.9, R1.10: a named poll of a document that is not the caller's", () => {
  it("B's document, named by A: no items, notYours, the exact summary, positions unchanged", async () => {
    annotation(docA.ydoc, "ca");
    annotation(docB.ydoc, "cb");
    const a = reader(A);
    await a.poll();
    await a.poll();
    annotation(docA.ydoc, "ca2");
    const before = positions(a.cursor);
    const named = await a.poll(docB.id);
    expect(itemIds(named)).toEqual([]);
    expect(named.ownership).toEqual({ holding: [docA.id], notYours: [docB.id] });
    expect(named.summary).toBe(`${EXCLUDED_NAMED(docB.id)} No new actions.`);
    expect(named.summary).not.toMatch(/not open|No document is open/);
    expect(positions(named.cursor)).toEqual(before);
    // Nothing of A's own was passed: its next default poll still gets ca2.
    expect(itemIds(await a.poll())).toEqual(["ca2"]);
  });

  it("an unowned document mid-write (within the bound), named by A", async () => {
    annotation(docU.ydoc, "cu");
    let release!: () => void;
    const op = runDocOp(docU.id, () => new Promise<void>((r) => (release = r)));
    const a = reader(A);
    const named = await a.poll(docU.id);
    expect(itemIds(named)).toEqual([]);
    expect(named.ownership?.notYours).toEqual([docU.id]);
    expect(named.summary).toBe(`${EXCLUDED_NAMED(docU.id)} No new actions.`);
    expect(ownerOf(docU.id)).toBeUndefined();
    release();
    await op;
  });

  it("an unowned document named by Tandem's Claude while it is not present", async () => {
    annotation(docU.ydoc, "cu");
    register(TANDEM_OWNER_ID);
    setTandemPresenceSource(() => false);
    const named = await reader(TANDEM_OWNER_ID).poll(docU.id);
    expect(itemIds(named)).toEqual([]);
    expect(named.ownership?.notYours).toEqual([docU.id]);
    expect(named.summary).toBe(`${EXCLUDED_NAMED(docU.id)} No new actions.`);
    expect(ownerOf(docU.id)).toBeUndefined();
  });

  it("an unowned document the caller holds a blocking loss for", async () => {
    annotation(docU.ydoc, "cu");
    setLossForTests(docU.id, A, "taken");
    const named = await reader(A).poll(docU.id);
    expect(itemIds(named)).toEqual([]);
    expect(named.ownership?.notYours).toEqual([docU.id]);
  });

  it("a named poll of a closed document keeps master's text and lists nothing in notYours", async () => {
    const named = await reader(A).poll("not-open-id");
    expect(named.summary).toMatch(/^Document not-open-id is not open/);
    expect(named.ownership?.notYours).toEqual([]);
  });

  it("activity: the active document held by B is named for A with nothing else", async () => {
    setActiveDocId(docB.id);
    const inbox = await reader(A).poll();
    expect(inbox.activity).toEqual({
      documentId: docB.id,
      isTyping: false,
      cursor: null,
      lastEdit: null,
      selectedText: null,
      selectionAt: null,
    });
    const named = await reader(A).poll(docB.id);
    expect(named.activity.documentId).toBe(docB.id);
    expect(named.activity.selectedText).toBeNull();
  });
});

describe("R1.3: a caller with no record", () => {
  it("reads no document, chat as on master, and is told nothing open is its to answer", async () => {
    annotation(docA.ydoc, "ca");
    annotation(docU.ydoc, "cu");
    const inbox = await reader("claude:no-record").poll();
    expect(itemIds(inbox)).toEqual([]);
    expect(inbox.summary).toBe(`${EXCLUDED_ALL_ACTIVE} No new actions.`);
    expect(inbox.ownership?.holding).toEqual([]);
    expect([...(inbox.ownership?.notYours ?? [])].sort()).toEqual(
      [front.id, docA.id, docB.id, docU.id].sort(),
    );
    expect(ownerOf(docU.id)).toBeUndefined();
    expect(deliveryRegistry.entriesIn(docU.id)).toEqual([]);
  });
});

describe("R1.5: what counts as yielding (after every gate)", () => {
  /** `u`'s only item is `seed`'s; A polls; it must not be claimed and nothing handed. */
  const fixtures: Array<{ name: string; seed: (d: Doc) => void }> = [
    {
      name: "Solo-held",
      seed: (d) => {
        annotation(d.ydoc, "x");
        setCtrlMode("solo");
      },
    },
    {
      name: "held by an indeterminate-mode stamp",
      seed: (d) => {
        annotation(d.ydoc, "x", { heldInSolo: true });
        setCtrlMode(null);
      },
    },
    { name: "a note", seed: (d) => annotation(d.ydoc, "x", { type: "note", audience: "private" }) },
    { name: "a private comment", seed: (d) => annotation(d.ydoc, "x", { audience: "private" }) },
    {
      name: "a private reply",
      seed: (d) => {
        annotation(d.ydoc, "p", { author: "claude" });
        reply(d.ydoc, "p", "x", { private: true });
      },
    },
    {
      name: "a reply held in Solo",
      seed: (d) => {
        annotation(d.ydoc, "p", { author: "claude" });
        reply(d.ydoc, "p", "x");
        setCtrlMode("solo");
      },
    },
    { name: "refused by admit", seed: (d) => annotation(d.ydoc, "x", { content: 42 }) },
    { name: "a highlight", seed: (d) => annotation(d.ydoc, "x", { type: "highlight" }) },
    {
      name: "a pending Claude annotation",
      seed: (d) => annotation(d.ydoc, "x", { author: "claude" }),
    },
    {
      name: "a Claude-resolved Claude annotation",
      seed: (d) =>
        annotation(d.ydoc, "x", { author: "claude", status: "accepted", resolvedBy: "claude" }),
    },
  ];

  it.each(fixtures)(
    "$name: not claimed, nothing handed; a qualifying item later is",
    async ({ seed }) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      seed(docU);
      const a = reader(A);
      const inbox = await a.poll();
      expect(itemIds(inbox)).toEqual([]);
      expect(ownerOf(docU.id)).toBeUndefined();
      expect(inbox.ownership?.holding).toEqual([docA.id]);

      setCtrlMode("tandem");
      annotation(docU.ydoc, "q");
      const next = await a.poll();
      expect(itemIds(next)).toContain("q");
      expect(ownerOf(docU.id)).toBe(A);
      expect(next.ownership?.holding).toEqual([docA.id, docU.id].sort());
    },
  );

  it("a document whose only item is an accept or dismiss notice IS claimed (the next PR's notice rule may change this)", async () => {
    annotation(docU.ydoc, "n", { author: "claude", status: "accepted" });
    const inbox = await reader(A).poll();
    expect(itemIds(inbox)).toEqual(["n"]);
    expect(ownerOf(docU.id)).toBe(A);
  });

  it("a chat message never claims a document, whatever documentId it carries", async () => {
    // Chat is the chat PR's (amendment 2): handed as on master, and it claims nothing.
    withInternal(getOrCreateDocument(CTRL_ROOM), () =>
      getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT).set("m1", {
        id: "m1",
        author: "user",
        text: "about u",
        timestamp: Date.now(),
        read: false,
        documentId: docU.id,
      }),
    );
    const inbox = await reader(A).poll();
    expect(inbox.chatMessages.map((m) => m.id)).toEqual(["m1"]);
    expect(ownerOf(docU.id)).toBeUndefined();
    // B, which holds nothing it could be told about here, is handed it too.
    expect((await reader(B).poll()).chatMessages.map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("R1.4: scoped acknowledgement", () => {
  it("A's polls (numeric marks and cursor-less) never hide B's unacknowledged item from a fresh cursor as B", async () => {
    annotation(docB.ydoc, "cb");
    const b = reader(B);
    expect(itemIds(await b.poll())).toEqual(["cb"]);
    // B has not acknowledged (it never passes that cursor back).
    const a = reader(A);
    for (let i = 0; i < 3; i++) {
      await a.poll();
      await pollAs(A);
    }
    expect(itemIds(await reader(B).poll()), "a fresh cursor as B").toEqual(["cb"]);
  });
});

describe("R1.5, R1.7: a claim refused at commit", () => {
  const checks: InboxClaimCheck[] = ["claimable", "open", "unowned", "record", "scope"];
  it.each(checks)(
    "refused by '%s': the response is returned, holding exact, the pass's entries retired",
    async (check) => {
      annotation(docU.ydoc, "cu");
      setInboxClaimCheckForTests((c, id) => !(c === check && id === docU.id));
      const a = reader(A);
      const inbox = await a.poll();
      expect(itemIds(inbox)).toEqual(["cu"]);
      expect(ownerOf(docU.id)).toBeUndefined();
      expect(inbox.ownership?.holding).toEqual([docA.id]);
      expect(deliveryRegistry.entriesIn(docU.id), "retired").toEqual([]);
      // It hides nothing: B, a fresh reader, is handed it (and claims it).
      setInboxClaimCheckForTests(undefined);
      expect(itemIds(await reader(B).poll())).toContain("cu");
      expect(ownerOf(docU.id)).toBe(B);
    },
  );

  it("a cursor-less poll's refused claim puts its ledger keys back", async () => {
    annotation(docU.ydoc, "cu");
    setInboxClaimCheckForTests((c) => c !== "scope");
    expect(itemIds(await pollAs(A))).toEqual(["cu"]);
    expect(ownerOf(docU.id)).toBeUndefined();
    setInboxClaimCheckForTests(undefined);
    // Another cursor-less poll is handed it again.
    expect(itemIds(await pollAs(B))).toEqual(["cu"]);
  });
});

describe("R1.7: nothing is left behind by a failed poll", () => {
  it("a forced validation failure: nothing claimed, the pass's entries retired, the next reader handed the items", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    annotation(docU.ydoc, "cu");
    annotation(docA.ydoc, "ca");
    setInboxResponseCorruptorForTests((r) => ({ ...r, hasNew: "corrupt" }));
    callingAs = A;
    const failed = await client.callTool({
      name: "tandem_checkInbox",
      arguments: { cursor: "start" },
    });
    expect(parseResult(failed).error).toBe(true);
    expect(ownerOf(docU.id)).toBeUndefined();
    expect(deliveryRegistry.entriesIn(docU.id)).toEqual([]);
    expect(deliveryRegistry.entriesIn(docA.id)).toEqual([]);
    setInboxResponseCorruptorForTests(undefined);
    expect(itemIds(await reader(B).poll())).toContain("cu");
  });

  it("a per-document throw after registering: nothing claimed there, its entries retired", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setActiveDocId(docU.id);
    annotation(docU.ydoc, "cu");
    // `readActivity` runs after the buckets registered, on the activity document only.
    const spy = vi.spyOn(YDocStore.prototype, "getUserAwareness").mockImplementation(() => {
      throw new Error("boom");
    });
    const inbox = await reader(A).poll();
    expect(spy).toHaveBeenCalled();
    expect(inbox.summary).toContain(`Could not read document ${docU.id}`);
    expect(ownerOf(docU.id)).toBeUndefined();
    expect(deliveryRegistry.entriesIn(docU.id)).toEqual([]);
    spy.mockRestore();
    expect(itemIds(await reader(B).poll())).toContain("cu");
  });

  it("a scope read that throws: the holder keeps its position, nothing is acknowledged, and it loses nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = reader(A);
    await a.poll();
    const old = a.cursor;
    annotation(docA.ydoc, "ca");
    // Handed from `old`, and that response is lost.
    expect(itemIds(await pollAs(A, { cursor: old }))).toEqual(["ca"]);
    // The response is lost: A retries with its OLD cursor and the scope read
    // for its own document throws.
    setInboxScopeReadForTests((id, caller, now) => {
      if (id === docA.id) throw new Error("boom");
      return inboxScopeOfReal(id, caller, now);
    });
    const failed = await pollAs(A, { cursor: old });
    expect(itemIds(failed)).toEqual([]);
    expect(failed.summary).toContain(`Could not read document ${docA.id}`);
    expect(failed.summary).not.toMatch(/not open|No document is open/);
    expect(failed.ownership?.notYours, "unread is not notYours").toEqual([docB.id]);
    setInboxScopeReadForTests(undefined);
    // Nothing was passed or acknowledged: from the cursor that poll returned,
    // and from a fresh cursor, A is still handed it.
    expect(itemIds(await pollAs(A, { cursor: failed.cursor }))).toEqual(["ca"]);
    expect(itemIds(await reader(A).poll())).toEqual(["ca"]);
  });
});

describe("R1.8 and amendment 3: mid-write", () => {
  it("the holder reads during a write; another session does not; after the bound the next yielding poll claims, and the write's claim is not applied", async () => {
    annotation(docA.ydoc, "ca");
    let releaseA!: () => void;
    const opA = runDocOp(docA.id, () => new Promise<void>((r) => (releaseA = r)));
    expect(itemIds(await pollAs(A)), "the holder reads mid-write").toEqual(["ca"]);
    releaseA();
    await opA;

    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    annotation(docU.ydoc, "cu");
    // A write on the unowned `u` by B that never settles.
    const pending = beginWriteClaim(docU.id, B);
    let releaseU!: () => void;
    const opU = runDocOp(docU.id, () => new Promise<void>((r) => (releaseU = r)));
    const a = reader(A);
    expect(itemIds(await a.poll()), "within the bound: excluded").toEqual([]);
    expect(deliveryRegistry.entriesIn(docU.id), "nothing registered by a non-holder").toEqual([]);
    vi.advanceTimersByTime(DOC_OP_WAIT_MS - 1);
    expect(itemIds(await a.poll())).toEqual([]);
    vi.advanceTimersByTime(1);
    const released = await a.poll();
    expect(itemIds(released), "past the bound: read").toEqual(["cu"]);
    expect(ownerOf(docU.id)).toBe(A);
    // The stuck write settles: its claim finds an entry and is not applied.
    expect(settleWriteClaim(pending, true)).toBe(false);
    releaseU();
    await opU;
    expect(ownerOf(docU.id)).toBe(A);
  });

  it("a run of healthy short operations is not released", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    annotation(docU.ydoc, "cu");
    const a = reader(A);
    for (let i = 0; i < 3; i++) {
      let release!: () => void;
      const op = runDocOp(docU.id, () => new Promise<void>((r) => (release = r)));
      vi.advanceTimersByTime(DOC_OP_WAIT_MS / 2);
      expect(itemIds(await a.poll())).toEqual([]);
      // The next operation is queued before this one settles, so the queue never goes idle.
      let releaseNext!: () => void;
      const next = runDocOp(docU.id, () => new Promise<void>((r) => (releaseNext = r)));
      release();
      await op;
      vi.advanceTimersByTime(DOC_OP_WAIT_MS / 2);
      expect(itemIds(await a.poll())).toEqual([]);
      releaseNext();
      await next;
    }
  });
});

describe("R1.11: cost", () => {
  it.each([10, 300])(
    "B has polled each of its %i documents: A's decoded cursor and store reads equal those with none",
    async (n) => {
      const measure = async (withForeign: boolean) => {
        await close?.();
        for (const [id] of [...getOpenDocs()]) removeDoc(id);
        await buildWorld();
        if (withForeign) {
          const b = reader(B);
          for (let i = 0; i < n; i++) {
            const d = mkDoc(`foreign-${i}`);
            setDocOwner(d.id, { ownerId: B, kind: "opened" }, "take", B);
            annotation(d.ydoc, `f${i}`);
          }
          expect((await b.poll()).userActions).toHaveLength(n);
        }
        annotation(docA.ydoc, "ca");
        storeOpens.clear();
        const listed = vi.spyOn(YDocStore.prototype, "listAnnotations");
        const a = reader(A);
        const inbox = await a.poll();
        const reads = listed.mock.calls.length;
        listed.mockRestore();
        const decoded = decodeCursor(inbox.cursor).cursor;
        const foreignOpens = [...storeOpens].filter(([id]) => id.includes("foreign")).length;
        return {
          m: decoded.m === deliveryRegistry.counter,
          listed: [...decoded.docs.keys()].filter((id) => id.includes("foreign")),
          docsListed: decoded.docs.size,
          opens: [...storeOpens.values()].reduce((x, y) => x + y, 0),
          reads,
          foreignOpens,
        };
      };
      const none = await measure(false);
      const foreign = await measure(true);
      expect(foreign.m).toBe(true);
      expect(foreign.listed).toEqual([]);
      expect(foreign.docsListed).toBe(none.docsListed);
      expect(foreign.foreignOpens).toBe(0);
      expect(foreign.opens).toBe(none.opens);
      expect(foreign.reads).toBe(none.reads);
    },
  );
});

describe("R2.1: the cursor carries no caller", () => {
  it("two records with the same scope receive byte-identical cursors for the same position", async () => {
    annotation(docB.ydoc, "cb");
    register("claude:scope-d");
    const c = await reader(C).poll();
    const d = await reader("claude:scope-d").poll();
    expect(c.cursor).toBe(d.cursor);
  });
});

// ---------------------------------------------------------------------------
// Dark: a server built flag-off behaves as master for every caller.

describe("flag off (the dark requirement)", () => {
  beforeEach(async () => {
    await close?.();
    await buildWorld("");
  });

  it("every caller reads every document, nothing is claimed, no ownership field", async () => {
    annotation(docA.ydoc, "ca");
    annotation(docB.ydoc, "cb");
    annotation(docU.ydoc, "cu");
    const inbox = await reader("claude:no-record").poll();
    expect(itemIds(inbox)).toEqual(["ca", "cb", "cu"]);
    expect("ownership" in inbox).toBe(false);
    // Dark, `setDocOwner` writes nothing: the world's entries never existed.
    expect(ownershipSnapshotForTests().ownerByDoc).toEqual([]);
  });

  it("a forced validation failure retires nothing (as on master)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    annotation(docU.ydoc, "cu");
    setInboxResponseCorruptorForTests((r) => ({ ...r, hasNew: "corrupt" }));
    callingAs = A;
    const failed = await client.callTool({
      name: "tandem_checkInbox",
      arguments: { cursor: "start" },
    });
    expect(parseResult(failed).error).toBe(true);
    expect(deliveryRegistry.entriesIn(docU.id)).toHaveLength(1);
  });

  it("tools/list advertises no ownership field", async () => {
    const tools = await client.listTools();
    const inbox = tools.tools.find((t) => t.name === "tandem_checkInbox");
    expect(JSON.stringify(inbox?.outputSchema)).not.toContain('"ownership"');
    expect(inboxOwnership.responseField()).toBe(false);
    expect(inboxOwnership.begin({ ownerId: A }, [docA.id], Date.now()).scoped).toBe(false);
  });
});

describe("the advertised schema and the response agree", () => {
  it("flag on: tools/list carries the field, and a poll validates against it through the SDK client", async () => {
    const tools = await client.listTools();
    const inbox = tools.tools.find((t) => t.name === "tandem_checkInbox");
    expect(JSON.stringify(inbox?.outputSchema)).toContain('"notYours"');
    annotation(docU.ydoc, "cu");
    expect(itemIds(await reader(A).poll())).toEqual(["cu"]);
  });

  it("a server registered flag-off and polled flag-on emits no ownership key", async () => {
    await close?.();
    await buildWorld("");
    await client.listTools();
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    const inbox = await reader(A).poll();
    expect("ownership" in inbox).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review round 1 on #2416 (the review session's comment of 2026-11-13).

describe("a default poll that reads some documents and leaves others out says so (review fix 2)", () => {
  it("names the excluded documents with the take guard, and lists them in notYours", async () => {
    annotation(docA.ydoc, "ca");
    annotation(docB.ydoc, "cb");
    const inbox = await reader(A).poll();
    expect(itemIds(inbox)).toEqual(["ca"]);
    expect(inbox.summary).toBe(
      `1 new: 1 comment. Some items are from documents other than the active one: ${docA.id}.md. Pass each item's documentId when acting on it. One open document is not yours to answer right now (another session may be answering it, or a write on it is still running), so nothing on it was returned: ${docB.id}.md. Call tandem_open on one ${GUARD}. ${NOT_A_REQUEST}`,
    );
    expect(inbox.ownership?.notYours).toEqual([docB.id]);
  });

  it("names five and counts the rest", async () => {
    for (let i = 0; i < 7; i++) {
      const d = mkDoc(`other-${i}`);
      setDocOwner(d.id, { ownerId: B, kind: "opened" }, "take", B);
    }
    const inbox = await reader(A).poll();
    expect(inbox.summary).toMatch(
      /^No new actions\. 8 open documents are not yours to answer right now /,
    );
    expect(inbox.summary).toContain(" and 3 more.");
    expect(inbox.ownership?.notYours).toHaveLength(8);
  });

  it("an excluded active document is named and its empty activity explained", async () => {
    setActiveDocId(docB.id);
    annotation(docA.ydoc, "ca");
    const inbox = await reader(A).poll();
    expect(inbox.summary).toContain(
      "The active document is one of them: its `activity` is empty because it is not yours to answer now, not because it could not be read.",
    );
  });
});

describe("the claim's real commit-time checks, through the inbox's door (review fix 8)", () => {
  const X = "claude:scope-x";
  function begin() {
    view.push({ ownerId: X, openStreams: 0 });
    noteTransportRegistered(X, { recordKind: "claude" });
    const scope = inboxOwnership.begin({ ownerId: X }, getOpenDocs().keys(), performance.now());
    expect(scope.scopeOf(docU.id)).toBe("may-claim");
    return scope;
  }

  // Defence in depth: with the record gone, `standingOf` refuses the claim
  // too, so this test cannot tell the record check from `true` (stated at the
  // call site). It pins that the claim is refused, and nothing written.
  it("a caller whose record is gone at commit is refused (the record check, backed by the standing rule)", () => {
    const scope = begin();
    // Its transport goes and its grace runs out: the record is deleted.
    vi.useFakeTimers();
    setGraceMsForTests(10);
    view = view.filter((e) => e.ownerId !== X);
    noteTransportChanged(X);
    vi.advanceTimersByTime(20);
    vi.useRealTimers();
    expect(ownershipSnapshotForTests().records.some((r) => r.ownerId === X)).toBe(false);
    expect(scope.claim(docU.id, deliveryRegistry.counter, true)).toBe("refused");
    expect(getDocOwner(docU.id)).toBeUndefined();
  });

  it("scope: the scope rule no longer answers may-claim (a write started on it)", async () => {
    const scope = begin();
    // Only the scope re-read sees a busy queue; the standing rule after it does not.
    let release!: () => void;
    const op = runDocOp(docU.id, () => new Promise<void>((r) => (release = r)));
    expect(scope.claim(docU.id, deliveryRegistry.counter, true)).toBe("refused");
    expect(getDocOwner(docU.id)).toBeUndefined();
    release();
    await op;
  });

  it("unowned: another record holds it at commit", () => {
    const scope = begin();
    setDocOwner(docU.id, { ownerId: B, kind: "opened" }, "take", B);
    expect(scope.claim(docU.id, deliveryRegistry.counter, true)).toBe("refused");
    expect(ownerOf(docU.id)).toBe(B);
  });

  it("open: the document closed before the commit", () => {
    const scope = begin();
    expect(scope.claim(docU.id, deliveryRegistry.counter, false)).toBe("refused");
    expect(getDocOwner(docU.id)).toBeUndefined();
  });

  it("claimable: a document the snapshot did not answer may-claim", () => {
    const scope = begin();
    expect(scope.scopeOf(docA.id)).toBe("neither");
    setDocOwner(docA.id, null, "lapse");
    expect(scope.claim(docA.id, deliveryRegistry.counter, true)).toBe("refused");
    expect(getDocOwner(docA.id)).toBeUndefined();
  });
});

describe("Tandem's Claude's poll claims as default while present (review fix 8)", () => {
  it("with no record of its own yet, a present Tandem's Claude claims the unowned document as default", async () => {
    setTandemPresenceSource(() => true);
    annotation(docU.ydoc, "cu");
    const inbox = await reader(TANDEM_OWNER_ID).poll();
    expect(itemIds(inbox)).toContain("cu");
    expect(getDocOwner(docU.id)).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
    expect(inbox.ownership?.holding).toContain(docU.id);
  });
});

describe("an unread document is not acknowledged (review fix 8)", () => {
  it("a cursor whose mark is above an unacknowledged entry does not acknowledge it while the scope read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    annotation(docA.ydoc, "ca");
    const a = reader(A);
    expect(itemIds(await a.poll())).toEqual(["ca"]);
    // `a.cursor` acknowledges ca (its mark is above it). Pass it back while
    // the scope read for A's document throws.
    setInboxScopeReadForTests((id, caller, now) => {
      if (id === docA.id) throw new Error("boom");
      return inboxScopeOfReal(id, caller, now);
    });
    await pollAs(A, { cursor: a.cursor });
    setInboxScopeReadForTests(undefined);
    expect(deliveryRegistry.entriesIn(docA.id).every((e) => !e.acked)).toBe(true);
    expect(itemIds(await reader(A).poll()), "a fresh cursor is still handed it").toEqual(["ca"]);
  });
});

describe("re-entrancy in the commit: a claim that lapses its own claimant (review fix 8)", () => {
  it("past 64 detached records, the claimant's claim re-arms its grace, the cap lapses it, and the outcome is changed", async () => {
    annotation(docU.ydoc, "cu");
    // A notice too: the lapse's handover KEEPS a notice's entry, so only the
    // "changed" undo retires the one this poll registered and acknowledged.
    annotation(docU.ydoc, "n", { author: "claude", status: "accepted" });
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    // 64 detached records, each holding a document, graces armed later than C's will be.
    vi.setSystemTime(t0 + 1_000);
    for (let i = 0; i < 64; i++) {
      const id = `claude:scope-cap-${i}`;
      register(id);
      setDocOwner(`${prefix}-held-${i}`, { ownerId: id, kind: "opened" }, "take", id);
      const entry = view.find((e) => e.ownerId === id) as TransportViewEntry;
      entry.streamEver = true;
      noteTransportChanged(id);
    }
    vi.setSystemTime(t0);
    // C detaches (it holds nothing, so the cap lapses it at once); its
    // transport stays registered, so the lapsed record lives on and may claim.
    const c = view.find((e) => e.ownerId === C) as TransportViewEntry;
    c.streamEver = true;
    noteTransportChanged(C);
    expect(ownershipSnapshotForTests().records.find((r) => r.ownerId === C)?.lapsed).toBe(true);

    const inbox = await pollAs(C);
    // C was handed the item; its claim re-armed its grace, the cap lapsed C
    // (the earliest grace among records that hold state) and the document
    // went back to unowned: holding leaves it out.
    expect(itemIds(inbox)).toContain("cu");
    expect(getDocOwner(docU.id)).toBeUndefined();
    expect(inbox.ownership?.holding).toEqual([]);
    expect(
      new Map(ownershipSnapshotForTests().handoverSeq).get(docU.id),
      "the lapse's handover ran",
    ).toBeGreaterThan(0);
    vi.useRealTimers();
    expect(
      deliveryRegistry.lookup("a", `${docU.id}:n#accepted`, 0),
      "the changed undo retired this poll's notice entry",
    ).toBeUndefined();
    // Nothing is lost: a fresh reader that may claim it is handed both.
    expect(itemIds(await reader(B).poll())).toEqual(["cu", "n"]);
  });
});

describe("a cursor-less poll's refused claim takes back its acknowledgement of an older entry (review fix 10)", () => {
  it("a kept notice acknowledged by that poll is owed again to a fresh reader", async () => {
    setDocOwner(docU.id, { ownerId: B, kind: "opened" }, "take", B);
    annotation(docU.ydoc, "n", { author: "claude", status: "accepted" });
    expect(itemIds(await reader(B).poll())).toEqual(["n"]);
    setDocOwner(docU.id, null, "lapse"); // the handover keeps the notice's entry, unacknowledged
    const kept = deliveryRegistry.lookup("a", `${docU.id}:n#accepted`, 0);
    expect(kept?.acked).toBe(false);

    setInboxClaimCheckForTests((check) => check !== "scope");
    expect(itemIds(await pollAs(A))).toEqual(["n"]);
    setInboxClaimCheckForTests(undefined);
    expect(getDocOwner(docU.id)).toBeUndefined();
    expect(kept?.acked, "the refused claim took the acknowledgement back").toBe(false);
    expect(itemIds(await reader(C).poll())).toEqual(["n"]);
  });
});

describe("labels across the summary's sentences (re-review of round 1)", () => {
  it("two documents that share a basename, one read and one excluded, are told apart", async () => {
    const mine = "scope-shared-mine";
    const theirs = "scope-shared-theirs";
    for (const [id, dir] of [
      [mine, "x1"],
      [theirs, "x2"],
    ] as const) {
      populateYDoc(getOrCreateDocument(id), "Hello world, this is a test document.");
      addDoc(id, {
        id,
        filePath: `/${dir}/notes.md`,
        format: "md",
        readOnly: false,
        source: "file",
      });
    }
    setDocOwner(mine, { ownerId: A, kind: "opened" }, "take", A);
    setDocOwner(theirs, { ownerId: B, kind: "opened" }, "take", B);
    annotation(getOrCreateDocument(mine), "cm");
    const inbox = await reader(A).poll();
    expect(itemIds(inbox)).toEqual(["cm"]);
    expect(inbox.summary).toContain(`notes.md (${mine})`);
    expect(inbox.summary).toContain(`notes.md (${theirs})`);
  });
});

describe("unacknowledge only re-owes a live entry (re-review of round 1)", () => {
  it("a retired entry is not put back among the unacknowledged", () => {
    const entry = deliveryRegistry.assign("a", docU.id, `${docU.id}:x`, 0);
    deliveryRegistry.markAcked(entry);
    deliveryRegistry.retire(entry);
    deliveryRegistry.unacknowledge(entry);
    expect(deliveryRegistry.unseenIn(docU.id, { mark: null, held: new Set() })).toEqual([]);
  });
});
