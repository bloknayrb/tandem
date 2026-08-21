/**
 * Registry of live MCP transport sessions, keyed by `Mcp-Session-Id`.
 *
 * **Scope note (2026-07-30).** MCP `2026-07-28` removes protocol-level sessions
 * and the `Mcp-Session-Id` header, so everything below describes what is now the
 * *legacy* branch. It is not dead code on a deprecation clock: the revision lets
 * a server serve both eras concurrently, and legacy clients have no fall-forward,
 * so this branch has to keep working for as long as un-upgraded clients exist.
 * What it is not is the destination design. See ADR-045's 2026-07-30 amendment —
 * in particular, "one `McpServer`, no registry" is NOT the established stateless
 * shape, because the `Protocol.connect()` constraint below is an SDK property
 * that the spec change does not touch.
 *
 * Replaces the single module-level `currentTransport` that made Tandem a
 * one-client server: every `initialize` used to tear down the previous
 * transport, so the second Claude Code session to start evicted the first
 * one's tool channel (the SDK then 404s the evicted client's requests, which
 * carry a now-unknown session id). See `docs/spikes/per-client-identity-spec.md`
 * §2.1 / §3.2 (issue #438).
 *
 * The SDK already mints a per-session id we were throwing away — this module is
 * the "stop throwing it away" half. Two facts from the SDK shape the design:
 *
 *  1. **One `McpServer` cannot serve two live transports.**
 *     `shared/protocol.js`'s `connect()` throws "Already connected to a
 *     transport" when `this._transport` is set. So each session owns its own
 *     `McpServer` instance — the spec's "Shape 2". Tool registration is pure
 *     and cheap, so this costs little.
 *  2. **`transport.sessionId` is not assigned at construction.** It is minted
 *     while the transport *handles* the initialize request, so an entry can
 *     only be keyed from the `onsessioninitialized` callback, not immediately
 *     after `connect()`. Callers own that ordering; this module just stores
 *     what it's given.
 *
 * This module is deliberately a plain store with no SDK construction in it, so
 * the cap/TTL/lookup rules are unit-testable against fakes. The
 * create-connect-promote wiring lives at the `/mcp` route in `server.ts`.
 *
 * A reaper is **required, not optional** (spec §6.4): the single-transport model
 * never needed one because there was only ever one entry, but a map grows for
 * every client that vanishes without sending `DELETE /mcp` (crash, SIGKILL,
 * closed laptop). It reaps on idleness **and** on having no open SSE stream:
 * idleness alone cannot tell "vanished" from "attached but quiet", and quiet is
 * the normal state of a long-lived desktop client between tool calls.
 */

/** Minimal structural type — the registry only ever closes a session's server. */
export interface ClosableServer {
  close(): Promise<void>;
}

export interface McpSessionEntry<S extends ClosableServer = ClosableServer, T = unknown> {
  /** The SDK-minted `Mcp-Session-Id` this entry is keyed by. */
  sessionId: string;
  server: S;
  transport: T;
  /**
   * The calling Claude Code session id, when the transport carried an
   * `X-Claude-Session-Id` header at initialize time. Absent for direct-HTTP
   * `.mcp.json` entries — see `sessions/context.ts`.
   */
  claudeSessionId?: string;
  createdAt: number;
  lastSeenAt: number;
  /**
   * How many standalone `GET /mcp` SSE streams this session currently holds
   * open. Non-zero pins the entry against `reapIdle()` — see the reaper.
   *
   * A **counter, not a boolean**: a client that reconnects its stream can have
   * the new open observed before the old close, and an unbalanced boolean
   * wedges either at `false` (reaping a live client) or `true` (leaking the
   * session). It lives on the entry rather than in a side map in `server.ts`
   * so it dies with the entry instead of leaking one record per closed session.
   */
  openStreams: number;
}

export interface McpSessionRegistryOptions<S extends ClosableServer, T> {
  /**
   * Hard cap on concurrent sessions. Reaching it evicts the least-recently-used
   * entry rather than refusing the new one: a refused `initialize` looks like a
   * broken server to a user who just opened a legitimate session, whereas
   * evicting an LRU entry degrades the same way the old single-transport code
   * did — except it now takes 16 sessions to get there instead of 2.
   */
  maxSessions?: number;
  /** Idle time after which `reapIdle()` closes a session. */
  idleTtlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Called whenever a session is dropped, for logging/diagnostics. */
  onEvicted?: (entry: McpSessionEntry<S, T>, reason: "lru" | "idle" | "explicit") => void;
}

export interface McpSessionRegistry<S extends ClosableServer = ClosableServer, T = unknown> {
  /**
   * Store a freshly-initialized session, evicting the LRU entry first if the
   * cap is reached. Async because eviction closes the evicted server.
   */
  add(
    entry: Omit<McpSessionEntry<S, T>, "createdAt" | "lastSeenAt" | "openStreams">,
  ): Promise<void>;
  /** Look up a session without touching its idle clock. */
  get(sessionId: string | undefined): McpSessionEntry<S, T> | undefined;
  /** Mark a session as active now. Call on every request that resolves to it. */
  touch(sessionId: string): void;
  /**
   * Record that a standalone SSE stream opened on this session, pinning it
   * against the idle reaper. No-op for an unknown id.
   */
  noteStreamOpened(sessionId: string): void;
  /**
   * Record that a standalone SSE stream closed. Floored at 0, so a duplicate
   * close (or one arriving after the entry was replaced) cannot drive the
   * count negative and pin the session forever. No-op for an unknown id.
   */
  noteStreamClosed(sessionId: string): void;
  /** Close and drop one session. Safe to call for an unknown id. */
  close(sessionId: string): Promise<void>;
  /**
   * Close and drop every session that has been idle past the TTL and holds no
   * open SSE stream.
   *
   * `idleTtlMsOverride` exists so a caller can force the pass to consider
   * everything stale — the same reason the clock is injectable. Production
   * always omits it.
   */
  reapIdle(idleTtlMsOverride?: number): Promise<number>;
  /** Close and drop everything (graceful shutdown). */
  closeAll(): Promise<void>;
  /** Live session count — backs `/health`'s `hasSession`. */
  readonly size: number;
  /** Snapshot for diagnostics and the connected-sessions surface. */
  list(): ReadonlyArray<McpSessionEntry<S, T>>;
}

const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function createMcpSessionRegistry<S extends ClosableServer, T>(
  opts: McpSessionRegistryOptions<S, T> = {},
): McpSessionRegistry<S, T> {
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const sessions = new Map<string, McpSessionEntry<S, T>>();

  /**
   * Close a server without letting a rejection escape. A failed close still
   * drops the entry: keeping an unclosable session in the map would wedge the
   * cap forever, and the caller has no useful recovery either way.
   */
  async function closeEntry(
    entry: McpSessionEntry<S, T>,
    reason: "lru" | "idle" | "explicit",
  ): Promise<void> {
    sessions.delete(entry.sessionId);
    try {
      await entry.server.close();
    } catch (err) {
      console.error(
        `[Tandem] Failed to close MCP session ${entry.sessionId} (${reason}):`,
        err instanceof Error ? err.message : err,
      );
    }
    opts.onEvicted?.(entry, reason);
  }

  /** Edge-trigger for the pinned-skip log in `reapIdle` — see the comment there. */
  let lastPinnedSkipCount = 0;

  function lruEntry(): McpSessionEntry<S, T> | undefined {
    let oldest: McpSessionEntry<S, T> | undefined;
    for (const entry of sessions.values()) {
      if (!oldest || entry.lastSeenAt < oldest.lastSeenAt) oldest = entry;
    }
    return oldest;
  }

  return {
    async add(entry) {
      // Re-initialize on an id we already hold: replace rather than stack, so a
      // client that re-handshakes can't hold two servers open.
      const existing = sessions.get(entry.sessionId);
      if (existing) await closeEntry(existing, "explicit");

      while (sessions.size >= maxSessions) {
        const victim = lruEntry();
        if (!victim) break;
        console.error(
          `[Tandem] MCP session cap (${maxSessions}) reached — evicting least-recently-used session ` +
            `${victim.sessionId} (${victim.openStreams} open stream(s))`,
        );
        await closeEntry(victim, "lru");
      }

      const stamp = now();
      sessions.set(entry.sessionId, {
        ...entry,
        createdAt: stamp,
        lastSeenAt: stamp,
        openStreams: 0,
      });
    },

    get(sessionId) {
      if (sessionId === undefined) return undefined;
      return sessions.get(sessionId);
    },

    touch(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry) entry.lastSeenAt = now();
    },

    noteStreamOpened(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry) entry.openStreams += 1;
    },

    noteStreamClosed(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry) entry.openStreams = Math.max(0, entry.openStreams - 1);
    },

    async close(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry) await closeEntry(entry, "explicit");
    },

    async reapIdle(idleTtlMsOverride) {
      const cutoff = now() - (idleTtlMsOverride ?? idleTtlMs);
      // `openStreams === 0` is load-bearing, not belt-and-braces. `lastSeenAt`
      // only advances in `dispatchToSession`, so a client holding a live GET
      // SSE stream and simply making no tool calls was indistinguishable from
      // one that had been SIGKILLed — and got reaped after 30 minutes, which
      // is what broke Claude Desktop's bridge for the rest of the day. The
      // reaper exists for clients that vanished (crash, SIGKILL, closed
      // laptop); an attached one is none of those.
      const expired = [...sessions.values()].filter((e) => e.lastSeenAt < cutoff);
      const stale = expired.filter((e) => e.openStreams === 0);
      // Narrate the skip, but only on a change. A session that outlives its
      // TTL now looks, from the log alone, exactly like a reaper that stopped
      // running — and "sessions accumulate and are never reaped" is the one
      // new failure mode the pin can produce, bounded only by `maxSessions`.
      //
      // Edge-triggered, not level-triggered: an attached-and-quiet desktop
      // bridge is the *normal* steady state this fix exists to protect, and
      // this pass runs every five minutes, so logging the condition each time
      // would print a line every five minutes for the rest of the day.
      const pinned = expired.length - stale.length;
      if (pinned !== lastPinnedSkipCount) {
        lastPinnedSkipCount = pinned;
        if (pinned > 0) {
          console.error(
            `[Tandem] ${pinned} MCP session(s) past the idle TTL but pinned by an open stream — not reaping`,
          );
        }
      }
      for (const entry of stale) {
        console.error(`[Tandem] Reaping idle MCP session ${entry.sessionId}`);
        await closeEntry(entry, "idle");
      }
      return stale.length;
    },

    async closeAll() {
      const all = [...sessions.values()];
      for (const entry of all) await closeEntry(entry, "explicit");
    },

    get size() {
      return sessions.size;
    },

    list() {
      return [...sessions.values()];
    },
  };
}
