import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_DESKTOP_CLIENT_NAME } from "../../src/server/mcp/transport-registry.js";
import { getMcpContext, runWithMcpContext } from "../../src/server/sessions/context.js";
import {
  confirmBind,
  endSpawn,
  markSpawnStarted,
  registerSpawn,
  resetOwnerHandleBindForTests,
} from "../../src/server/sessions/owner-handle-bind.js";
import {
  type ChatMessageFacts,
  CLAUDE_CODE_CLIENT_NAME,
  checkWrite,
  DEFAULT_GRACE_MS,
  decideTake,
  displayKindOf,
  getDocOwner,
  getOwnerRecord,
  getOwnershipTransportMode,
  heldDocumentIds,
  inboxOwnership,
  LOCAL_OWNER_ID,
  MAX_DETACHED_RECORDS,
  noteOwnSpawnStarted,
  noteRecordPoll,
  noteTransportChanged,
  noteTransportRegistered,
  type OwnerRecord,
  type OwnSpawn,
  otherAnswererOf,
  ownershipSnapshotForTests,
  ownSpawnRoutingActive,
  recordAnswerer,
  recordHoldsState,
  resetOwnershipForTests,
  resolveTransportRecord,
  setDocOwner,
  setOwnershipChatSide,
  setOwnershipSeqSource,
  setOwnershipTransportMode,
  setOwnSpawnSource,
  setStartOrWakeSink,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  setWakeObserverForTests,
  startOrWake,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
  takeDocument,
} from "../../src/server/sessions/ownership.js";

/**
 * Owner records, attachment and lapse (#2358, ADR-054; ownership design §3.1,
 * §3.4), against a fake transport-registry view and fake timers. The HTTP
 * suite (`ownership-http-identity.test.ts`) runs the same lifecycle through the
 * real server.
 */

/** A mutable stand-in for `registry.list()`. */
let view: TransportViewEntry[];

beforeEach(() => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  vi.useFakeTimers();
  view = [];
  setTransportView(() => view);
});

afterEach(() => {
  resetOwnershipForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Register a transport of `ownerId` the way server.ts does: view first, then the note. */
function register(
  ownerId: string,
  kind: OwnerRecord["recordKind"] = "claude",
  clientName?: string,
) {
  const entry: TransportViewEntry = { ownerId, openStreams: 0 };
  view.push(entry);
  noteTransportRegistered(ownerId, { recordKind: kind, clientName });
  return entry;
}

function remove(entry: TransportViewEntry) {
  view = view.filter((e) => e !== entry);
  noteTransportChanged(entry.ownerId);
}

/** Every registered entry's ownerId names a live record (1c's enforcement relies on it). */
function expectNoDanglingOwners() {
  for (const e of view) {
    if (e.ownerId !== undefined) expect(getOwnerRecord(e.ownerId), e.ownerId).toBeDefined();
  }
}

describe("which record a transport belongs to (ownership design §3.1 rules 1–3)", () => {
  it("a Claude session id wins, then the bridge's client id, then the transport itself", () => {
    expect(
      resolveTransportRecord({ mcpSessionId: "m1", claudeSessionId: "AbC", clientId: "b1" }),
    ).toEqual({ ownerId: "claude:abc", recordKind: "claude" });
    expect(resolveTransportRecord({ mcpSessionId: "m1", clientId: "b1" })).toEqual({
      ownerId: "bridge:b1",
      recordKind: "bridge",
    });
    expect(resolveTransportRecord({ mcpSessionId: "m1" })).toEqual({
      ownerId: "http:m1",
      recordKind: "http",
    });
  });

  it("is pure: resolving creates nothing", () => {
    resolveTransportRecord({ mcpSessionId: "m1", claudeSessionId: "x" });
    expect(ownershipSnapshotForTests().records).toEqual([]);
  });

  it("two transports carrying one Claude session id, in either case, are one record", () => {
    const a = resolveTransportRecord({ mcpSessionId: "m1", claudeSessionId: "Sess" });
    const b = resolveTransportRecord({ mcpSessionId: "m2", claudeSessionId: "sess" });
    register(a?.ownerId as string);
    register(b?.ownerId as string);
    expect(a?.ownerId).toBe(b?.ownerId);
    expect(ownershipSnapshotForTests().records).toHaveLength(1);
  });
});

describe("labels and display kinds", () => {
  it("labels are owner- plus random characters, unique, never derived from an id", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `claude:session-${i}`);
    for (const id of ids) register(id);
    const labels = ids.map((id) => getOwnerRecord(id)?.label as string);
    expect(new Set(labels).size).toBe(ids.length);
    for (const l of labels) {
      expect(l).toMatch(/^owner-[0-9a-z]{4}$/);
      expect(l).not.toContain("session");
    }
  });

  it("the record kind comes first; a name only chooses between the last two kinds", () => {
    expect(displayKindOf({ recordKind: "tandem" })).toBe("Tandem's Claude");
    expect(displayKindOf({ recordKind: "claude", clientName: CLAUDE_DESKTOP_CLIENT_NAME })).toBe(
      "terminal",
    );
    expect(displayKindOf({ recordKind: "local" })).toBe("terminal");
    // #2358 PR 3b-2b3a: rule 0's records read as a terminal, whatever the name.
    expect(
      displayKindOf({ recordKind: "unbound-child", clientName: CLAUDE_DESKTOP_CLIENT_NAME }),
    ).toBe("terminal");
    expect(displayKindOf({ recordKind: "child-private" })).toBe("terminal");
    expect(displayKindOf({ recordKind: "bridge", clientName: CLAUDE_DESKTOP_CLIENT_NAME })).toBe(
      "Claude Desktop",
    );
    expect(displayKindOf({ recordKind: "http", clientName: CLAUDE_CODE_CLIENT_NAME })).toBe(
      "terminal",
    );
    expect(displayKindOf({ recordKind: "bridge", clientName: CLAUDE_CODE_CLIENT_NAME })).toBe(
      "other app",
    );
    expect(displayKindOf({ recordKind: "http", clientName: "Tandem's Claude" })).toBe("other app");
  });

  it("takes the latest initialize's client name", () => {
    register("bridge:b1", "bridge", "first");
    register("bridge:b1", "bridge", CLAUDE_DESKTOP_CLIENT_NAME);
    expect(getOwnerRecord("bridge:b1")?.clientName).toBe(CLAUDE_DESKTOP_CLIENT_NAME);
  });
});

describe("attachment and the 2-minute grace (ownership design §3.4)", () => {
  it("a record that never held a stream stays attached while a transport is registered", () => {
    register("claude:a");
    vi.advanceTimersByTime(10 * DEFAULT_GRACE_MS);
    expect(getOwnerRecord("claude:a")).toBeDefined();
    expect(ownershipSnapshotForTests().timers).toBe(0);
  });

  it("losing its last stream starts the grace; it lapses at exactly 2 minutes", () => {
    const e = register("claude:a");
    setDocOwner("doc-1", { ownerId: "claude:a", kind: "claimed" }, "user-open");
    e.openStreams = 1;
    e.streamEver = true;
    noteTransportChanged("claude:a");
    e.openStreams = 0;
    noteTransportChanged("claude:a");
    vi.advanceTimersByTime(DEFAULT_GRACE_MS - 1);
    expect(getDocOwner("doc-1")?.ownerId).toBe("claude:a");
    vi.advanceTimersByTime(1);
    // Tandem's Claude is not present, so the default rule leaves it unowned.
    expect(getDocOwner("doc-1")).toBeUndefined();
    // Its transport is still registered: it keeps its record and label.
    expect(getOwnerRecord("claude:a")?.lapsed).toBe(true);
    expectNoDanglingOwners();
  });

  it("a reopened stream ends the grace", () => {
    const e = register("claude:a");
    e.streamEver = true;
    noteTransportChanged("claude:a");
    expect(ownershipSnapshotForTests().timers).toBe(1);
    e.openStreams = 1;
    noteTransportChanged("claude:a");
    expect(ownershipSnapshotForTests().timers).toBe(0);
    vi.advanceTimersByTime(2 * DEFAULT_GRACE_MS);
    expect(getOwnerRecord("claude:a")?.lapsed).toBeUndefined();
  });

  it("a request while still detached starts a fresh grace rather than cancelling it", () => {
    const e = register("claude:a");
    setDocOwner("doc-1", { ownerId: "claude:a", kind: "claimed" }, "user-open");
    e.streamEver = true;
    noteTransportChanged("claude:a");
    vi.advanceTimersByTime(DEFAULT_GRACE_MS - 10);
    noteTransportChanged("claude:a"); // a request on its transport
    vi.advanceTimersByTime(DEFAULT_GRACE_MS - 10);
    expect(getDocOwner("doc-1")?.ownerId).toBe("claude:a");
    vi.advanceTimersByTime(10);
    expect(getDocOwner("doc-1")).toBeUndefined();
  });

  it("a new transport for the record ends the grace", () => {
    const e = register("claude:a");
    e.streamEver = true;
    noteTransportChanged("claude:a");
    remove(e);
    expect(ownershipSnapshotForTests().timers).toBe(1);
    register("claude:a");
    expect(ownershipSnapshotForTests().timers).toBe(0);
  });

  it("a record whose last transport goes keeps the grace, then is deleted at lapse", () => {
    const e = register("claude:a");
    setDocOwner("doc-1", { ownerId: "claude:a", kind: "opened" }, "user-open");
    remove(e);
    expect(getOwnerRecord("claude:a")).toBeDefined();
    vi.advanceTimersByTime(DEFAULT_GRACE_MS);
    expect(getOwnerRecord("claude:a")).toBeUndefined();
    expect(getDocOwner("doc-1")).toBeUndefined();
  });

  it("a lapsed record that picks a document up again while detached gets a fresh grace", () => {
    const e = register("claude:a");
    e.streamEver = true;
    noteTransportChanged("claude:a");
    vi.advanceTimersByTime(DEFAULT_GRACE_MS);
    expect(getOwnerRecord("claude:a")?.lapsed).toBe(true);
    expect(ownershipSnapshotForTests().timers).toBe(0);
    // Later PRs' claims go through setDocOwner; the next event re-judges it.
    setDocOwner("doc-2", { ownerId: "claude:a", kind: "claimed" }, "user-open");
    noteTransportChanged("claude:a");
    expect(ownershipSnapshotForTests().timers).toBe(1);
    vi.advanceTimersByTime(DEFAULT_GRACE_MS);
    expect(getDocOwner("doc-2")).toBeUndefined();
  });

  it("a lapsed record holding nothing is deleted once its last transport goes", () => {
    const e = register("claude:a");
    e.streamEver = true;
    noteTransportChanged("claude:a");
    vi.advanceTimersByTime(DEFAULT_GRACE_MS);
    remove(e);
    expect(getOwnerRecord("claude:a")).toBeUndefined();
  });

  it("the lapse runs outside the request context that armed its timer", () => {
    const e = register("claude:a");
    setDocOwner("doc-1", { ownerId: "claude:a", kind: "claimed" }, "user-open");
    let seen: unknown = "unset";
    setTandemPresenceSource(() => {
      seen = getMcpContext();
      return false;
    });
    runWithMcpContext({ ownerId: "claude:stranger", claudeSessionId: "stranger" }, () => remove(e));
    vi.advanceTimersByTime(DEFAULT_GRACE_MS);
    expect(seen).toBeUndefined();
  });

  it("a stale timer and an unknown id do nothing and create nothing", () => {
    noteTransportChanged("claude:nobody");
    noteRecordPoll("claude:nobody");
    noteTransportChanged(undefined);
    expect(ownershipSnapshotForTests().records).toEqual([]);
    const e = register("claude:a");
    e.streamEver = true;
    noteTransportChanged("claude:a"); // armed
    noteTransportChanged("claude:a"); // re-armed: the first timer is now stale
    vi.advanceTimersByTime(DEFAULT_GRACE_MS);
    expect(getOwnerRecord("claude:a")?.lapsed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the cap on detached records", () => {
  it("past the cap, the grace that would expire first lapses at once", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < MAX_DETACHED_RECORDS; i++) {
      const id = `bridge:b${i}`;
      const e = register(id, "bridge");
      setDocOwner(`doc-${i}`, { ownerId: id, kind: "claimed" }, "user-open");
      remove(e);
      vi.advanceTimersByTime(10);
    }
    expect(ownershipSnapshotForTests().timers).toBe(MAX_DETACHED_RECORDS);
    // Re-arming one already in its grace does not grow the count.
    noteTransportChanged("bridge:b0");
    expect(ownershipSnapshotForTests().timers).toBe(MAX_DETACHED_RECORDS);
    expect(getDocOwner("doc-0")?.ownerId).toBe("bridge:b0");
    // A newcomer that also holds a document, so every grace holds state and
    // expiry order alone decides.
    const e = register("bridge:new", "bridge");
    setDocOwner("doc-new", { ownerId: "bridge:new", kind: "claimed" }, "user-open");
    remove(e);
    // b0 was re-armed most recently but one, so b1 expires first and goes.
    expect(getOwnerRecord("bridge:b1")).toBeUndefined();
    expect(getDocOwner("doc-1")).toBeUndefined();
    expect(getDocOwner("doc-0")?.ownerId).toBe("bridge:b0");
    expect(ownershipSnapshotForTests().timers).toBe(MAX_DETACHED_RECORDS);
    // Logged once, by label count only, never an id.
    const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("lapsing"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/bridge:|b\d/);
    spy.mockRestore();
  });
});

describe("the transport mode", () => {
  it("is settable once; a different later value is ignored, never thrown", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setOwnershipTransportMode("http");
    expect(() => setOwnershipTransportMode("stdio")).not.toThrow();
    expect(getOwnershipTransportMode()).toBe("http");
    expect(getOwnerRecord(LOCAL_OWNER_ID)).toBeUndefined();
    spy.mockRestore();
  });

  it("stdio mode creates the permanently attached local record", () => {
    setOwnershipTransportMode("stdio");
    expect(getOwnerRecord(LOCAL_OWNER_ID)?.recordKind).toBe("local");
    noteRecordPoll(LOCAL_OWNER_ID);
    expect(getOwnerRecord(LOCAL_OWNER_ID)?.lastPollAt).toBeTypeOf("number");
  });
});

describe("entry points are total", () => {
  it("a throwing registry view is logged, not thrown", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setTransportView(() => {
      throw new Error("boom");
    });
    expect(() => noteTransportRegistered("claude:a", { recordKind: "claude" })).not.toThrow();
    expect(() => noteTransportChanged("claude:a")).not.toThrow();
    expect(spy.mock.calls.some((c) => String(c[0]).includes("boom"))).toBe(true);
    spy.mockRestore();
  });
});

describe("what a record holds", () => {
  it("OwnerRecord's keys are the reviewed list, so a new field must decide whether recordHoldsState covers it", () => {
    const full: Required<OwnerRecord> = {
      ownerId: "x",
      recordKind: "claude",
      label: "owner-0000",
      clientName: "c",
      lastPollAt: 0,
      graceTimer: setTimeout(() => {}, 0),
      graceArmedAt: 0,
      lapsed: true,
      changeNotices: [],
      fromOwnTeardown: true,
    };
    // `fromOwnTeardown` (3b-2b5): provenance, not state the record holds, so
    // NOT counted by recordHoldsState; it only skips the departure re-ask.
    // `changeNotices` (the change-notice PR): NOT counted by
    // recordHoldsState (Ruling 6), pinned by the next test. The chat owners
    // PR adds no field: per-message owners and "handed" memory live in the
    // module's own maps (`ownerByMessage`, `handedByRecord`), counted by
    // recordHoldsState only while their message is unhandled (R3.5).
    expect(Object.keys(full).sort()).toEqual([
      "changeNotices",
      "clientName",
      "fromOwnTeardown",
      "graceArmedAt",
      "graceTimer",
      "label",
      "lapsed",
      "lastPollAt",
      "ownerId",
      "recordKind",
    ]);
    clearTimeout(full.graceTimer);
  });

  it("queued change notices are not state: a record holding only notices holds nothing (Ruling 6)", () => {
    register("claude:a");
    setDocOwner("d", { ownerId: "claude:a", kind: "claimed" }, "claim", "claude:a");
    setDocOwner("d", null, "lapse");
    const record = getOwnerRecord("claude:a") as OwnerRecord;
    expect(record.changeNotices?.length).toBe(2);
    expect(recordHoldsState(record)).toBe(false);
  });

  it("no change notice is queued for Tandem's Claude; the terminal it took a document back from is told (3b-2b4c)", () => {
    // A cause literal: this proves the mapping, not a path (the paths are in
    // ownership-change-notices.test.ts).
    register("claude:a");
    setDocOwner("d", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "take", TANDEM_OWNER_ID);
    setDocOwner("d", { ownerId: "claude:a", kind: "opened" }, "take", "claude:a");
    setDocOwner("d", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "take-back");
    expect(ownershipSnapshotForTests().changeNotices).toEqual([
      [
        "claude:a",
        [
          { documentId: "d", change: "gained", cause: "you opened or created it" },
          { documentId: "d", change: "lost", cause: "Tandem's Claude took it back" },
        ],
      ],
    ]);
  });

  it("holds state exactly while it holds a document", () => {
    register("claude:a");
    const record = getOwnerRecord("claude:a") as OwnerRecord;
    expect(recordHoldsState(record)).toBe(false);
    setDocOwner("d", { ownerId: "claude:a", kind: "claimed" }, "user-open");
    expect(recordHoldsState(record)).toBe(true);
  });
});

describe("reset", () => {
  it("leaves no timers and a pristine snapshot", () => {
    const e = register("claude:a");
    e.streamEver = true;
    noteTransportChanged("claude:a");
    setOwnershipTransportMode("stdio");
    resetOwnershipForTests();
    expect(vi.getTimerCount()).toBe(0);
    expect(ownershipSnapshotForTests()).toEqual({
      transportMode: undefined,
      records: [],
      ownerByDoc: [],
      handoverSeq: [],
      timers: 0,
      losses: [],
      answerers: 0,
      queuedDocuments: 0,
      pendingClaims: 0,
      changeNotices: [],
      // The chat owners PR: per-message owners (with their origins) and what
      // each record was handed. Empty, since no record exists.
      messageOwners: [],
      handed: [],
      // The posts PR: the carried-over set, the chat answerers and who wrote
      // each reply row. Empty.
      carriedOver: [],
      chatAnswerers: [],
      repliers: [],
      messageLosses: [],
    });
  });
});

describe("flag off: nothing is ever created", () => {
  it("every entry point is a no-op", () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    setOwnershipTransportMode("stdio");
    expect(resolveTransportRecord({ mcpSessionId: "m", claudeSessionId: "c" })).toBeUndefined();
    view.push({ ownerId: "claude:c", openStreams: 0 });
    noteTransportRegistered("claude:c", { recordKind: "claude" });
    noteTransportChanged("claude:c");
    noteRecordPoll("claude:c");
    setDocOwner("d", { ownerId: "claude:c", kind: "claimed" }, "user-open");
    expect(ownershipSnapshotForTests()).toEqual({
      transportMode: undefined,
      records: [],
      ownerByDoc: [],
      handoverSeq: [],
      timers: 0,
      losses: [],
      answerers: 0,
      queuedDocuments: 0,
      pendingClaims: 0,
      changeNotices: [],
      // The chat owners PR: per-message owners (with their origins) and what
      // each record was handed. Empty, since no record exists.
      messageOwners: [],
      handed: [],
      // The posts PR: the carried-over set, the chat answerers and who wrote
      // each reply row. Empty.
      carriedOver: [],
      chatAnswerers: [],
      repliers: [],
      messageLosses: [],
    });
  });
});

describe("review gaps (#2371): behaviours a mutation could remove unnoticed", () => {
  /** A record holding `doc`, its one transport having streamed and closed: detached, in its grace. */
  function detachedHolder(ownerId: string, doc: string) {
    const e = register(ownerId);
    setDocOwner(doc, { ownerId, kind: "claimed" }, "user-open");
    e.streamEver = true;
    noteTransportChanged(ownerId);
    return e;
  }

  it("a lapse while Tandem's Claude is present hands the documents to it as default", () => {
    setTandemPresenceSource(() => true);
    detachedHolder("claude:a", "doc-1");
    vi.advanceTimersByTime(DEFAULT_GRACE_MS);
    expect(getDocOwner("doc-1")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
    expect(getOwnerRecord(TANDEM_OWNER_ID)?.recordKind).toBe("tandem");
  });

  it("a re-judge that throws still fails toward a lapse", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    register("claude:a");
    setDocOwner("doc-1", { ownerId: "claude:a", kind: "claimed" }, "user-open");
    // The view throws once, mid-judgement, and then recovers showing the
    // record's transport gone.
    let calls = 0;
    setTransportView(() => {
      calls++;
      if (calls === 1) throw new Error("view failed");
      return [];
    });
    noteTransportChanged("claude:a");
    expect(ownershipSnapshotForTests().timers).toBe(1);
    vi.advanceTimersByTime(DEFAULT_GRACE_MS);
    expect(getDocOwner("doc-1")).toBeUndefined();
    spy.mockRestore();
  });

  it("the cap re-checks attachment before counting a grace against it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const entries: TransportViewEntry[] = [];
    for (let i = 0; i < MAX_DETACHED_RECORDS; i++) {
      entries.push(detachedHolder(`bridge:b${i}`, `doc-${i}`));
      vi.advanceTimersByTime(10);
    }
    // b0 (the oldest grace) is attached again in the registry, but nothing
    // re-judged it yet: the cap must not lapse it as if it were detached.
    entries[0].openStreams = 1;
    detachedHolder("bridge:new", "doc-new");
    expect(getDocOwner("doc-0")?.ownerId).toBe("bridge:b0");
    expect(getOwnerRecord("bridge:b0")?.lapsed).toBeUndefined();
    spy.mockRestore();
  });

  it("the cap lapses records that hold nothing before any that hold documents", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The oldest grace belongs to a record that holds a document…
    detachedHolder("bridge:holder", "doc-held");
    vi.advanceTimersByTime(10);
    // …then 64 forged records that hold nothing fill the cap and overflow it.
    for (let i = 0; i < MAX_DETACHED_RECORDS; i++) {
      const e = register(`bridge:empty${i}`, "bridge");
      e.streamEver = true;
      noteTransportChanged(`bridge:empty${i}`);
      vi.advanceTimersByTime(10);
    }
    expect(getDocOwner("doc-held")?.ownerId).toBe("bridge:holder");
    expect(getOwnerRecord("bridge:holder")?.lapsed).toBeUndefined();
    expect(getOwnerRecord("bridge:empty0")?.lapsed).toBe(true);
    spy.mockRestore();
  });

  it("a cap lapse runs outside the request context that triggered it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < MAX_DETACHED_RECORDS; i++) {
      detachedHolder(`bridge:b${i}`, `doc-${i}`);
      vi.advanceTimersByTime(10);
    }
    const seen: unknown[] = [];
    setTandemPresenceSource(() => {
      seen.push(getMcpContext());
      return false;
    });
    runWithMcpContext({ ownerId: "claude:stranger", claudeSessionId: "stranger" }, () =>
      detachedHolder("bridge:new", "doc-new"),
    );
    expect(getDocOwner("doc-0")).toBeUndefined(); // the cap did lapse b0
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((ctx) => ctx === undefined)).toBe(true);
    spy.mockRestore();
  });

  it("re-attaching after a lapse clears the lapse", () => {
    const e = detachedHolder("claude:a", "doc-1");
    vi.advanceTimersByTime(DEFAULT_GRACE_MS);
    expect(getOwnerRecord("claude:a")?.lapsed).toBe(true);
    e.openStreams = 1;
    noteTransportChanged("claude:a");
    expect(getOwnerRecord("claude:a")?.lapsed).toBeUndefined();
  });

  it("an entry's sinceSeq comes from the seq source", () => {
    setOwnershipSeqSource(() => 7);
    setDocOwner("d", { ownerId: "claude:a", kind: "claimed" }, "user-open");
    expect(getDocOwner("d")?.sinceSeq).toBe(7);
  });

  it("step 5 asks whether items wait, never on Tandem's Claude's own change or a take-back", () => {
    // Since #2358 PR 3b-2d step 5 also asks for another record's gain made by
    // someone else (the `ownership` frame), so d1 is asked, with its owner.
    const probe = vi.fn(() => false);
    setWaitingProbe(probe);
    setDocOwner("d1", { ownerId: "claude:a", kind: "claimed" }, "user-open");
    expect(probe).toHaveBeenCalledExactlyOnceWith("d1", "claude:a");
    probe.mockClear();
    setDocOwner("d2", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "user-open", TANDEM_OWNER_ID);
    setDocOwner("d3", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "take-back");
    setDocOwner("d5", { ownerId: "claude:a", kind: "claimed" }, "claim", "claude:a");
    expect(probe).not.toHaveBeenCalled();
    setDocOwner("d4", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "user-open");
    expect(probe).toHaveBeenCalledExactlyOnceWith("d4", TANDEM_OWNER_ID);
  });

  it("an http record whose client calls itself Claude Desktop is Claude Desktop", () => {
    expect(displayKindOf({ recordKind: "http", clientName: CLAUDE_DESKTOP_CLIENT_NAME })).toBe(
      "Claude Desktop",
    );
  });
});

describe("rule 0: the spawn's records, computed and not routed (#2358 PR 3b-2b3a)", () => {
  const SPAWN_ID = "AbCd-Spawn-1";
  const OLD_CHILD_ID = "Old-Child-2";
  let spawn: OwnSpawn | null;
  const ownChildren = new Set([SPAWN_ID.toLowerCase(), OLD_CHILD_ID.toLowerCase()]);
  const isOwnChild = (id: string) => ownChildren.has(id.toLowerCase());

  beforeEach(() => {
    spawn = { n: 3, sessionId: SPAWN_ID };
    setOwnSpawnSource(() => spawn, isOwnChild);
  });

  const resolve = (identity: Parameters<typeof resolveTransportRecord>[0]) =>
    resolveTransportRecord(identity);

  it.each([
    [
      "a transport bound to the current spawn is tandem",
      { mcpSessionId: "m1", claudeSessionId: SPAWN_ID, bound: true },
      { ownerId: TANDEM_OWNER_ID, recordKind: "tandem" },
    ],
    [
      "an unbound transport with the current spawn's id is that spawn's unbound-child record",
      { mcpSessionId: "m1", claudeSessionId: SPAWN_ID, bound: false },
      { ownerId: "spawn:3", recordKind: "unbound-child" },
    ],
    [
      "a forger with the spawn's id and no handle is the unbound-child record, never tandem",
      { mcpSessionId: "m9", claudeSessionId: SPAWN_ID },
      { ownerId: "spawn:3", recordKind: "unbound-child" },
    ],
    [
      "the spawn's id in another case is the same unbound-child record",
      { mcpSessionId: "m2", claudeSessionId: SPAWN_ID.toUpperCase() },
      { ownerId: "spawn:3", recordKind: "unbound-child" },
    ],
    [
      "another own-child id is a private record of the transport",
      { mcpSessionId: "m3", claudeSessionId: OLD_CHILD_ID },
      { ownerId: "private:m3", recordKind: "child-private" },
    ],
    [
      "another own-child id in another case is still private",
      { mcpSessionId: "m4", claudeSessionId: OLD_CHILD_ID.toUpperCase() },
      { ownerId: "private:m4", recordKind: "child-private" },
    ],
    [
      "a session id that is no child's is a claude record (rule 1)",
      { mcpSessionId: "m5", claudeSessionId: "Someone-Else" },
      { ownerId: "claude:someone-else", recordKind: "claude" },
    ],
    [
      "no session id and not bound falls through to rules 2-3",
      { mcpSessionId: "m6", clientId: "b1" },
      { ownerId: "bridge:b1", recordKind: "bridge" },
    ],
  ] as const)("%s", (_name, identity, expected) => {
    expect(resolve(identity)).toEqual(expected);
  });

  it("two transports of one other own-child id are two private records", () => {
    const a = resolve({ mcpSessionId: "m1", claudeSessionId: OLD_CHILD_ID });
    const b = resolve({ mcpSessionId: "m2", claudeSessionId: OLD_CHILD_ID });
    expect(a?.recordKind).toBe("child-private");
    expect(a?.ownerId).not.toBe(b?.ownerId);
  });

  it("a resumed spawn (same id, new number) gets a new unbound-child record", () => {
    const before = resolve({ mcpSessionId: "m1", claudeSessionId: SPAWN_ID });
    spawn = { n: 4, sessionId: SPAWN_ID };
    const after = resolve({ mcpSessionId: "m2", claudeSessionId: SPAWN_ID });
    expect(before?.ownerId).toBe("spawn:3");
    expect(after).toEqual({ ownerId: "spawn:4", recordKind: "unbound-child" });
  });

  it("with no live spawn, the spawn's old id is a private record (it is an own-child id)", () => {
    spawn = null;
    expect(resolve({ mcpSessionId: "m1", claudeSessionId: SPAWN_ID })).toEqual({
      ownerId: "private:m1",
      recordKind: "child-private",
    });
  });

  it("a throwing source is logged and falls back to the transport's own record, never tandem", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setOwnSpawnSource(() => {
      throw new Error("boom");
    });
    expect(resolve({ mcpSessionId: "m1", claudeSessionId: SPAWN_ID })).toEqual({
      ownerId: "http:m1",
      recordKind: "http",
    });
    spy.mockRestore();
  });

  it("seam unset: exactly master's records, the bind outcome ignored", () => {
    setOwnSpawnSource(undefined);
    expect(ownSpawnRoutingActive()).toBe(false);
    expect(resolve({ mcpSessionId: "m1", claudeSessionId: SPAWN_ID, bound: true })).toEqual({
      ownerId: "claude:abcd-spawn-1",
      recordKind: "claude",
    });
    expect(resolve({ mcpSessionId: "m3", claudeSessionId: OLD_CHILD_ID })).toEqual({
      ownerId: "claude:old-child-2",
      recordKind: "claude",
    });
  });

  it("is pure, and the new records are attached and lapse like any other", () => {
    const owner = resolve({ mcpSessionId: "m1", claudeSessionId: SPAWN_ID });
    expect(ownershipSnapshotForTests().records).toEqual([]);
    const e = register(owner?.ownerId as string, owner?.recordKind);
    expect(getOwnerRecord("spawn:3")?.recordKind).toBe("unbound-child");
    remove(e);
    vi.advanceTimersByTime(DEFAULT_GRACE_MS);
    expect(getOwnerRecord("spawn:3")).toBeUndefined();
  });

  it("reset clears the seam", () => {
    expect(ownSpawnRoutingActive()).toBe(true);
    resetOwnershipForTests();
    expect(ownSpawnRoutingActive()).toBe(false);
  });

  it("flag off: the seam set changes nothing and creates nothing", () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    expect(ownSpawnRoutingActive()).toBe(false);
    expect(resolve({ mcpSessionId: "m1", claudeSessionId: SPAWN_ID, bound: true })).toBeUndefined();
    setOwnershipTransportMode("http");
    expect(ownershipSnapshotForTests().records).toEqual([]);
  });
});

describe("the tandem record at an HTTP-mode boot (#2358 PR 3b-2b3a)", () => {
  it("an HTTP mode-set creates it, flag on", () => {
    setOwnershipTransportMode("http");
    expect(getOwnerRecord(TANDEM_OWNER_ID)?.recordKind).toBe("tandem");
    expect(getOwnerRecord(LOCAL_OWNER_ID)).toBeUndefined();
  });

  it("flag off it is not created", () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    setOwnershipTransportMode("http");
    expect(getOwnerRecord(TANDEM_OWNER_ID)).toBeUndefined();
  });

  it("stdio mode does not create it eagerly; its lazy creation still works", () => {
    setOwnershipTransportMode("stdio");
    expect(getOwnerRecord(TANDEM_OWNER_ID)).toBeUndefined();
    setDocOwner("d", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "user-open");
    expect(getOwnerRecord(TANDEM_OWNER_ID)?.recordKind).toBe("tandem");
  });
});

describe("another session is connected: rule 0's kinds count, tandem does not (#2358 PR 3b-2b3a)", () => {
  // Observed through the lapse gate (Bryan's pick 2): a lapse forwards to the
  // sink only while no other session is connected.
  type Cause = "document" | "message" | "departure" | "solo-release" | "mode-known";
  let sink: ReturnType<typeof vi.fn<(cause: Cause) => void>>;
  beforeEach(() => {
    sink = vi.fn<(cause: Cause) => void>();
    setStartOrWakeSink(sink);
  });

  it("only the tandem record (made at an HTTP-mode boot): not another session", () => {
    setOwnershipTransportMode("http");
    startOrWake("lapse");
    expect(sink.mock.calls).toEqual([["document"]]);
  });

  it.each([
    ["unbound-child", "spawn:3"],
    ["child-private", "private:m1"],
  ] as const)("a %s record counts (a --resume terminal counts)", (kind, ownerId) => {
    register(ownerId, kind);
    startOrWake("lapse");
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("retirement, demotion and teardown re-pointing (#2358 PR 3b-2b3b)", () => {
  // Nothing in `src` sets the seam or calls `noteOwnSpawnStarted` until
  // 3b-2b4; these set the seam with a test source to prove what it switches on.
  const SPAWN_ID = "AbCd-Spawn-1";
  let spawn: OwnSpawn | null;
  const isOwnChild = (id: string) => id.toLowerCase() === SPAWN_ID.toLowerCase();

  beforeEach(() => {
    spawn = { n: 3, sessionId: SPAWN_ID };
    setOwnSpawnSource(() => spawn, isOwnChild);
    setTandemPresenceSource(() => true);
  });

  afterEach(() => {
    resetOwnerHandleBindForTests();
  });

  /** A transport with an Mcp-Session-Id, registered the way server.ts does. */
  function transport(sessionId: string, ownerId: string, kind: OwnerRecord["recordKind"]) {
    const entry: TransportViewEntry = { sessionId, clientName: "probe", ownerId, openStreams: 0 };
    view.push(entry);
    noteTransportRegistered(ownerId, { recordKind: kind, clientName: "probe" });
    return entry;
  }

  it("a new spawn retires the previous spawn's unbound-child record: documents to the default rule, each transport to a private record", () => {
    const a = transport("m1", "spawn:3", "unbound-child");
    const b = transport("m2", "spawn:3", "unbound-child");
    setDocOwner("d1", { ownerId: "spawn:3", kind: "claimed" }, "claim", "spawn:3");
    noteOwnSpawnStarted({ n: 4, sessionId: SPAWN_ID });
    expect(getOwnerRecord("spawn:3")).toBeUndefined();
    expect(getDocOwner("d1")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
    expect([a.ownerId, b.ownerId]).toEqual(["private:m1", "private:m2"]);
    expect(getOwnerRecord("private:m1")?.recordKind).toBe("child-private");
    expect(getOwnerRecord("private:m2")?.clientName).toBe("probe");
    expect(heldDocumentIds("private:m1")).toEqual([]);
    expectNoDanglingOwners();
  });

  it("a retired record's per-message chat is re-owed and follows the default rule (3b-2b3b review)", () => {
    const reOwed: string[] = [];
    setOwnershipChatSide({
      handledKeys: () => new Set(),
      messagesOn: () => [],
      unhandledKeys: () => [],
      message: () => ({ documentOpen: false, localPeriod: false }),
      reOwe: (keys) => reOwed.push(...keys),
      settleCandidates: () => [],
      addSettles: () => [],
      owedToFreshReader: () => [],
    });
    transport("m1", "spawn:3", "unbound-child");
    setTandemPresenceSource(() => false);
    const out = { owners: [] as string[], handed: [] as string[] };
    inboxOwnership.begin({ ownerId: "spawn:3" }, [], 0).commitChat(["chat-1"], ["chat-1"], out);
    expect(out.owners).toEqual(["chat-1"]);
    setTandemPresenceSource(() => true);
    noteOwnSpawnStarted({ n: 4, sessionId: SPAWN_ID });
    expect(ownershipSnapshotForTests().messageOwners).toEqual([]);
    expect(reOwed).toEqual(["chat-1"]);
    // Doc-less with no per-message owner: Tandem's Claude's while present.
    const tandem = inboxOwnership.begin({ ownerId: TANDEM_OWNER_ID }, [], 0);
    expect(tandem.chatScopeOf("chat-1", undefined)).toBe("owns");
  });

  it("with Tandem's Claude not present, the retired record's documents go unowned", () => {
    setTandemPresenceSource(() => false);
    transport("m1", "spawn:3", "unbound-child");
    setDocOwner("d1", { ownerId: "spawn:3", kind: "claimed" }, "claim", "spawn:3");
    noteOwnSpawnStarted({ n: 4, sessionId: SPAWN_ID });
    expect(getDocOwner("d1")).toBeUndefined();
  });

  it("the current spawn's own record is not retired", () => {
    const a = transport("m1", "spawn:3", "unbound-child");
    setDocOwner("d1", { ownerId: "spawn:3", kind: "claimed" }, "claim", "spawn:3");
    noteOwnSpawnStarted({ n: 3, sessionId: SPAWN_ID });
    expect(a.ownerId).toBe("spawn:3");
    expect(getDocOwner("d1")?.ownerId).toBe("spawn:3");
  });

  it("a plain claude record holding the new spawn's id is demoted: transports to the spawn's unbound-child record, documents to the default rule", () => {
    const key = `claude:${SPAWN_ID.toLowerCase()}`;
    const t = transport("m5", key, "claude");
    const other = transport("m6", "claude:someone-else", "claude");
    setDocOwner("d2", { ownerId: key, kind: "opened" }, "take", key);
    setDocOwner("d3", { ownerId: "claude:someone-else", kind: "opened" }, "take", "x");
    noteOwnSpawnStarted({ n: 4, sessionId: SPAWN_ID.toUpperCase() });
    expect(getOwnerRecord(key)).toBeUndefined();
    expect(t.ownerId).toBe("spawn:4");
    expect(getOwnerRecord("spawn:4")?.recordKind).toBe("unbound-child");
    expect(getDocOwner("d2")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
    expect(other.ownerId).toBe("claude:someone-else");
    expect(getDocOwner("d3")?.ownerId).toBe("claude:someone-else");
    expectNoDanglingOwners();
  });

  it("a spawn's teardown re-points its bound transports to private records; tandem keeps its documents", () => {
    const bind = registerSpawn({ handle: `th_${"L".repeat(32)}`, sessionId: SPAWN_ID });
    markSpawnStarted(bind);
    expect(confirmBind({ serial: bind.serial }, "m7")).toBe(true);
    const bound = transport("m7", TANDEM_OWNER_ID, "tandem");
    const notBound = transport("m8", TANDEM_OWNER_ID, "tandem");
    const child = transport("m9", "spawn:3", "unbound-child");
    setDocOwner("d4", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "user-open");
    endSpawn(bind);
    expect(bound.ownerId).toBe("private:m7");
    expect(getOwnerRecord("private:m7")?.recordKind).toBe("child-private");
    expect(notBound.ownerId).toBe(TANDEM_OWNER_ID);
    expect(child.ownerId).toBe("spawn:3");
    expect(getDocOwner("d4")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
    expectNoDanglingOwners();
  });

  describe("a stopped child's own leftovers start nothing (Bryan, 2026-11-23: 'No, its own lapse starts nothing')", () => {
    function lapseOf(entry: TransportViewEntry): void {
      view.splice(view.indexOf(entry), 1);
      noteTransportChanged(entry.ownerId);
      vi.advanceTimersByTime(10 * DEFAULT_GRACE_MS);
    }
    function departures(run: () => void): number {
      let n = 0;
      setWakeObserverForTests((cause) => {
        if (cause === "departure") n += 1;
      });
      try {
        run();
      } finally {
        setWakeObserverForTests(undefined);
      }
      return n;
    }

    it("a private record its teardown made lapses without the departure re-ask", () => {
      const bind = registerSpawn({ handle: `th_${"P".repeat(32)}`, sessionId: SPAWN_ID });
      markSpawnStarted(bind);
      expect(confirmBind({ serial: bind.serial }, "m7")).toBe(true);
      const bound = transport("m7", TANDEM_OWNER_ID, "tandem");
      endSpawn(bind);
      expect(bound.ownerId).toBe("private:m7");
      expect(departures(() => lapseOf(bound))).toBe(0);
    });

    it("an earlier spawn's unbound-child record lapses without the re-ask; the current spawn's does re-ask (a --resume terminal still counts)", () => {
      const old = transport("m1", "spawn:2", "unbound-child");
      expect(departures(() => lapseOf(old))).toBe(0);
      const current = transport("m2", "spawn:3", "unbound-child");
      expect(departures(() => lapseOf(current))).toBe(1);
    });

    it("anchor: an ordinary terminal's lapse still re-asks", () => {
      const t = transport("m3", "claude:terminal", "claude");
      expect(departures(() => lapseOf(t))).toBe(1);
    });
  });

  it("seam unset or flag off: a spawn's start and teardown change nothing and log nothing", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = () => {
      const a = transport("m1", "spawn:3", "unbound-child");
      const key = `claude:${SPAWN_ID.toLowerCase()}`;
      transport("m5", key, "claude");
      const t = transport("m7", TANDEM_OWNER_ID, "tandem");
      setDocOwner("d1", { ownerId: "spawn:3", kind: "claimed" }, "claim", "spawn:3");
      setDocOwner("d2", { ownerId: key, kind: "opened" }, "take", key);
      const before = JSON.stringify([view, ownershipSnapshotForTests()]);
      const bind = registerSpawn({ handle: `th_${"L".repeat(32)}`, sessionId: SPAWN_ID });
      markSpawnStarted(bind);
      confirmBind({ serial: bind.serial }, "m7");
      noteOwnSpawnStarted({ n: 4, sessionId: SPAWN_ID });
      endSpawn(bind);
      expect(JSON.stringify([view, ownershipSnapshotForTests()])).toBe(before);
      expect(a.ownerId).toBe("spawn:3");
      expect(t.ownerId).toBe(TANDEM_OWNER_ID);
    };
    setOwnSpawnSource(undefined);
    run();
    resetOwnershipForTests();
    view = [];
    setTransportView(() => view);
    setTandemPresenceSource(() => true);
    setOwnSpawnSource(() => spawn, isOwnChild);
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    expect(ownSpawnRoutingActive()).toBe(false);
    // A registry entry as a flag-off server never writes one, so the only
    // thing that could move it is the teardown listener the seam registered.
    const stray: TransportViewEntry = { sessionId: "m7", ownerId: TANDEM_OWNER_ID, openStreams: 0 };
    view.push(stray);
    const bind = registerSpawn({ handle: `th_${"M".repeat(32)}`, sessionId: SPAWN_ID });
    markSpawnStarted(bind);
    confirmBind({ serial: bind.serial }, "m7");
    noteOwnSpawnStarted({ n: 4, sessionId: SPAWN_ID });
    endSpawn(bind);
    expect(stray.ownerId).toBe(TANDEM_OWNER_ID);
    expect(ownershipSnapshotForTests().records).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("the unbound-child refusal and the take guard (#2358 PR 3b-2b3b; design §3.1, §5.3)", () => {
  const SPAWN_ID = "AbCd-Spawn-1";
  const CHILD = "spawn:3";
  const PRIVATE = "private:m3";
  const TERMINAL = "claude:someone-else";

  beforeEach(() => {
    setOwnSpawnSource(
      () => ({ n: 3, sessionId: SPAWN_ID }),
      () => true,
    );
    setTandemPresenceSource(() => true);
    register(CHILD, "unbound-child");
    register(PRIVATE, "child-private");
    register(TERMINAL, "claude");
    setDocOwner("tandems", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "user-open");
  });

  it.each([CHILD, PRIVATE])(
    "%s is refused on Tandem's Claude's document, for a write and a take",
    (caller) => {
      expect(checkWrite("tandems", caller)).toMatchObject({ ok: false, reason: "unbound-child" });
      expect(decideTake("tandems", caller)).toMatchObject({ ok: false, reason: "unbound-child" });
      expect(takeDocument("tandems", caller)).toMatchObject({
        ok: false,
        reason: "unbound-child",
      });
      expect(getDocOwner("tandems")?.ownerId).toBe(TANDEM_OWNER_ID);
      // Even an `opened` one: the copy replaces `held`'s.
      setDocOwner("tandems", { ownerId: TANDEM_OWNER_ID, kind: "opened" }, "take", TANDEM_OWNER_ID);
      expect(checkWrite("tandems", caller)).toMatchObject({ reason: "unbound-child" });
      expect(decideTake("tandems", caller)).toMatchObject({ reason: "unbound-child" });
    },
  );

  it("an ordinary terminal on the same document is answered as before (default, and its take stands)", () => {
    expect(checkWrite("tandems", TERMINAL)).toMatchObject({ ok: false, reason: "default" });
    expect(decideTake("tandems", TERMINAL)).toEqual({ ok: true, next: "opened" });
  });

  it("elsewhere a child record is a terminal: it claims an unowned document and meets another terminal's in the ordinary way", () => {
    expect(checkWrite("nobodys", CHILD)).toEqual({ ok: true, claim: "claimed" });
    expect(decideTake("nobodys", CHILD)).toEqual({ ok: true, next: "opened" });
    setDocOwner("terms", { ownerId: TERMINAL, kind: "opened" }, "take", TERMINAL);
    expect(checkWrite("terms", CHILD)).toMatchObject({ ok: false, reason: "held" });
    expect(decideTake("terms", CHILD)).toMatchObject({ ok: false, reason: "held" });
    setDocOwner("terms", { ownerId: TERMINAL, kind: "claimed" }, "claim", TERMINAL);
    expect(checkWrite("terms", CHILD)).toMatchObject({ ok: false, reason: "claimed" });
    expect(decideTake("terms", CHILD)).toEqual({ ok: true, next: "opened" });
  });

  it("the answered row gives way to it on Tandem's Claude's document, and stands elsewhere", () => {
    recordAnswerer("tandems", "a1", "root", TANDEM_OWNER_ID);
    expect(otherAnswererOf("tandems", "a1", "root", CHILD)).toBeUndefined();
    expect(otherAnswererOf("tandems", "a1", "root", TERMINAL)).toBeDefined();
    recordAnswerer("nobodys", "a1", "root", TERMINAL);
    expect(otherAnswererOf("nobodys", "a1", "root", CHILD)).toBeDefined();
  });

  describe("the message half", () => {
    const rows = new Map<string, ChatMessageFacts>([
      ["docless", { documentOpen: false, localPeriod: false }],
      ["on-tandems", { documentId: "tandems", documentOpen: true, localPeriod: false }],
      ["on-terms", { documentId: "terms", documentOpen: true, localPeriod: false }],
    ]);
    const docs = { isOpen: () => true, activeDocumentId: () => undefined };
    const reply = (ownerId: string, replyTo: string) =>
      inboxOwnership.replyGate({ ownerId }, { replyTo }, docs);

    beforeEach(() => {
      setOwnershipChatSide({
        handledKeys: () => new Set(),
        messagesOn: () => [],
        unhandledKeys: () => [],
        message: (key) => rows.get(key),
        reOwe: () => {},
        settleCandidates: () => [],
        addSettles: () => [],
        owedToFreshReader: () => [],
      });
      setDocOwner("terms", { ownerId: TERMINAL, kind: "opened" }, "take", TERMINAL);
    });

    it.each(["docless", "on-tandems"])(
      "a reply naming a message Tandem's Claude owns (%s) is refused with unbound-child",
      (key) => {
        const gate = reply(CHILD, key);
        expect(gate).toMatchObject({ kind: "refused", code: "NOT_DOC_OWNER" });
        const refused = gate as Extract<typeof gate, { kind: "refused" }>;
        expect(refused.details?.reason).toBe("unbound-child");
        expect(refused.message).toContain("Tandem's Claude answers this message.");
        expect(reply(PRIVATE, key)).toMatchObject({ details: { reason: "unbound-child" } });
        expect(reply(TERMINAL, key)).toMatchObject({ details: { reason: "chat" } });
      },
    );

    it("a reply naming another terminal's message is refused in the ordinary way", () => {
      expect(reply(CHILD, "on-terms")).toMatchObject({ details: { reason: "chat" } });
    });

    it("a post naming Tandem's Claude's document is refused with unbound-child", () => {
      const gate = inboxOwnership.replyGate({ ownerId: CHILD }, { documentId: "tandems" }, docs);
      expect(gate).toMatchObject({ kind: "refused", details: { reason: "unbound-child" } });
    });
  });
});
