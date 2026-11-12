import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_DESKTOP_CLIENT_NAME } from "../../src/server/mcp/transport-registry.js";
import { getMcpContext, runWithMcpContext } from "../../src/server/sessions/context.js";
import {
  CLAUDE_CODE_CLIENT_NAME,
  DEFAULT_GRACE_MS,
  displayKindOf,
  getDocOwner,
  getOwnerRecord,
  getOwnershipTransportMode,
  LOCAL_OWNER_ID,
  MAX_DETACHED_RECORDS,
  noteRecordPoll,
  noteTransportChanged,
  noteTransportRegistered,
  type OwnerRecord,
  ownershipSnapshotForTests,
  recordHoldsState,
  resetOwnershipForTests,
  resolveTransportRecord,
  setDocOwner,
  setOwnershipSeqSource,
  setOwnershipTransportMode,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
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
    };
    expect(Object.keys(full).sort()).toEqual([
      "clientName",
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

  it("step 5 asks whether items wait only for Tandem's Claude, not on its own change or a take-back", () => {
    const probe = vi.fn(() => false);
    setWaitingProbe(probe);
    setDocOwner("d1", { ownerId: "claude:a", kind: "claimed" }, "user-open");
    setDocOwner("d2", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "user-open", TANDEM_OWNER_ID);
    setDocOwner("d3", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "take-back");
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
