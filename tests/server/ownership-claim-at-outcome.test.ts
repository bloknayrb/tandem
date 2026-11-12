/**
 * A write's claim takes effect at its outcome, and the state the inbox work
 * will rely on (#2358 PR 2a, ADR-054; ownership design §2, §4.3, §5.1, §6.2,
 * §6.3).
 *
 * Until PR 2a a write on an unowned document claimed it at the top of the
 * queued operation and un-claimed it when the body refused on its arguments
 * or threw. Both went through the ownership-change composite, and the claim
 * was visible to readers outside the queue while the body ran. Now the claim
 * is pending and invisible until the body's outcome is known:
 *
 * - a body that ends in a never-claims refusal, or throws, leaves every piece
 *   of ownership state as it was and runs no step of the composite;
 * - while the body runs, everything outside the queue sees the document as
 *   unowned;
 * - a body that keeps its claim makes the caller the owner only if, at that
 *   moment, the document was not closed meanwhile and is open, is still
 *   unowned, and the caller's record still exists.
 *
 * Flag on for the whole file, and every caller is a **registered owner
 * record**: a caller with no record never claims, so it proves nothing here.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { addUserReply } from "../../src/server/annotations/lifecycle.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { closeDocumentById, getOpenDocs } from "../../src/server/mcp/document-service.js";
import { deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  callerOwnerInfo,
  focusHeldByAnother,
  heldAmong,
  inboxScope,
  noClaim,
  ownedOpen,
  ownedWrite,
  switchRefusal,
} from "../../src/server/mcp/owned-op.js";
import { type McpToolResult, mcpError, mcpSuccess } from "../../src/server/mcp/response.js";
import { isDocOpQueueBusy, runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  type CompositeStep,
  getDocOwner,
  getOwnerRecord,
  inboxScopeOf,
  noteTransportChanged,
  noteTransportRegistered,
  otherAnswererOf,
  otherHolderOf,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setCompositeObserverForTests,
  setDocOwner,
  setGraceMsForTests,
  setHandoverSeqForTests,
  setOwnershipSeqSource,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATIONS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";

const A = "claude:outcome-a";
const B = "claude:outcome-b";
const C = "claude:outcome-c";

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs = A;
let run = 0;
let prefix = "";
/** Every step of the composite `setDocOwner` reached, as `step:documentId`. */
let steps: string[] = [];
let seqReads = 0;

const docId = (name: string) => `${prefix}-${name}`;

function register(ownerId: string): TransportViewEntry {
  const entry: TransportViewEntry = { ownerId, openStreams: 0 };
  view.push(entry);
  noteTransportRegistered(ownerId, { recordKind: "claude" });
  return entry;
}

const entryOf = (ownerId: string) => view.find((e) => e.ownerId === ownerId) as TransportViewEntry;

/** Detach `ownerId` (its stream closed) while its transport stays registered: a grace starts. */
function detach(ownerId: string): void {
  const entry = entryOf(ownerId);
  entry.streamEver = true;
  entry.openStreams = 0;
  noteTransportChanged(ownerId);
}

/** Let `ownerId`'s grace expire. With `gone`, its transport leaves the registry first, so the record is deleted. */
function lapseNow(ownerId: string, opts: { gone?: boolean } = {}): void {
  vi.useFakeTimers();
  try {
    setGraceMsForTests(10);
    if (opts.gone) view = view.filter((e) => e.ownerId !== ownerId);
    else {
      entryOf(ownerId).streamEver = true;
      entryOf(ownerId).openStreams = 0;
    }
    noteTransportChanged(ownerId);
    vi.advanceTimersByTime(20);
  } finally {
    vi.useRealTimers();
  }
}

function setupDoc(name: string, text = "Hello world, this is a test document."): Y.Doc {
  const id = docId(name);
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return ydoc;
}

function seed(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}): void {
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "claude",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: "original",
      status: "pending",
      timestamp: 1000,
      rev: 1,
      ...extra,
    }),
  );
}

type Body = { error: boolean; code?: string; details?: Record<string, unknown> };

async function as(owner: string, tool: string, args: Record<string, unknown> = {}): Promise<Body> {
  callingAs = owner;
  return parseResult(await client.callTool({ name: tool, arguments: args })) as Body;
}

const OK = () => mcpSuccess({ done: true });

/**
 * A write by `owner` on `name` through the real wrapper, whose body stays
 * open until `release()`, then returns `outcome` (or throws it).
 */
function heldWrite(
  owner: string,
  name: string,
  outcome: () => McpToolResult | Error = OK,
  spec: { answers?: { annotationId: string; item: string } } = {},
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const answer = ownedWrite(
    { ownerId: owner },
    "tandem_edit",
    {
      given: docId(name),
      resolve: () => ({ open: true, documentId: docId(name), defaulted: false }),
      ...(spec.answers ? { answers: () => spec.answers ?? null } : {}),
    },
    async () => {
      entered = true;
      await gate;
      const result = outcome();
      if (result instanceof Error) throw result;
      return result;
    },
  );
  // A rejection is asserted by the test that expects it; never unhandled.
  answer.catch(() => {});
  return { answer, release, entered: () => entered };
}

/** Everything the ownership module holds, with each record's grace timer by identity. */
function state() {
  const snap = ownershipSnapshotForTests();
  return {
    ...snap,
    records: snap.records.map(({ graceTimer: _timer, ...rest }) => rest),
    graceTimers: snap.records.map((r) => r.graceTimer),
  };
}

function expectUnchanged(before: ReturnType<typeof state>): void {
  const after = state();
  const { graceTimers: timersAfter, ...restAfter } = after;
  const { graceTimers: timersBefore, ...restBefore } = before;
  expect(restAfter).toEqual(restBefore);
  // The very timers: a grace that was re-armed is a new timer object.
  expect(timersAfter.length).toBe(timersBefore.length);
  timersAfter.forEach((timer, i) => {
    expect(timer).toBe(timersBefore[i]);
  });
}

const holds = (owner: string, name: string) => getDocOwner(docId(name))?.ownerId === owner;

beforeEach(async () => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  run++;
  prefix = `outcome${run}`;
  callingAs = A;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  view = [];
  setTransportView(() => view);
  register(A);
  register(B);
  steps = [];
  seqReads = 0;
  setCompositeObserverForTests((step: CompositeStep, documentId: string) => {
    steps.push(`${step}:${documentId}`);
  });
  setOwnershipSeqSource(() => {
    seqReads++;
    return 0;
  });
  // Tandem mode: a user reply written during Solo is not an item Claude can answer.
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, "tandem"));
  ({ client, close } = await setupMcpServer([registerDocumentTools, registerAnnotationTools], {
    dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }),
  }));
});

afterEach(async () => {
  await close?.();
  close = undefined;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  resetOwnershipForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("a write that ends in a never-claims refusal or a throw leaves no trace (R1.1)", () => {
  /**
   * The writer is detached with a grace running, because the claim 1c made
   * re-armed that grace and its reversal never put it back: the snapshot
   * compares the timer by identity.
   */
  async function untouched(call: () => Promise<unknown>): Promise<void> {
    detach(A);
    expect(getOwnerRecord(A)?.graceTimer).toBeDefined();
    const waiting = vi.fn(() => true);
    setWaitingProbe(waiting);
    steps = [];
    seqReads = 0;
    const before = state();

    await call();

    expectUnchanged(before);
    expect(steps, "a step of the ownership-change composite ran").toEqual([]);
    expect(seqReads, "the sequence source was read").toBe(0);
    expect(waiting).not.toHaveBeenCalled();
    expect(ownershipSnapshotForTests().pendingClaims).toBe(0);
    expect(isDocOpQueueBusy(docId("d"))).toBe(false);
  }

  it("a body that throws", async () => {
    setupDoc("d");
    await untouched(async () => {
      const write = heldWrite(A, "d", () => new Error("boom"));
      expect(write.entered()).toBe(true);
      write.release();
      await expect(write.answer).rejects.toThrow("boom");
    });
  });

  it("a body that returns a tool's own never-claims refusal", async () => {
    setupDoc("d");
    await untouched(async () => {
      const write = heldWrite(A, "d", () => noClaim(mcpError("INVALID_ARGUMENT", "no")));
      write.release();
      expect(parseResult(await write.answer)).toMatchObject({ code: "INVALID_ARGUMENT" });
    });
  });

  it("a real tool's argument refusal, answered inside the operation", async () => {
    setupDoc("d");
    await untouched(async () => {
      const body = await as(A, "tandem_edit", {
        from: 3,
        to: 3,
        newText: "x",
        textSnapshot: "Hel",
        documentId: docId("d"),
      });
      expect(body.code).toBe("INVALID_ARGUMENT");
    });
  });

  it("a refusal by the annotation lifecycle", async () => {
    const ydoc = setupDoc("d");
    seed(ydoc, "user-comment", { author: "user" });
    seed(ydoc, "done", { status: "dismissed" });
    await untouched(async () => {
      const notOwned = await as(A, "tandem_editAnnotation", {
        id: "user-comment",
        content: "x",
        documentId: docId("d"),
      });
      expect(notOwned.code).toBe("NOT_OWNED");
      const resolved = await as(A, "tandem_annotationReply", {
        annotationId: "done",
        text: "r",
        documentId: docId("d"),
      });
      expect(resolved.code).toBe("ANNOTATION_RESOLVED");
    });
  });

  it("control: the same writer's successful write does change the state these compare", async () => {
    setupDoc("d");
    detach(A);
    const before = state();
    steps = [];
    expect(
      (await as(A, "tandem_comment", { from: 0, to: 5, text: "c", documentId: docId("d") })).error,
    ).toBe(false);
    expect(holds(A, "d")).toBe(true);
    expect(steps).toEqual(
      ["loss", "entry", "notices", "publish", "wake"].map((s) => `${s}:${docId("d")}`),
    );
    expect(seqReads).toBe(1);
    // The grace was armed again for a detached holder: a new timer.
    expect(state().graceTimers).not.toEqual(before.graceTimers);
  });

  it("a claim over another record's entry reaches the handover step, a claim of an unowned document does not", () => {
    // What "no step ran" would look like for a reversal, had one still existed:
    // an owner going away is the change PR 2b's handover runs on.
    setDocOwner(docId("x"), { ownerId: A, kind: "claimed" }, "claim");
    steps = [];
    setDocOwner(docId("x"), null, "lapse");
    expect(steps[0]).toBe(`handover:${docId("x")}`);
  });
});

describe("while the body runs, readers outside the queue see the document as unowned (R1.2)", () => {
  it("each of the four readers: unowned during the body, held after a successful one", async () => {
    setupDoc("d");
    setupDoc("other");
    setDocOwner(docId("other"), { ownerId: B, kind: "opened" }, "take");
    const a = { ownerId: A };
    const b = { ownerId: B };
    const write = heldWrite(A, "d");
    expect(write.entered()).toBe(true);

    // 1. `tandem_switchDocument` by another record: not refused.
    expect(switchRefusal(b, "tandem_switchDocument", docId("d"))).toBeNull();
    // 2. The write-mode `tandem_status` focus check by another record.
    expect(focusHeldByAnother(b, docId("d"))).toBe(false);
    // 3. Read-mode `tandem_status`'s `holding`, for the writer itself.
    expect(callerOwnerInfo(a)?.holding).toEqual([]);
    // 4. The id-keyed tools' held candidates, for the writer itself.
    expect(heldAmong(a, [docId("d")])).toBeUndefined();
    // And the held list a refusal on ANOTHER document carries for the writer:
    // a write that names no document, refused on B's active one.
    setActiveDocId(docId("other"));
    const heldInRefusal = async () => {
      const refused = await as(A, "tandem_comment", { from: 0, to: 5, text: "c" });
      expect(refused.code).toBe("NOT_DOC_OWNER");
      return refused.details?.heldDocumentIds ?? [];
    };
    expect(await heldInRefusal()).toEqual([]);
    expect(getDocOwner(docId("d"))).toBeUndefined();
    expect(ownershipSnapshotForTests().pendingClaims).toBe(1);

    write.release();
    await write.answer;

    expect(getDocOwner(docId("d"))).toMatchObject({ ownerId: A, kind: "claimed" });
    expect(
      parseResult(switchRefusal(b, "tandem_switchDocument", docId("d")) as McpToolResult),
    ).toMatchObject({
      code: "NOT_DOC_OWNER",
      details: { reason: "switch" },
    });
    expect(focusHeldByAnother(b, docId("d"))).toBe(true);
    expect(callerOwnerInfo(a)?.holding).toEqual([docId("d")]);
    expect(heldAmong(a, [docId("d")])).toEqual([docId("d")]);
    expect(await heldInRefusal()).toEqual([docId("d")]);
    expect(ownershipSnapshotForTests().pendingClaims).toBe(0);
  });

  it("a real id-keyed call with an ambiguous id, made by the writer during its write, lists no held candidate", async () => {
    const one = setupDoc("d");
    const two = setupDoc("two");
    seed(one, "dup");
    seed(two, "dup");
    const write = heldWrite(A, "d");
    const during = await as(A, "tandem_resolveAnnotation", { id: "dup", action: "dismiss" });
    expect(during.error).toBe(true);
    expect(JSON.stringify(during)).not.toContain("heldDocumentIds");
    write.release();
    await write.answer;
    const after = await as(A, "tandem_resolveAnnotation", { id: "dup", action: "dismiss" });
    expect(after.details?.heldDocumentIds).toEqual([docId("d")]);
  });

  it("the inbox scope read: nobody may claim a document in the middle of a write", async () => {
    setupDoc("d");
    expect(inboxScopeOf(docId("d"), A)).toBe("may-claim");
    const write = heldWrite(A, "d");
    expect(inboxScopeOf(docId("d"), A)).toBe("neither");
    expect(inboxScopeOf(docId("d"), B)).toBe("neither");
    write.release();
    await write.answer;
    expect(inboxScopeOf(docId("d"), A)).toBe("holds");
    expect(inboxScopeOf(docId("d"), B)).toBe("neither");
  });
});

describe("inside the queue only the outcome is seen (R1.2, R1.4)", () => {
  it("a second write queued behind a successful first finds the claim in effect", async () => {
    setupDoc("d");
    const first = heldWrite(A, "d");
    const ownSecond = as(A, "tandem_comment", {
      from: 0,
      to: 5,
      text: "a",
      documentId: docId("d"),
    });
    await new Promise((r) => setTimeout(r, 15));
    const otherSecond = as(B, "tandem_comment", {
      from: 0,
      to: 5,
      text: "b",
      documentId: docId("d"),
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(getDocOwner(docId("d"))).toBeUndefined();
    const entryBefore = () => getDocOwner(docId("d"));

    first.release();
    await first.answer;
    const claimed = entryBefore();
    expect(claimed).toMatchObject({ ownerId: A, kind: "claimed" });
    expect((await ownSecond).error).toBe(false);
    const refused = await otherSecond;
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.details?.reason).toBe("claimed");
    // The holder's second write claimed nothing again: the very same entry.
    expect(getDocOwner(docId("d"))).toBe(claimed);
  });

  it("a claiming write that itself waited for its turn: the write queued behind it still finds the claim in effect", async () => {
    // The case that tells "applied inside the queued operation" from "applied
    // in a continuation of its promise". A write that starts on an idle queue
    // hides the difference (its promise is the operation's own); one that
    // waited is answered through a wrapper a hop later, after the next
    // entrant's turn is already queued. So: a blocker first, the claiming
    // write behind it, and another record's write directly behind that.
    setupDoc("d");
    let unblock!: () => void;
    const blocker = runDocOp(docId("d"), () => new Promise<void>((r) => (unblock = r)));
    const first = heldWrite(A, "d");
    expect(first.entered()).toBe(false);
    const behind = as(B, "tandem_comment", { from: 0, to: 5, text: "b", documentId: docId("d") });
    await new Promise((r) => setTimeout(r, 15));
    first.release();
    unblock();
    await blocker;
    await first.answer;
    const refused = await behind;
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.details?.reason).toBe("claimed");
    expect(holds(A, "d")).toBe(true);
  });

  it("a second record's write queued behind a refused first claims the document itself", async () => {
    setupDoc("d");
    const first = heldWrite(A, "d", () => noClaim(mcpError("INVALID_ARGUMENT", "no")));
    const second = as(B, "tandem_comment", { from: 0, to: 5, text: "b", documentId: docId("d") });
    await new Promise((r) => setTimeout(r, 15));
    first.release();
    await first.answer;
    expect((await second).error).toBe(false);
    expect(holds(B, "d")).toBe(true);
  });

  it("a take queued behind the write sees the claim: the writer is told it lost the document", async () => {
    setupDoc("d");
    const write = heldWrite(A, "d");
    const take = runDocOp(docId("d"), () => undefined).then(() => undefined);
    const open = ownedOpen({ ownerId: B }, "tandem_open", {
      predict: () => docId("d"),
      open: async () => ({ envelope: OK(), openedId: docId("d") }),
    });
    write.release();
    await write.answer;
    await take;
    expect(parseResult(await open)).toMatchObject({ error: false });
    expect(getDocOwner(docId("d"))).toMatchObject({ ownerId: B, kind: "opened" });
    expect(ownershipSnapshotForTests().losses).toEqual([
      [docId("d"), { ownerId: A, cause: "taken" }],
    ]);
  });

  it("a take queued behind a refused write takes an unowned document and records no loss", async () => {
    setupDoc("d");
    const write = heldWrite(A, "d", () => new Error("boom"));
    const open = ownedOpen({ ownerId: B }, "tandem_open", {
      predict: () => docId("d"),
      open: async () => ({ envelope: OK(), openedId: docId("d") }),
    });
    write.release();
    await expect(write.answer).rejects.toThrow("boom");
    await open;
    expect(getDocOwner(docId("d"))).toMatchObject({ ownerId: B, kind: "opened" });
    expect(ownershipSnapshotForTests().losses).toEqual([]);
  });

  it("the check is unchanged: another record's document is refused before the body, the holder writes as before", async () => {
    setupDoc("d");
    setDocOwner(docId("d"), { ownerId: B, kind: "opened" }, "take");
    const entry = getDocOwner(docId("d"));
    let ran = false;
    const refused = await ownedWrite(
      { ownerId: A },
      "tandem_edit",
      {
        given: docId("d"),
        resolve: () => ({ open: true, documentId: docId("d"), defaulted: false }),
      },
      async () => {
        ran = true;
        return OK();
      },
    );
    expect(parseResult(refused)).toMatchObject({
      code: "NOT_DOC_OWNER",
      details: { reason: "held" },
    });
    expect(ran).toBe(false);
    const held = heldWrite(B, "d");
    expect(ownershipSnapshotForTests().pendingClaims).toBe(0);
    held.release();
    await held.answer;
    expect(getDocOwner(docId("d"))).toBe(entry);
  });
});

describe("a write that keeps its claim: what is true at the outcome decides (R1.3)", () => {
  it("nothing happened meanwhile: the caller owns it, with the sequence number read at the outcome", async () => {
    setupDoc("d");
    let counter = 3;
    setOwnershipSeqSource(() => counter);
    const write = heldWrite(A, "d");
    counter = 8;
    write.release();
    await write.answer;
    expect(getDocOwner(docId("d"))).toMatchObject({ ownerId: A, kind: "claimed", sinceSeq: 8 });
  });

  it("a refusal decided by live content keeps the claim, as before", async () => {
    setupDoc("d");
    const body = await as(A, "tandem_comment", {
      from: 0,
      to: 5,
      text: "c",
      textSnapshot: "nothing like this is in the document",
      documentId: docId("d"),
    });
    expect(body.error).toBe(true);
    expect(body.code).not.toBe("NOT_DOC_OWNER");
    expect(getDocOwner(docId("d"))).toMatchObject({ ownerId: A, kind: "claimed" });
  });

  it("tandem_close by a registered record on an unowned document leaves no entry, and a reopen is not refused", async () => {
    setupDoc("d");
    const closed = await as(A, "tandem_close", { documentId: docId("d") });
    expect(closed.error).toBe(false);
    expect(getOpenDocs().has(docId("d"))).toBe(false);
    expect(getDocOwner(docId("d"))).toBeUndefined();
    expect(ownershipSnapshotForTests()).toMatchObject({
      ownerByDoc: [],
      losses: [],
      pendingClaims: 0,
    });

    setupDoc("d");
    const other = await as(B, "tandem_comment", {
      from: 0,
      to: 5,
      text: "b",
      documentId: docId("d"),
    });
    expect(other.error).toBe(false);
    expect(holds(B, "d")).toBe(true);
  });

  it("a tab close that lands during the body: no entry", async () => {
    setupDoc("d");
    const write = heldWrite(A, "d");
    await closeDocumentById(docId("d"));
    expect(ownershipSnapshotForTests().pendingClaims).toBe(0);
    write.release();
    await write.answer;
    expect(getDocOwner(docId("d"))).toBeUndefined();
  });

  it("a close and a reopen during the body: still no entry (reopening starts from the default rule)", async () => {
    setupDoc("d");
    const write = heldWrite(A, "d");
    await closeDocumentById(docId("d"));
    setupDoc("d");
    write.release();
    await write.answer;
    // Open again and unowned at the outcome, yet not claimed: the close
    // cancelled the claim. A rule that only asked "is it open now?" fails here.
    expect(getOpenDocs().has(docId("d"))).toBe(true);
    expect(getDocOwner(docId("d"))).toBeUndefined();
  });

  it("a body that throws after its document closed leaves nothing behind", async () => {
    setupDoc("d");
    const write = heldWrite(A, "d", () => new Error("boom"));
    await closeDocumentById(docId("d"));
    write.release();
    await expect(write.answer).rejects.toThrow("boom");
    expect(ownershipSnapshotForTests()).toMatchObject({ ownerByDoc: [], pendingClaims: 0 });
  });

  it("an unqueued change gave the document an owner during the body: that entry stands", async () => {
    setupDoc("d");
    const write = heldWrite(A, "d");
    // The user-open default (unqueued) once Tandem's Claude can be present.
    setTandemPresenceSource(() => true);
    setDocOwner(docId("d"), { ownerId: TANDEM_OWNER_ID, kind: "default" }, "user-open");
    const entry = getDocOwner(docId("d"));
    write.release();
    await write.answer;
    expect(getDocOwner(docId("d"))).toBe(entry);
  });

  it("the writer's record lapsed during the body but still exists: it gets the entry and its grace is armed again", async () => {
    setupDoc("d");
    const write = heldWrite(A, "d");
    lapseNow(A);
    expect(getOwnerRecord(A)).toMatchObject({ lapsed: true });
    expect(getOwnerRecord(A)?.graceTimer).toBeUndefined();
    write.release();
    await write.answer;
    expect(getDocOwner(docId("d"))).toMatchObject({ ownerId: A, kind: "claimed" });
    expect(getOwnerRecord(A)?.graceTimer).toBeDefined();
  });

  it("the writer's record was deleted during the body: no entry", async () => {
    setupDoc("d");
    const write = heldWrite(A, "d");
    lapseNow(A, { gone: true });
    expect(getOwnerRecord(A)).toBeUndefined();
    write.release();
    expect(parseResult(await write.answer)).toMatchObject({ error: false });
    expect(getDocOwner(docId("d"))).toBeUndefined();
    expect(ownershipSnapshotForTests()).toMatchObject({ ownerByDoc: [], pendingClaims: 0 });
  });

  it("the writer's record was deleted and its identity registered again: the new record gets the entry", async () => {
    setupDoc("d");
    const write = heldWrite(A, "d");
    const label = getOwnerRecord(A)?.label;
    lapseNow(A, { gone: true });
    register(A);
    expect(getOwnerRecord(A)?.label).not.toBe(label);
    write.release();
    await write.answer;
    expect(holds(A, "d")).toBe(true);
  });

  it("Tandem's Claude stopped being present during the body: no entry", async () => {
    setupDoc("d");
    let present = true;
    setTandemPresenceSource(() => present);
    const write = heldWrite(TANDEM_OWNER_ID, "d");
    expect(write.entered()).toBe(true);
    present = false;
    write.release();
    await write.answer;
    expect(getDocOwner(docId("d"))).toBeUndefined();
  });

  it("Tandem's Claude, present throughout, holds it as `default`", async () => {
    setupDoc("d");
    setTandemPresenceSource(() => true);
    const write = heldWrite(TANDEM_OWNER_ID, "d");
    write.release();
    await write.answer;
    expect(getDocOwner(docId("d"))).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
  });
});

describe("applying the claim can never fail the call (R1.3a)", () => {
  it("the claim cannot be written: the write's own result is returned, and the failure is logged", async () => {
    const ydoc = setupDoc("d");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    setOwnershipSeqSource(() => {
      throw new Error("the registry is gone");
    });
    const body = await as(A, "tandem_comment", {
      from: 0,
      to: 5,
      text: "c",
      documentId: docId("d"),
    });
    expect(body.error).toBe(false);
    expect(ydoc.getMap(Y_MAP_ANNOTATIONS).size).toBe(1);
    expect(getDocOwner(docId("d"))).toBeUndefined();
    const lines = logged.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("its claim of the document could not be applied"))).toBe(
      true,
    );
    // No line names a record: an owner id can be a bearer session id.
    expect(lines.join("\n")).not.toContain("outcome-a");
    expect(ownershipSnapshotForTests()).toMatchObject({ losses: [], pendingClaims: 0 });
    // The document is simply unowned: the next record's write claims it.
    setOwnershipSeqSource(() => 0);
    expect(
      (await as(B, "tandem_comment", { from: 0, to: 5, text: "b", documentId: docId("d") })).error,
    ).toBe(false);
    expect(holds(B, "d")).toBe(true);
  });

  it("a sequence source that throws does not stop an entry being removed", () => {
    setDocOwner(docId("x"), { ownerId: A, kind: "claimed" }, "claim");
    setOwnershipSeqSource(() => {
      throw new Error("the registry is gone");
    });
    setDocOwner(docId("x"), null, "lapse");
    expect(getDocOwner(docId("x"))).toBeUndefined();
  });

  it("a failure after the body, outside the claim itself, still returns the write's result", async () => {
    setupDoc("d");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = OK();
    // `hasDoc` is read after the body; make the registry read throw then.
    const docs = getOpenDocs();
    const write = heldWrite(A, "d", () => {
      vi.spyOn(docs, "has").mockImplementation(() => {
        throw new Error("registry read failed");
      });
      return result;
    });
    write.release();
    const answered = await write.answer;
    vi.restoreAllMocks();
    expect(answered).toBe(result);
    expect(ownershipSnapshotForTests().pendingClaims).toBe(0);
    expect(getDocOwner(docId("d"))).toBeUndefined();
    expect(
      logged.mock.calls.some((c) =>
        String(c[0]).includes("recording its ownership outcome failed"),
      ),
    ).toBe(true);
  });
});

describe("answered-once does not depend on the claim (R1.3b)", () => {
  const ITEM = { annotationId: "ann", item: "reply-1" };
  const answeredByA = () => otherAnswererOf(docId("d"), "ann", "reply-1", B);

  it("a successful thread reply on a document that closed during the body still records its answerer", async () => {
    setupDoc("d");
    const write = heldWrite(A, "d", OK, { answers: ITEM });
    await closeDocumentById(docId("d"));
    write.release();
    await write.answer;
    expect(getDocOwner(docId("d"))).toBeUndefined();
    expect(answeredByA()).toBeDefined();
  });

  it("…and when the writer's record was deleted during the body", async () => {
    setupDoc("d");
    const write = heldWrite(A, "d", OK, { answers: ITEM });
    lapseNow(A, { gone: true });
    write.release();
    await write.answer;
    expect(getDocOwner(docId("d"))).toBeUndefined();
    // The answerer's record is gone, so it is named only as another session.
    expect(answeredByA()).toEqual({ holder: null });
  });

  it("…and when the claim could not be applied: the next record is refused `answered`, through the real tool", async () => {
    const ydoc = setupDoc("d");
    seed(ydoc, "ann");
    expect(addUserReply(ydoc, "ann", "what about this?", () => {}).kind).toBe("ok");
    vi.spyOn(console, "error").mockImplementation(() => {});
    setOwnershipSeqSource(() => {
      throw new Error("the registry is gone");
    });
    const reply = { annotationId: "ann", text: "answer", documentId: docId("d") };
    expect((await as(A, "tandem_annotationReply", reply)).error).toBe(false);
    expect(getDocOwner(docId("d"))).toBeUndefined();
    expect(ownershipSnapshotForTests().answerers).toBe(1);
    const second = await as(B, "tandem_annotationReply", reply);
    expect(second.code).toBe("NOT_DOC_OWNER");
    expect(second.details?.reason).toBe("answered");
  });

  it("a never-claims refusal and a throw record no answerer", async () => {
    setupDoc("d");
    const refused = heldWrite(A, "d", () => noClaim(mcpError("ANNOTATION_RESOLVED", "no")), {
      answers: ITEM,
    });
    refused.release();
    await refused.answer;
    const threw = heldWrite(A, "d", () => new Error("boom"), { answers: ITEM });
    threw.release();
    await expect(threw.answer).rejects.toThrow("boom");
    expect(ownershipSnapshotForTests().answerers).toBe(0);
  });
});

describe("state the inbox work will rely on (Requirement 2)", () => {
  it("R2.1: a document's handover mark outlives a close, an unowned spell and a reopen", async () => {
    setupDoc("d");
    setDocOwner(docId("d"), { ownerId: A, kind: "opened" }, "take");
    // Written by the test-only setter: PR 2b's handover is the production writer.
    setHandoverSeqForTests(docId("d"), 41);
    setDocOwner(docId("d"), null, "lapse");
    await closeDocumentById(docId("d"));
    setupDoc("d");
    expect(ownershipSnapshotForTests().handoverSeq).toEqual([[docId("d"), 41]]);
    expect(ownershipSnapshotForTests().ownerByDoc).toEqual([]);
  });

  it("R2.2: a write's claim reads the delivery registry's counter when it takes effect; a passed value overrides the source", async () => {
    setupDoc("d");
    // The production wiring (`src/server/index.ts`), made here by hand.
    setOwnershipSeqSource(() => deliveryRegistry.counter);
    try {
      const write = heldWrite(A, "d");
      // Items are registered while the write is in flight.
      deliveryRegistry.assign("a", docId("d"), "k1", 0);
      deliveryRegistry.assign("a", docId("d"), "k2", 0);
      const atOutcome = deliveryRegistry.counter;
      expect(atOutcome).toBeGreaterThanOrEqual(2);
      write.release();
      await write.answer;
      expect(getDocOwner(docId("d"))?.sinceSeq).toBe(atOutcome);

      // A claim made by an inbox poll (PR 2b) passes the counter before its pass.
      setDocOwner(docId("polled"), { ownerId: B, kind: "claimed" }, "claim", B, atOutcome - 2);
      expect(getDocOwner(docId("polled"))?.sinceSeq).toBe(atOutcome - 2);
    } finally {
      deliveryRegistry.reset();
    }
  });

  it("R2.3: a reader treats an entry whose record is gone as unowned and writes nothing", () => {
    setupDoc("d");
    // Fabricated: no path writes an entry for a record that does not exist.
    setDocOwner(docId("d"), { ownerId: "claude:ghost", kind: "opened" }, "take");
    const stale = getDocOwner(docId("d"));
    steps = [];

    expect(otherHolderOf(docId("d"), B)).toBeNull();
    expect(switchRefusal({ ownerId: B }, "tandem_switchDocument", docId("d"))).toBeNull();
    expect(focusHeldByAnother({ ownerId: B }, docId("d"))).toBe(false);
    expect(inboxScopeOf(docId("d"), B)).toBe("may-claim");
    // A caller whose own id is on a stale entry (it has no record) holds nothing.
    expect(inboxScopeOf(docId("d"), "claude:ghost")).toBe("neither");

    expect(getDocOwner(docId("d"))).toBe(stale);
    expect(steps).toEqual([]);
  });

  describe("R2.4: the inbox scope read (ownership design §6.2)", () => {
    it("holds, may claim, neither", () => {
      setupDoc("mine");
      setupDoc("theirs");
      setupDoc("free");
      setDocOwner(docId("mine"), { ownerId: A, kind: "claimed" }, "claim");
      setDocOwner(docId("theirs"), { ownerId: B, kind: "opened" }, "take");
      steps = [];
      const before = state();

      expect(inboxScopeOf(docId("mine"), A)).toBe("holds");
      expect(inboxScopeOf(docId("theirs"), A)).toBe("neither");
      expect(inboxScopeOf(docId("free"), A)).toBe("may-claim");
      // The tool-side form, which is what PR 2b's inbox code may call.
      expect(inboxScope({ ownerId: A }, docId("mine"))).toBe("holds");
      expect(inboxScope({ ownerId: A }, docId("free"))).toBe("may-claim");
      expect(inboxScope({}, docId("free"))).toBe("neither");

      // Pure: it changed nothing and ran no step.
      expectUnchanged(before);
      expect(steps).toEqual([]);
    });

    it("a caller with no owner id, or no owner record, is in scope for nothing (provisional)", () => {
      setupDoc("free");
      expect(inboxScopeOf(docId("free"), undefined)).toBe("neither");
      expect(inboxScopeOf(docId("free"), "test:caller")).toBe("neither");
      expect(inboxScopeOf(docId("free"), C)).toBe("neither");
      register(C);
      expect(inboxScopeOf(docId("free"), C)).toBe("may-claim");
    });

    it("a blocking loss record: the loser may not claim, anyone else may", () => {
      setupDoc("d");
      setDocOwner(docId("d"), { ownerId: A, kind: "claimed" }, "claim");
      setDocOwner(docId("d"), { ownerId: B, kind: "opened" }, "take");
      expect(ownershipSnapshotForTests().losses).toEqual([
        [docId("d"), { ownerId: A, cause: "taken" }],
      ]);
      expect(inboxScopeOf(docId("d"), A)).toBe("neither");
      expect(inboxScopeOf(docId("d"), B)).toBe("holds");
    });

    it("Tandem's Claude: nothing while not present, a claim while present (both branches of the presence seam)", () => {
      setupDoc("free");
      setTandemPresenceSource(() => false);
      expect(inboxScopeOf(docId("free"), TANDEM_OWNER_ID)).toBe("neither");
      setTandemPresenceSource(() => true);
      expect(inboxScopeOf(docId("free"), TANDEM_OWNER_ID)).toBe("may-claim");
      setDocOwner(docId("free"), { ownerId: TANDEM_OWNER_ID, kind: "default" }, "user-open");
      expect(inboxScopeOf(docId("free"), TANDEM_OWNER_ID)).toBe("holds");
      expect(inboxScopeOf(docId("free"), A)).toBe("neither");
    });

    it("only while the document's queue is idle: any operation in flight means nobody may claim", async () => {
      setupDoc("free");
      setupDoc("mine");
      setDocOwner(docId("mine"), { ownerId: A, kind: "claimed" }, "claim");
      let release!: () => void;
      const inFlight = runDocOp(docId("free"), () => new Promise<void>((r) => (release = r)));
      const held = runDocOp(docId("mine"), () => undefined);
      expect(inboxScopeOf(docId("free"), A)).toBe("neither");
      // Holding is not a claim: a busy queue does not hide the holder's own document.
      expect(inboxScopeOf(docId("mine"), A)).toBe("holds");
      release();
      await inFlight;
      await held;
      expect(inboxScopeOf(docId("free"), A)).toBe("may-claim");
    });
  });
});
