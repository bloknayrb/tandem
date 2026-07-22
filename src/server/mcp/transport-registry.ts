/**
 * Registry of live MCP transport sessions, keyed by `Mcp-Session-Id`.
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
 * closed laptop).
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
  add(entry: Omit<McpSessionEntry<S, T>, "createdAt" | "lastSeenAt">): Promise<void>;
  /** Look up a session without touching its idle clock. */
  get(sessionId: string | undefined): McpSessionEntry<S, T> | undefined;
  /** Mark a session as active now. Call on every request that resolves to it. */
  touch(sessionId: string): void;
  /** Close and drop one session. Safe to call for an unknown id. */
  close(sessionId: string): Promise<void>;
  /** Close and drop every session that has been idle past the TTL. */
  reapIdle(): Promise<number>;
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
          `[Tandem] MCP session cap (${maxSessions}) reached — evicting least-recently-used session ${victim.sessionId}`,
        );
        await closeEntry(victim, "lru");
      }

      const stamp = now();
      sessions.set(entry.sessionId, { ...entry, createdAt: stamp, lastSeenAt: stamp });
    },

    get(sessionId) {
      if (sessionId === undefined) return undefined;
      return sessions.get(sessionId);
    },

    touch(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry) entry.lastSeenAt = now();
    },

    async close(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry) await closeEntry(entry, "explicit");
    },

    async reapIdle() {
      const cutoff = now() - idleTtlMs;
      const stale = [...sessions.values()].filter((e) => e.lastSeenAt < cutoff);
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
