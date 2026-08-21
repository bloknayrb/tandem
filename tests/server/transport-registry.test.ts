import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ClosableServer,
  createMcpSessionRegistry,
} from "../../src/server/mcp/transport-registry.js";

/** Minimal stand-in for an McpServer — the registry only ever calls close(). */
function fakeServer(): ClosableServer & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn(async () => {}) };
}

/** Controllable clock so LRU/TTL assertions don't depend on wall time. */
function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createMcpSessionRegistry", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("stores and retrieves sessions by id", async () => {
    const reg = createMcpSessionRegistry();
    const server = fakeServer();
    await reg.add({ sessionId: "s1", server, transport: {} });

    expect(reg.size).toBe(1);
    expect(reg.get("s1")?.server).toBe(server);
    expect(reg.get("nope")).toBeUndefined();
  });

  it("returns undefined for a missing session id rather than throwing", () => {
    // The /mcp route passes the raw header through, which is undefined when the
    // client omits it — that must read as "unknown session", i.e. a 404.
    const reg = createMcpSessionRegistry();
    expect(reg.get(undefined)).toBeUndefined();
  });

  it("keeps sessions independent — adding one never evicts another", async () => {
    // The regression this whole module exists to prevent (#438 §2.1): a second
    // initialize used to tear down the first client's transport.
    const reg = createMcpSessionRegistry();
    const first = fakeServer();
    await reg.add({ sessionId: "s1", server: first, transport: {} });
    await reg.add({ sessionId: "s2", server: fakeServer(), transport: {} });

    expect(reg.size).toBe(2);
    expect(reg.get("s1")).toBeDefined();
    expect(first.close).not.toHaveBeenCalled();
  });

  it("evicts the least-recently-used session when the cap is reached", async () => {
    const c = clock();
    const evicted: Array<[string, string]> = [];
    const reg = createMcpSessionRegistry({
      maxSessions: 2,
      now: c.now,
      onEvicted: (e, reason) => evicted.push([e.sessionId, reason]),
    });

    const oldest = fakeServer();
    await reg.add({ sessionId: "s1", server: oldest, transport: {} });
    c.advance(10);
    await reg.add({ sessionId: "s2", server: fakeServer(), transport: {} });

    // Touch s1 so s2 becomes the LRU — proves eviction tracks recency, not
    // insertion order.
    c.advance(10);
    reg.touch("s1");
    c.advance(10);
    await reg.add({ sessionId: "s3", server: fakeServer(), transport: {} });

    expect(reg.size).toBe(2);
    expect(reg.get("s2")).toBeUndefined();
    expect(reg.get("s1")).toBeDefined();
    expect(oldest.close).not.toHaveBeenCalled();
    expect(evicted).toEqual([["s2", "lru"]]);
  });

  it("replaces rather than stacks when the same session id re-initializes", async () => {
    const reg = createMcpSessionRegistry();
    const first = fakeServer();
    const second = fakeServer();
    await reg.add({ sessionId: "s1", server: first, transport: {} });
    await reg.add({ sessionId: "s1", server: second, transport: {} });

    expect(reg.size).toBe(1);
    expect(first.close).toHaveBeenCalledOnce();
    expect(reg.get("s1")?.server).toBe(second);
  });

  it("reaps only sessions idle past the TTL", async () => {
    const c = clock();
    const reg = createMcpSessionRegistry({ idleTtlMs: 100, now: c.now });
    const stale = fakeServer();
    const fresh = fakeServer();

    await reg.add({ sessionId: "stale", server: stale, transport: {} });
    c.advance(90);
    await reg.add({ sessionId: "fresh", server: fresh, transport: {} });
    c.advance(20); // stale is 110ms idle, fresh is 20ms

    expect(await reg.reapIdle()).toBe(1);
    expect(reg.get("stale")).toBeUndefined();
    expect(reg.get("fresh")).toBeDefined();
    expect(stale.close).toHaveBeenCalledOnce();
    expect(fresh.close).not.toHaveBeenCalled();
  });

  it("touch resets the idle clock so an active session is not reaped", async () => {
    const c = clock();
    const reg = createMcpSessionRegistry({ idleTtlMs: 100, now: c.now });
    await reg.add({ sessionId: "s1", server: fakeServer(), transport: {} });

    c.advance(90);
    reg.touch("s1");
    c.advance(90);

    expect(await reg.reapIdle()).toBe(0);
    expect(reg.get("s1")).toBeDefined();
  });

  it("drops an entry even when its server fails to close", async () => {
    // A server that can't close must not wedge the cap forever.
    const reg = createMcpSessionRegistry();
    const broken: ClosableServer = {
      close: vi.fn(async () => {
        throw new Error("already dead");
      }),
    };
    await reg.add({ sessionId: "s1", server: broken, transport: {} });

    await expect(reg.close("s1")).resolves.toBeUndefined();
    expect(reg.size).toBe(0);
  });

  it("close on an unknown id is a no-op", async () => {
    const reg = createMcpSessionRegistry();
    await expect(reg.close("ghost")).resolves.toBeUndefined();
    expect(reg.size).toBe(0);
  });

  it("closeAll closes every session", async () => {
    const reg = createMcpSessionRegistry();
    const a = fakeServer();
    const b = fakeServer();
    await reg.add({ sessionId: "a", server: a, transport: {} });
    await reg.add({ sessionId: "b", server: b, transport: {} });

    await reg.closeAll();

    expect(reg.size).toBe(0);
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
  });

  it("carries the Claude session id through to lookup", async () => {
    // The registry must carry `claudeSessionId` through add → get. (This was
    // written as "Phases 2-4 key event routing off this"; that plan is on hold
    // — MCP 2026-07-28 removed the session this is keyed by, so #438's routing
    // work must not be built on it. See ADR-045's 2026-07-30 amendment.)
    const reg = createMcpSessionRegistry();
    await reg.add({
      sessionId: "s1",
      server: fakeServer(),
      transport: {},
      claudeSessionId: "claude-abc",
    });
    expect(reg.get("s1")?.claudeSessionId).toBe("claude-abc");
  });

  it("tolerates a session with no Claude session id (direct-HTTP config path)", async () => {
    const reg = createMcpSessionRegistry();
    await reg.add({ sessionId: "s1", server: fakeServer(), transport: {} });
    expect(reg.get("s1")?.claudeSessionId).toBeUndefined();
    expect(reg.list()).toHaveLength(1);
  });
});

describe("open SSE streams pin a session against the reaper", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("does not reap an idle session that still holds a stream open", async () => {
    // The bug: `lastSeenAt` only advances on a dispatched request, so a client
    // attached by a live GET stream and simply making no tool calls looked
    // exactly like one that had been SIGKILLed — and got reaped after 30
    // minutes, breaking Claude Desktop's bridge for the rest of the day.
    const c = clock();
    const reg = createMcpSessionRegistry({ idleTtlMs: 1_000, now: c.now });
    await reg.add({ sessionId: "attached", server: fakeServer(), transport: {} });
    await reg.add({ sessionId: "vanished", server: fakeServer(), transport: {} });
    reg.noteStreamOpened("attached");

    c.advance(5_000);
    expect(await reg.reapIdle()).toBe(1);
    expect(reg.get("attached")).toBeDefined();
    expect(reg.get("vanished")).toBeUndefined();
  });

  it("reaps the same session once its stream closes", async () => {
    const c = clock();
    const reg = createMcpSessionRegistry({ idleTtlMs: 1_000, now: c.now });
    const server = fakeServer();
    await reg.add({ sessionId: "s1", server, transport: {} });
    reg.noteStreamOpened("s1");

    c.advance(5_000);
    expect(await reg.reapIdle()).toBe(0);
    reg.noteStreamClosed("s1");
    expect(await reg.reapIdle()).toBe(1);
    expect(server.close).toHaveBeenCalled();
  });

  it("counts streams rather than flagging them", async () => {
    // A client reconnecting its stream can have the new open observed before
    // the old close. A boolean wedges either at false (reaping a live client)
    // or true (leaking the session); a counter survives the interleaving.
    const c = clock();
    const reg = createMcpSessionRegistry({ idleTtlMs: 1_000, now: c.now });
    await reg.add({ sessionId: "s1", server: fakeServer(), transport: {} });
    reg.noteStreamOpened("s1");
    reg.noteStreamOpened("s1");
    reg.noteStreamClosed("s1");

    c.advance(5_000);
    expect(await reg.reapIdle()).toBe(0);
    reg.noteStreamClosed("s1");
    expect(await reg.reapIdle()).toBe(1);
  });

  it("floors the counter at zero so a duplicate close cannot pin a session", async () => {
    const c = clock();
    const reg = createMcpSessionRegistry({ idleTtlMs: 1_000, now: c.now });
    await reg.add({ sessionId: "s1", server: fakeServer(), transport: {} });
    reg.noteStreamClosed("s1");
    reg.noteStreamClosed("s1");
    expect(reg.get("s1")?.openStreams).toBe(0);

    reg.noteStreamOpened("s1");
    reg.noteStreamClosed("s1");
    c.advance(5_000);
    expect(await reg.reapIdle()).toBe(1);
  });

  it("ignores stream notes for an unknown id", async () => {
    const reg = createMcpSessionRegistry();
    expect(() => reg.noteStreamOpened("ghost")).not.toThrow();
    expect(() => reg.noteStreamClosed("ghost")).not.toThrow();
    expect(reg.size).toBe(0);
  });

  it("seeds a fresh entry with no open streams", async () => {
    const reg = createMcpSessionRegistry();
    await reg.add({ sessionId: "s1", server: fakeServer(), transport: {} });
    expect(reg.get("s1")?.openStreams).toBe(0);
  });

  it("re-adding an existing id resets its stream count", async () => {
    // add() replaces rather than stacks, so the new entry must not inherit the
    // old one's pin — the old transport's close will never be observed.
    const reg = createMcpSessionRegistry();
    await reg.add({ sessionId: "s1", server: fakeServer(), transport: {} });
    reg.noteStreamOpened("s1");
    await reg.add({ sessionId: "s1", server: fakeServer(), transport: {} });
    expect(reg.get("s1")?.openStreams).toBe(0);
  });

  it("keeps LRU eviction deliberately pin-blind", async () => {
    // `lastSeenAt` is evidence of *use*; `openStreams` only of *attachment*.
    // Preferring streams would evict a session used a second ago to preserve
    // one idle for 29 minutes. It is also what stops the pin locking a
    // legitimate client out: the capacity-exceeding initialize still evicts
    // rather than being refused, and the bridge's reconnect makes that
    // eviction recoverable. State the pairing, and pin it.
    const c = clock();
    const evicted: string[] = [];
    const reg = createMcpSessionRegistry({
      maxSessions: 2,
      now: c.now,
      onEvicted: (entry, reason) => {
        if (reason === "lru") evicted.push(entry.sessionId);
      },
    });
    await reg.add({ sessionId: "pinned-but-old", server: fakeServer(), transport: {} });
    reg.noteStreamOpened("pinned-but-old");
    c.advance(1_000);
    await reg.add({ sessionId: "recent", server: fakeServer(), transport: {} });
    c.advance(1_000);
    await reg.add({ sessionId: "newcomer", server: fakeServer(), transport: {} });

    expect(evicted).toEqual(["pinned-but-old"]);
    expect(reg.get("recent")).toBeDefined();
  });
});
