/**
 * The notice rule (#2358, ADR-054's notice-rule amendment; ownership design
 * §6.3 step 2 and §6.4's last bullet, as the notice-rule PR's brief rules).
 *
 * An accept or dismiss notice about a Claude-authored annotation that was
 * handed to a holder of its document is **settled** once the document's
 * ownership leaves that holder: it is handed to nobody again — not the next
 * holder, not a later one, not the old one, with any cursor or none, on this
 * poll or any later one, across a close and reopen. A notice that was never
 * handed to a holder (pushed only, held back from its first poll on, created
 * while the document was unowned) goes to the next holder.
 *
 * Everything goes through the real `tandem_checkInbox` tool, with registered
 * records each holding its own cursor, and both production seams wired as
 * `src/server/index.ts` wires them (the sequence source and the inbox
 * handover). **Every "is not handed" assertion checks two consecutive polls
 * of that reader**, the second with the cursor the first returned
 * (`neverHanded`): a mechanism that only filtered the notice out of one
 * response would let the registry retire its entry, and the next poll would
 * hand it again under a new sequence number.
 *
 * Platform: in-memory fixtures with synthetic paths (the tab close goes
 * through the real `POST /api/close` handler, which touches no file for a
 * fixture); nothing is gated.
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
import { deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  checkInboxOutputShape,
  checkInboxOwnershipShape,
} from "../../src/server/mcp/output-schemas.js";
import { handleClose } from "../../src/server/mcp/routes/close.js";
import {
  getDocOwner,
  inboxOwnership,
  inboxScopeOf as inboxScopeOfReal,
  noteTransportChanged,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setHandoverSeqForTests,
  setInboxClaimCheckForTests,
  setInboxScopeReadForTests,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setTransportView,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { NOT_YOURS_FIELD_DESCRIPTION } from "../../src/server/sessions/ownership-refusal.js";
import { getDocument, getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { makeRes } from "../helpers/route-recorder.js";

const A = "claude:notice-a";
const B = "claude:notice-b";
/** A registered record holding nothing. */
const C = "claude:notice-c";

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

function openFixture(id: string): Doc {
  const ydoc = getOrCreateDocument(id);
  if (ydoc.getXmlFragment("default").length === 0) {
    populateYDoc(ydoc, "Hello world, this is a test document.");
  }
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

/** A Claude suggestion the user has resolved: the notice. */
const notice = (ydoc: Y.Doc, id: string, status: "accepted" | "dismissed" = "accepted") =>
  annotation(ydoc, id, { author: "claude", status });

/** Rewrite fields of a stored annotation, as a raw map write. */
function patch(ydoc: Y.Doc, id: string, fields: Record<string, unknown>): void {
  withInternal(ydoc, () => {
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    map.set(id, { ...(map.get(id) as Record<string, unknown>), ...fields });
  });
}

async function pollAs(owner: string, args: Record<string, unknown> = {}): Promise<Inbox> {
  callingAs = owner;
  const result = await client.callTool({ name: "tandem_checkInbox", arguments: args });
  expect(parseResult(result).error, JSON.stringify(result)).toBe(false);
  return inboxSchema.parse((result as { structuredContent: unknown }).structuredContent);
}

interface Reader {
  poll(): Promise<Inbox>;
  readonly cursor: string;
}

/** A cursor reader: each poll passes back the cursor its last poll returned. */
function reader(owner: string, start = "start"): Reader {
  let cursor = start;
  return {
    async poll() {
      const inbox = await pollAs(owner, { cursor });
      cursor = inbox.cursor;
      return inbox;
    },
    get cursor() {
      return cursor;
    },
  };
}

/** A cursor-less (legacy) reader. */
function legacy(owner: string): Reader {
  return { poll: () => pollAs(owner), cursor: "" };
}

const responseIds = (inbox: Inbox) => inbox.userResponses.map((r) => r.id).sort();
const ownerOf = (id: string) => getDocOwner(id)?.ownerId;
const markOf = (id: string) => new Map(ownershipSnapshotForTests().handoverSeq).get(id);

/** Two consecutive polls of `r`; neither is handed `id`. */
async function neverHanded(r: Reader, id: string, why: string): Promise<void> {
  for (const n of [1, 2]) {
    expect(responseIds(await r.poll()), `${why}, poll ${n}`).not.toContain(id);
  }
}

/** `r` is handed `id` on its next poll, and not on the one after it. */
async function handedOnce(r: Reader, id: string, why: string): Promise<void> {
  expect(responseIds(await r.poll()), `${why}, first poll`).toContain(id);
  expect(responseIds(await r.poll()), `${why}, the poll after`).not.toContain(id);
}

const take = (id: string, owner: string) =>
  setDocOwner(id, { ownerId: owner, kind: "opened" }, "take", owner);

async function closeByRoute(id: string): Promise<void> {
  const res = makeRes();
  await handleClose(
    { body: { documentId: id }, socket: { remoteAddress: "127.0.0.1" }, headers: {} } as never,
    res as never,
  );
  expect(res._status, JSON.stringify(res._body)).toBe(200);
}

/**
 * Close through the real route and open again. A fixture has no durable
 * envelope, so if the close dropped the Y.Doc its records are written back as
 * they were (same ids, same `editedAt`): what a real reopen's merge gives
 * when the envelope and the session agree (see the PR on R1.6).
 */
async function closeAndReopen(doc: Doc): Promise<Doc> {
  const records = doc.ydoc.getMap(Y_MAP_ANNOTATIONS).toJSON() as Record<string, unknown>;
  await closeByRoute(doc.id);
  expect(getOpenDocs().has(doc.id)).toBe(false);
  const had = getDocument(doc.id);
  const reopened = openFixture(doc.id);
  if (!had) {
    withInternal(reopened.ydoc, () => {
      for (const [k, v] of Object.entries(records)) {
        reopened.ydoc.getMap(Y_MAP_ANNOTATIONS).set(k, v);
      }
    });
  }
  return reopened;
}

async function buildWorld(flag: "1" | "" = "1"): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `notice${run}`;
  callingAs = A;
  resetInbox();
  resetOwnershipForTests();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  view = [];
  setTransportView(() => view);
  register(A);
  register(B);
  register(C);
  // The two lines of `src/server/index.ts`.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setCtrlMode("tandem");
  // An active document none of the tests' own, so theirs are background ones.
  const front = mkDoc("front");
  setActiveDocId(front.id);
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
  setInboxScopeReadForTests(undefined);
  setInboxClaimCheckForTests(undefined);
  setInboxResponseCorruptorForTests(undefined);
  for (const [id] of [...getOpenDocs()]) removeDoc(id);
  resetOwnershipForTests();
  resetInbox();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

/**
 * A holds D and is handed the notice `n`, three ways: acknowledging it,
 * never acknowledging it, and with A's first poll being the one that claimed
 * D. B then takes D.
 */
type Setup = "acknowledged" | "unacknowledged" | "claimed by that poll";
const SETUPS: Setup[] = ["acknowledged", "unacknowledged", "claimed by that poll"];

async function handedToA(setup: Setup): Promise<{ doc: Doc; a: Reader }> {
  const doc = mkDoc("d");
  if (setup !== "claimed by that poll") take(doc.id, A);
  notice(doc.ydoc, "n");
  const a = reader(A);
  expect(responseIds(await a.poll())).toEqual(["n"]);
  expect(ownerOf(doc.id)).toBe(A);
  if (setup === "acknowledged") expect(responseIds(await a.poll())).toEqual([]);
  return { doc, a };
}

describe("R1.1: a settled notice goes to nobody", () => {
  describe.each(SETUPS)("A was handed it (%s); B takes D", (setup) => {
    it("B with a fresh cursor", async () => {
      const { doc } = await handedToA(setup);
      take(doc.id, B);
      await neverHanded(reader(B), "n", "B fresh");
    });

    it("B with a cursor from before the take", async () => {
      const b = reader(B);
      await b.poll();
      const { doc } = await handedToA(setup);
      await b.poll(); // D is A's: B's mark passes it by exclusion
      take(doc.id, B);
      await neverHanded(b, "n", "B's old cursor");
    });

    it("B cursor-less", async () => {
      const { doc } = await handedToA(setup);
      take(doc.id, B);
      await neverHanded(legacy(B), "n", "B cursor-less");
    });

    it("A, after A takes D back: its old cursor, a fresh one and cursor-less", async () => {
      const { doc, a } = await handedToA(setup);
      take(doc.id, B);
      await reader(B).poll();
      take(doc.id, A);
      await neverHanded(a, "n", "A's old cursor");
      await neverHanded(reader(A), "n", "A fresh");
      await neverHanded(legacy(A), "n", "A cursor-less");
    });

    it("a fresh cursor as B after a close and reopen", async () => {
      const { doc } = await handedToA(setup);
      take(doc.id, B);
      const reopened = await closeAndReopen(doc);
      take(reopened.id, B);
      await neverHanded(reader(B), "n", "B fresh after the reopen");
      await neverHanded(legacy(B), "n", "B cursor-less after the reopen");
    });

    it("an unowned D is not claimed for it (R1.5), holding exact", async () => {
      const { doc } = await handedToA(setup);
      setDocOwner(doc.id, null, "lapse");
      const c = reader(C);
      for (const n of [1, 2]) {
        const inbox = await c.poll();
        expect(responseIds(inbox), `poll ${n}`).toEqual([]);
        expect(ownerOf(doc.id)).toBeUndefined();
        expect(inbox.ownership?.holding).toEqual([]);
      }
    });
  });
});

describe("R1.2: an unsettled notice is not lost", () => {
  it("a notice only pushed (A never polled): B takes D and is handed it exactly once", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    take(doc.id, B);
    await handedOnce(reader(B), "n", "B fresh");
  });

  it("a notice created while D was unowned goes to whoever claims D", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    setDocOwner(doc.id, null, "lapse");
    notice(doc.ydoc, "n");
    await handedOnce(legacy(B), "n", "B cursor-less");
    expect(ownerOf(doc.id)).toBe(B);
  });

  // The notice-loss probe from #2416's review. It also passes on master.
  describe.each(["B lapses", "A takes D"] as const)("the notice-loss probe: %s", (move) => {
    async function probe(): Promise<{ doc: Doc; a: Reader }> {
      const doc = mkDoc("d");
      take(doc.id, B);
      const a = reader(A);
      // A's default polls exclude D: A's mark moves past it.
      await a.poll();
      await a.poll();
      notice(doc.ydoc, "n");
      await a.poll();
      if (move === "B lapses") setDocOwner(doc.id, null, "lapse");
      else take(doc.id, A);
      return { doc, a };
    }

    it("A's next poll is handed the notice", async () => {
      const { a } = await probe();
      await handedOnce(a, "n", "A's moved cursor");
    });

    it("a fresh cursor polling as the new holder, before anyone acknowledged it", async () => {
      await probe();
      await handedOnce(reader(A), "n", "A fresh");
    });
  });

  describe.each([
    {
      hold: "an admit refusal",
      on: (d: Doc) => patch(d.ydoc, "n", { content: 42 }),
      off: (d: Doc) => patch(d.ydoc, "n", { content: "text of n" }),
    },
    {
      hold: "a client-written heldInSolo stamp in indeterminate mode",
      on: (d: Doc) => {
        patch(d.ydoc, "n", { heldInSolo: true });
        setCtrlMode(null);
      },
      off: () => setCtrlMode("tandem"),
    },
  ])("a notice held back by $hold", ({ on, off }) => {
    it("never handed to B (held from its first poll on): after a handover to A and the end of the hold, A is handed it", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const doc = mkDoc("d");
      take(doc.id, B);
      notice(doc.ydoc, "n");
      on(doc);
      const b = reader(B);
      const a = reader(A);
      expect(responseIds(await b.poll())).toEqual([]);
      await a.poll(); // excludes D
      expect(responseIds(await b.poll())).toEqual([]);
      await a.poll();
      take(doc.id, A);
      expect(responseIds(await a.poll()), "still held").toEqual([]);
      off(doc);
      await handedOnce(a, "n", "A after the hold ends");
    });

    it("the settled twin: B was handed it before the hold; after the handover and the end of the hold, A is not", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const doc = mkDoc("d");
      take(doc.id, B);
      notice(doc.ydoc, "n");
      const b = reader(B);
      const a = reader(A);
      expect(responseIds(await b.poll())).toEqual(["n"]);
      on(doc);
      await b.poll();
      await a.poll();
      take(doc.id, A);
      expect(responseIds(await a.poll())).toEqual([]);
      off(doc);
      await neverHanded(a, "n", "A after the hold ends");
      await neverHanded(reader(A), "n", "A fresh");
    });
  });
});

describe("R1.3: the holder's own retry", () => {
  it("while A holds D without a break its retry is handed the notice again; after A loses D and takes it back, it is not", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    const before = reader(A).cursor;
    expect(responseIds(await pollAs(A, { cursor: before }))).toEqual(["n"]);
    // The response was lost: A retries with the same cursor, twice.
    expect(responseIds(await pollAs(A, { cursor: before }))).toEqual(["n"]);
    expect(responseIds(await pollAs(A, { cursor: before }))).toEqual(["n"]);

    take(doc.id, B);
    take(doc.id, A);
    await neverHanded(reader(A, before), "n", "A's retry after the leave");
  });

  it("the claiming poll's own notices are the claimant's (R1.4): its retry is handed them", async () => {
    const doc = mkDoc("d");
    notice(doc.ydoc, "n");
    expect(responseIds(await pollAs(A, { cursor: "start" }))).toEqual(["n"]);
    expect(ownerOf(doc.id)).toBe(A);
    expect(responseIds(await pollAs(A, { cursor: "start" }))).toEqual(["n"]);
  });
});

describe("R1.3a: a decision changed after the leave", () => {
  it("observed changes are handed: B is handed 'dismissed', then 'accepted' again", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    expect(responseIds(await reader(A).poll())).toEqual(["n"]);
    take(doc.id, B);
    const b = reader(B);
    expect(responseIds(await b.poll())).toEqual([]);
    patch(doc.ydoc, "n", { status: "dismissed" });
    const dismissed = await b.poll();
    expect(dismissed.userResponses.map((r) => [r.id, r.status])).toEqual([["n", "dismissed"]]);
    patch(doc.ydoc, "n", { status: "accepted" });
    const accepted = await b.poll();
    expect(accepted.userResponses.map((r) => [r.id, r.status])).toEqual([["n", "accepted"]]);
    expect(responseIds(await b.poll())).toEqual([]);
  });

  it("the same for a cursor-less holder", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    expect(responseIds(await legacy(A).poll())).toEqual(["n"]);
    take(doc.id, B);
    expect(responseIds(await pollAs(B))).toEqual([]);
    patch(doc.ydoc, "n", { status: "dismissed" });
    expect(responseIds(await pollAs(B))).toEqual(["n"]);
    patch(doc.ydoc, "n", { status: "accepted" });
    expect(responseIds(await pollAs(B))).toEqual(["n"]);
    expect(responseIds(await pollAs(B))).toEqual([]);
  });

  it("a new version of a settled notice is handed once, not on the poll after (cursor-less and cursor holders)", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    expect(responseIds(await reader(A).poll())).toEqual(["n"]);
    take(doc.id, B);
    const b = reader(B);
    expect(responseIds(await pollAs(B))).toEqual([]);
    expect(responseIds(await b.poll())).toEqual([]);
    patch(doc.ydoc, "n", { editedAt: 5000 }); // the same status, a new version
    await handedOnce(legacy(B), "n", "B cursor-less");
    await handedOnce(b, "n", "B's cursor");
  });

  it("an unobserved round trip is the same notice: no poll of B in between, and B is handed nothing", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    expect(responseIds(await reader(A).poll())).toEqual(["n"]);
    take(doc.id, B);
    const b = reader(B);
    expect(responseIds(await b.poll())).toEqual([]);
    patch(doc.ydoc, "n", { status: "dismissed" });
    patch(doc.ydoc, "n", { status: "accepted" });
    await neverHanded(b, "n", "B after the unobserved round trip");
  });
});

describe("R1.3a: only a committed poll of the holder observes a change (plan review, finding 1)", () => {
  async function settledAccept(): Promise<Doc> {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    expect(responseIds(await reader(A).poll())).toEqual(["n"]);
    return doc;
  }

  it("a poll whose claim is refused sees the status away; the status comes back; the next holder is not handed it", async () => {
    const doc = await settledAccept();
    setDocOwner(doc.id, null, "lapse");
    patch(doc.ydoc, "n", { status: "dismissed" });
    setInboxClaimCheckForTests((check) => check !== "scope");
    expect(responseIds(await reader(C).poll()), "C is handed the dismissal").toEqual(["n"]);
    setInboxClaimCheckForTests(undefined);
    expect(ownerOf(doc.id)).toBeUndefined();
    patch(doc.ydoc, "n", { status: "accepted" });
    take(doc.id, B);
    await neverHanded(reader(B), "n", "B fresh");
    await neverHanded(legacy(B), "n", "B cursor-less");
  });

  it("the holder's poll that fails validation observes nothing", async () => {
    const doc = await settledAccept();
    take(doc.id, B);
    const b = reader(B);
    await b.poll();
    patch(doc.ydoc, "n", { status: "dismissed" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    setInboxResponseCorruptorForTests(() => ({ broken: true }));
    callingAs = B;
    const failed = parseResult(
      await client.callTool({ name: "tandem_checkInbox", arguments: { cursor: b.cursor } }),
    );
    expect(failed.error).toBe(true);
    setInboxResponseCorruptorForTests(undefined);
    patch(doc.ydoc, "n", { status: "accepted" });
    await neverHanded(b, "n", "B after the round trip its failed poll saw");
  });
});

describe("settled notices whose entry a pass could lose (plan review, findings 2–4)", () => {
  it("a deleted record stays settled: delete, poll, restore, and the next holder is not handed it", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    expect(responseIds(await reader(A).poll())).toEqual(["n"]); // never acknowledged
    take(doc.id, B);
    const stored = doc.ydoc.getMap(Y_MAP_ANNOTATIONS).get("n");
    withInternal(doc.ydoc, () => doc.ydoc.getMap(Y_MAP_ANNOTATIONS).delete("n"));
    const b = reader(B);
    await b.poll();
    await b.poll();
    withInternal(doc.ydoc, () => doc.ydoc.getMap(Y_MAP_ANNOTATIONS).set("n", stored));
    await neverHanded(b, "n", "B after the restore");
    await neverHanded(reader(B), "n", "B fresh after the restore");
    await neverHanded(legacy(B), "n", "B cursor-less after the restore");
  });

  it("a notice a cursor-less holder was handed whose entry a pass retired is settled at the handover", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    const old = reader(A);
    await old.poll(); // a mark below the notice's entry
    notice(doc.ydoc, "n");
    expect(responseIds(await pollAs(A))).toEqual(["n"]);
    patch(doc.ydoc, "n", { status: "pending" }); // the user's Undo
    await old.poll(); // retires the entry: its status moved
    expect(deliveryRegistry.lookup("a", `${doc.id}:n#accepted`, 0)).toBeUndefined();
    patch(doc.ydoc, "n", { status: "accepted" });
    expect(responseIds(await pollAs(A)), "master's known limit: the key repeats").toEqual([]);
    take(doc.id, B);
    await neverHanded(reader(B), "n", "B fresh");
    await neverHanded(legacy(B), "n", "B cursor-less");
  });

  it("a key that collides only after the handover: while it collides the notice may repeat once; afterwards it is settled again", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    expect(responseIds(await reader(A).poll())).toEqual(["n"]);
    take(doc.id, B);
    const b = reader(B);
    expect(responseIds(await b.poll())).toEqual([]);
    annotation(doc.ydoc, "n#accepted"); // a client-written user comment with the notice's key
    // While it collides the notice is not settled (when in doubt, re-owe).
    // Whether the comment itself is handed follows master's rule for a
    // colliding key (B's mark already passed the entry under that key), which
    // this PR does not change.
    await b.poll();
    withInternal(doc.ydoc, () => doc.ydoc.getMap(Y_MAP_ANNOTATIONS).delete("n#accepted"));
    await neverHanded(b, "n", "B once the collision is gone");
    await neverHanded(reader(B), "n", "B fresh once the collision is gone");
  });
});

describe("R1.6: the claim outcome `changed` (a re-entrant lapse of the claimant)", () => {
  /** Past 64 detached records, C's claim re-arms its grace and the cap lapses C. */
  function lapsingClaimant(): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    vi.setSystemTime(t0 + 1_000);
    for (let i = 0; i < 64; i++) {
      const id = `claude:notice-cap-${i}`;
      register(id);
      setDocOwner(`${prefix}-held-${i}`, { ownerId: id, kind: "opened" }, "take", id);
      const entry = view.find((e) => e.ownerId === id) as TransportViewEntry;
      entry.streamEver = true;
      noteTransportChanged(id);
    }
    vi.setSystemTime(t0);
    const c = view.find((e) => e.ownerId === C) as TransportViewEntry;
    c.streamEver = true;
    noteTransportChanged(C);
  }

  it.each(["a cursor reader", "a cursor-less reader"] as const)(
    "the claimant was handed the notice but never held D: %s as the next holder is handed it once",
    async (next) => {
      const doc = mkDoc("d");
      notice(doc.ydoc, "n");
      lapsingClaimant();
      // C cursor-less: its commit writes the notice key into the shared ledger.
      expect(responseIds(await pollAs(C))).toEqual(["n"]);
      vi.useRealTimers();
      expect(getDocOwner(doc.id)).toBeUndefined();
      expect(markOf(doc.id), "the lapse's handover ran").toBeGreaterThan(0);
      await handedOnce(next === "a cursor reader" ? reader(B) : legacy(B), "n", next);
      expect(ownerOf(doc.id)).toBe(B);
    },
  );
});

describe("R1.6: exceptions are one duplicate, not repeated", () => {
  it("a handover whose annotation read fails: B is handed the notice once", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    expect(responseIds(await reader(A).poll())).toEqual(["n"]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(YDocStore.prototype, "listAnnotations").mockImplementationOnce(() => {
      throw new Error("unreadable");
    });
    take(doc.id, B);
    await handedOnce(reader(B), "n", "B after a failed read");
  });

  it("a handover whose inbox half throws: the mark does not move, B is handed the notice once", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    expect(responseIds(await reader(A).poll())).toEqual(["n"]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setOwnershipInboxHandover(() => {
      throw new Error("boom");
    });
    take(doc.id, B);
    setOwnershipInboxHandover(handOverDocumentInbox);
    expect(markOf(doc.id)).toBeUndefined();
    await handedOnce(reader(B), "n", "B after a failed inbox half");
  });

  it("a key the handover forgets (a colliding record): B is handed the notice once", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    annotation(doc.ydoc, "n#accepted"); // a user comment with the notice's very key
    expect(responseIds(await reader(A).poll())).toEqual(["n"]);
    take(doc.id, B);
    await handedOnce(reader(B), "n", "B after the colliding key was forgotten");
  });

  it("a restart forgets the mark: the settled notice may be handed once more", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    expect(responseIds(await reader(A).poll())).toEqual(["n"]);
    take(doc.id, B);
    await neverHanded(reader(B), "n", "before the restart");
    // What a restart forgets: the registry and every ownership map.
    resetInbox();
    resetOwnershipForTests();
    register(B);
    take(doc.id, B);
    await handedOnce(reader(B), "n", "after the restart");
  });
});

describe("the five cases the scope PR left", () => {
  it("case 1: a close of an unowned document, then a reopen", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "settled");
    expect(responseIds(await reader(A).poll())).toEqual(["settled"]);
    setDocOwner(doc.id, null, "lapse");
    notice(doc.ydoc, "fresh", "dismissed"); // created while unowned, never handed
    const reopened = await closeAndReopen(doc);
    expect(getDocOwner(reopened.id)).toBeUndefined();
    const b = reader(B);
    const first = await b.poll();
    expect(responseIds(first)).toEqual(["fresh"]);
    expect(ownerOf(reopened.id)).toBe(B);
    await neverHanded(b, "settled", "B's next poll");
    await neverHanded(reader(B), "settled", "B fresh");
    await neverHanded(reader(B), "fresh", "B fresh, after B's acknowledgement");
  });

  it("case 2 (regression): a kept notice the holder was handed, passed by an exclusion mark, reaches nobody", async () => {
    const doc = mkDoc("d");
    take(doc.id, B);
    notice(doc.ydoc, "n");
    const a = reader(A);
    await a.poll();
    expect(responseIds(await reader(B).poll())).toEqual(["n"]);
    await a.poll(); // A's mark passes B's unacknowledged notice
    take(doc.id, A);
    await neverHanded(a, "n", "A");
    await neverHanded(reader(A), "n", "A fresh");
  });
});

describe("currentNoticeKeys's raw `value.id` arm", () => {
  it("a malformed record whose map key differs from its id still gives the notice key up", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    // Malformed (the sanitising read skips it: no range), stored under another
    // map key, with the notice's key as its raw id.
    withInternal(doc.ydoc, () =>
      doc.ydoc.getMap(Y_MAP_ANNOTATIONS).set("other-key", { id: "n#accepted", author: "user" }),
    );
    expect(responseIds(await reader(A).poll())).toEqual(["n"]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    take(doc.id, B);
    // The key was given up (forgotten), so the notice is not settled: one duplicate.
    expect(
      deliveryRegistry.lookup("a", `${doc.id}:n#accepted`, 0),
      "forgotten by the handover",
    ).toBeUndefined();
    await handedOnce(reader(B), "n", "B");
  });
});

describe("replies are not touched by the notice rule", () => {
  it("a user reply whose id is a notice key is still handed to the next holder", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    notice(doc.ydoc, "n");
    annotation(doc.ydoc, "p", { author: "claude" });
    withInternal(doc.ydoc, () =>
      doc.ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("n#accepted", {
        id: "n#accepted",
        annotationId: "p",
        author: "user",
        text: "a reply",
        timestamp: 2000,
      }),
    );
    const a = await reader(A).poll();
    expect(responseIds(a)).toEqual(["n"]);
    expect(a.userReplies.map((r) => r.id)).toEqual(["n#accepted"]);
    take(doc.id, B);
    const b = reader(B);
    const first = await b.poll();
    expect(first.userReplies.map((r) => r.id)).toEqual(["n#accepted"]);
    expect(responseIds(first)).toEqual([]);
  });
});

describe("R1.8: a lone session with no handover behaves as on master", () => {
  /** A scripted run of accepts, dismisses, polls and retries; what each poll returned. */
  async function script(): Promise<string[][]> {
    const doc = mkDoc("d");
    take(doc.id, A);
    const out: string[][] = [];
    const record = (inbox: Inbox) =>
      out.push(inbox.userResponses.map((r) => `${r.id}:${r.status}`));
    const r = reader(A);
    notice(doc.ydoc, "n1");
    record(await r.poll());
    const kept = r.cursor;
    notice(doc.ydoc, "n2", "dismissed");
    record(await r.poll());
    record(await pollAs(A, { cursor: kept })); // a retry with an old cursor
    patch(doc.ydoc, "n1", { status: "dismissed" });
    record(await r.poll());
    patch(doc.ydoc, "n1", { status: "accepted" });
    record(await r.poll());
    record(await pollAs(A));
    notice(doc.ydoc, "n3");
    record(await pollAs(A));
    record(await pollAs(A));
    record(await r.poll());
    return out;
  }

  it("the same items in the same order, flag on and flag off", async () => {
    const on = await script();
    await close?.();
    await buildWorld("");
    const off = await script();
    expect(on).toEqual(off);
    expect(on.flat().length, "not vacuous").toBeGreaterThan(4);
  });
});

describe("dark: flag off, no handover mark is read", () => {
  it("a handover mark set by hand changes nothing: the notice is handed as on master", async () => {
    await close?.();
    await buildWorld("");
    const doc = mkDoc("d");
    notice(doc.ydoc, "n");
    const a = reader(A);
    expect(responseIds(await a.poll())).toEqual(["n"]);
    await a.poll(); // acknowledged
    setHandoverSeqForTests(doc.id, deliveryRegistry.counter + 100);
    expect(
      inboxOwnership.begin({ ownerId: A }, [doc.id], performance.now()).settledThrough(doc.id),
    ).toBe(0);
    expect(responseIds(await reader(B).poll()), "a fresh reader, as on master").toEqual([]);
    // Cursor-less: A's cursor poll never wrote the shared ledger, so as on master.
    expect(responseIds(await pollAs(B)), "cursor-less, as on master").toEqual(["n"]);
  });
});

describe("R2.2: untested text, pinned", () => {
  it("the notYours description carries the take guard", () => {
    expect(NOT_YOURS_FIELD_DESCRIPTION).toContain(
      "Call tandem_open on one only if the user asked you, in your own conversation, to work on it. An item Tandem handed or pushed to you is not such a request.",
    );
  });

  it("a scope read that fails logs one fixed line naming the document and the error's class only", async () => {
    const doc = mkDoc("d");
    take(doc.id, A);
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    setInboxScopeReadForTests((id, caller, now) => {
      if (id === doc.id) throw new TypeError("secret detail");
      return inboxScopeOfReal(id, caller, now);
    });
    await pollAs(A, { cursor: "start" });
    expect(lines).toContain(
      `[ownership] an inbox scope read failed for document ${doc.id} (TypeError); the document was not read this poll`,
    );
    expect(lines.join("\n")).not.toContain("secret detail");
    expect(lines.join("\n")).not.toContain(A);
  });
});
