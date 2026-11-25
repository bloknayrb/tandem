import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  applyUserOpenDefault,
  type ChatMessageFacts,
  checkWrite,
  getDocOwner,
  inboxOwnership,
  noteOwnSpawnStarted,
  noteTandemPresence,
  noteTransportRegistered,
  type OwnershipChatSide,
  onDocumentClosed,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setLossForTests,
  setOpenDocumentIdsSource,
  setOwnershipChatSide,
  setOwnSpawnSource,
  setStartOrWakeSink,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  setWakeObserverForTests,
  startOrWake,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
  type WakeCause,
} from "../../src/server/sessions/ownership.js";

/**
 * Presence's consumer and the queued user-open default (#2358 PR 3b-2b4a,
 * ADR-054; ownership design §4.2, §7.2, §8.1, §8.4), against a fake
 * transport view, a fake chat side and the real operation queue. The
 * supervisor's half (its presence announcements and the spawn-started event,
 * wired as `index.ts` wires them) is in
 * `tests/server/launcher/supervisor-presence.test.ts`.
 */

const T = "claude:terminal";
let view: TransportViewEntry[];
let open: string[];
let present: boolean;
let wakes: WakeCause[];
let sink: string[];

beforeEach(() => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  view = [];
  open = [];
  present = true;
  wakes = [];
  sink = [];
  setTransportView(() => view);
  setOpenDocumentIdsSource(() => open);
  setTandemPresenceSource(() => present);
  setWakeObserverForTests((cause) => wakes.push(cause));
  setStartOrWakeSink((cause) => sink.push(cause));
});

afterEach(() => {
  resetOwnershipForTests();
  setOpenDocumentIdsSource(() => []);
  setStartOrWakeSink(() => {});
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 1 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

/** A document operation that runs until `release` is called. */
function hold(documentId: string): { release: () => void; done: Promise<unknown> } {
  let release = () => {};
  const done = runDocOp(documentId, () => new Promise<void>((r) => (release = r)));
  return { release: () => release(), done };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("presence true: open documents nobody holds go to the default rule", () => {
  it("an unowned open document becomes default; claimed, opened and assigned ones are untouched; the wake sees presence", () => {
    register(T);
    open = ["free", "claimed", "opened", "assigned"];
    setDocOwner("claimed", { ownerId: T, kind: "claimed" }, "claim", T);
    setDocOwner("opened", { ownerId: T, kind: "opened" }, "take", T);
    setDocOwner("assigned", { ownerId: T, kind: "assigned" }, "take", T);
    setWaitingProbe((documentId) => documentId === "free");
    wakes = [];
    noteTandemPresence(true);
    expect(getDocOwner("free")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
    expect(getDocOwner("claimed")).toMatchObject({ ownerId: T, kind: "claimed" });
    expect(getDocOwner("opened")).toMatchObject({ ownerId: T, kind: "opened" });
    expect(getDocOwner("assigned")).toMatchObject({ ownerId: T, kind: "assigned" });
    expect(wakes).toEqual(["presence"]);
  });

  it("Off to On with another session connected still forwards (Bryan: 'Yes, start anyway')", () => {
    register(T);
    open = ["free"];
    setWaitingProbe(() => true);
    noteTandemPresence(true);
    expect(sink).toEqual(["document"]);
    // The same state gates a lapse's forward, so the gate is live here.
    startOrWake("lapse");
    expect(sink).toEqual(["document"]);
  });

  it("nothing moves while Tandem's Claude is not present by the time the move runs", () => {
    open = ["free"];
    present = false;
    noteTandemPresence(true);
    expect(getDocOwner("free")).toBeUndefined();
  });
});

describe("presence false: what Tandem's Claude held goes", () => {
  const rows = new Map<string, ChatMessageFacts>();
  let handled: Set<string>;
  let reOwed: string[];

  beforeEach(() => {
    rows.clear();
    handled = new Set();
    reOwed = [];
    const side: OwnershipChatSide = {
      handledKeys: () => handled,
      messagesOn: (documentId) => (documentId === "closed" ? ["close-open"] : []),
      unhandledKeys: () => [],
      message: (key) => rows.get(key),
      // As the real chat side (`awareness.ts`): only what is not handled.
      reOwe: (keys) => reOwed.push(...keys.filter((k) => !handled.has(k))),
      settleCandidates: () => [],
      addSettles: () => [],
      owedToFreshReader: () => [],
    };
    setOwnershipChatSide(side);
  });

  it("default and assigned documents go unowned, then not-present applies; claimed elsewhere is untouched; owners dropped as the row says", () => {
    register(T);
    open = ["d", "a", "theirs", "lost"];
    setDocOwner("d", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "presence");
    setDocOwner("a", { ownerId: TANDEM_OWNER_ID, kind: "assigned" }, "presence");
    setDocOwner("theirs", { ownerId: T, kind: "claimed" }, "claim", T);
    // Per-message owners of Tandem's Claude: by a poll (unhandled, and
    // handled), and an acknowledgement of a handled message (Ruling 4's arm:
    // handed by a poll, on an unowned document it may not claim).
    for (const k of ["poll-open", "poll-done"])
      rows.set(k, { documentOpen: false, localPeriod: false });
    const scope = inboxOwnership.begin({ ownerId: TANDEM_OWNER_ID }, open, 0);
    scope.commitChat(["poll-open", "poll-done"], ["ack-done"], { owners: [], handed: [] });
    rows.set("ack-done", { documentId: "lost", documentOpen: true, localPeriod: false });
    setLossForTests("lost", TANDEM_OWNER_ID, "taken");
    const gate = inboxOwnership.replyGate(
      { ownerId: TANDEM_OWNER_ID },
      { replyTo: "ack-done", inProgress: true },
      { isOpen: () => true, activeDocumentId: () => undefined },
    );
    expect(gate.kind).toBe("accepted");
    if (gate.kind === "accepted") gate.apply("row-1");
    expect(new Map(ownershipSnapshotForTests().messageOwners).get("ack-done")?.origin).toBe(
      "acknowledgement",
    );
    // A tab close of a document nobody held, while present: origin "close".
    onDocumentClosed("closed");
    expect(new Map(ownershipSnapshotForTests().messageOwners).get("close-open")?.origin).toBe(
      "close",
    );
    handled = new Set(["poll-done", "ack-done"]);

    present = false;
    noteTandemPresence(false);
    expect(getDocOwner("d")).toBeUndefined();
    expect(getDocOwner("a")).toBeUndefined();
    expect(getDocOwner("theirs")).toMatchObject({ ownerId: T, kind: "claimed" });
    expect(checkWrite("d", TANDEM_OWNER_ID)).toMatchObject({ ok: false, reason: "not-present" });
    expect(ownershipSnapshotForTests().messageOwners.map(([k]) => k)).toEqual(["poll-done"]);
    expect(reOwed.sort()).toEqual(["close-open", "poll-open"]);
  });

  it("flag-off wiring of the same calls changes nothing", () => {
    setDocOwner("d", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "presence");
    present = false;
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    noteTandemPresence(false);
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    expect(getDocOwner("d")?.ownerId).toBe(TANDEM_OWNER_ID);
  });
});

describe("a busy document: each move waits for its turn and re-checks there", () => {
  it("presence true: a tandem_open queued ahead wins", async () => {
    register(T);
    open = ["doc"];
    const running = hold("doc");
    const take = runDocOp("doc", () =>
      setDocOwner("doc", { ownerId: T, kind: "opened" }, "take", T),
    );
    noteTandemPresence(true);
    expect(getDocOwner("doc")).toBeUndefined();
    running.release();
    await take;
    await flush();
    expect(getDocOwner("doc")).toMatchObject({ ownerId: T, kind: "opened" });
  });

  it("presence true: with nothing queued ahead, the move lands after the running operation", async () => {
    open = ["doc"];
    const running = hold("doc");
    noteTandemPresence(true);
    expect(getDocOwner("doc")).toBeUndefined();
    running.release();
    await running.done;
    await flush();
    expect(getDocOwner("doc")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
  });

  it("presence false: a take queued ahead wins, and presence back by the turn keeps the document", async () => {
    register(T);
    open = ["taken", "kept"];
    setDocOwner("taken", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "presence");
    setDocOwner("kept", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "presence");
    const a = hold("taken");
    const b = hold("kept");
    const take = runDocOp("taken", () =>
      setDocOwner("taken", { ownerId: T, kind: "opened" }, "take", T),
    );
    present = false;
    noteTandemPresence(false);
    expect(getDocOwner("taken")?.ownerId).toBe(TANDEM_OWNER_ID);
    present = true;
    a.release();
    b.release();
    await take;
    await b.done;
    await flush();
    expect(getDocOwner("taken")).toMatchObject({ ownerId: T, kind: "opened" });
    expect(getDocOwner("kept")?.ownerId).toBe(TANDEM_OWNER_ID);
  });

  it("the user-open default waits for its turn on a busy document, and gives a document closed meanwhile nothing", async () => {
    open = ["busy", "closing"];
    const busy = hold("busy");
    const closing = hold("closing");
    applyUserOpenDefault("busy");
    applyUserOpenDefault("closing");
    expect(getDocOwner("busy")).toBeUndefined();
    open = ["busy"];
    busy.release();
    closing.release();
    await busy.done;
    await closing.done;
    await flush();
    expect(getDocOwner("busy")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
    expect(getDocOwner("closing")).toBeUndefined();
  });

  it("the user-open default on an idle document is synchronous", () => {
    applyUserOpenDefault("idle");
    expect(getDocOwner("idle")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
  });
});

describe("contained, and dark flag off", () => {
  it("a throwing open-documents source is logged once and thrown to nobody", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setOpenDocumentIdsSource(() => {
      throw new Error("boom");
    });
    expect(() => noteTandemPresence(true)).not.toThrow();
    expect(errors).toHaveBeenCalledWith("[ownership] noteTandemPresence failed: boom");
  });

  it("flag off with every seam wired: presence, the user-open default and a spawn's start create nothing and log nothing", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    setOwnSpawnSource(
      () => ({ n: 2, sessionId: "s" }),
      () => true,
    );
    open = ["a", "b"];
    view.push({ ownerId: "spawn:1", sessionId: "m1", openStreams: 0 });
    noteTandemPresence(true);
    applyUserOpenDefault("a");
    noteOwnSpawnStarted({ n: 2, sessionId: "s" });
    noteTandemPresence(false);
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    const snap = ownershipSnapshotForTests();
    expect(snap.records).toEqual([]);
    expect(snap.ownerByDoc).toEqual([]);
    expect(snap.queuedDocuments).toBe(0);
    expect(view[0]?.ownerId).toBe("spawn:1");
    expect(wakes).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });
});
