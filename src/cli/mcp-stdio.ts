/**
 * Tandem mcp-stdio subcommand — stdio ↔ Streamable HTTP JSON-RPC proxy.
 *
 * Claude Desktop's plugin loader bridges stdio MCP servers into sandboxed
 * sessions but not HTTP MCP servers, so plugin-cached stdio entries that
 * forward to the local HTTP MCP endpoint are the only supported way to
 * surface tandem_* tools into those sessions.
 *
 * Raw message forwarding: no handler registrations, no per-method logic.
 * Any message the upstream emits (tool results, notifications, future
 * methods we haven't heard of) reaches the stdio client unchanged.
 *
 * Error surfacing (issue #336): the stdio transport is started before
 * preflight and http.start(), and early messages are buffered until the
 * upstream is ready. If the upstream never becomes ready — or dies mid-
 * session — every in-flight request ID is answered with a synthesized
 * `-32000` JSON-RPC error instead of a silent stdio close. Plugin hosts
 * surface `-32000` as actionable; a silent close is what produces "tools
 * never appear in Cowork" with nothing diagnosable in the logs.
 *
 * Re-initialize on a stale upstream session. The HTTP server answers a
 * request whose `Mcp-Session-Id` it no longer holds with `404 -32001`, and
 * ADR-045 chose that status *specifically* so the client would re-handshake;
 * the MCP spec makes it a client MUST. This proxy is the only component that
 * sees it. It used to have no reconnection logic at all, on the theory that
 * the plugin loader respawns us on the next tool call — true for Claude Code,
 * **false for Claude Desktop**, which keeps this child alive all day. So the
 * 404 became an opaque `-32000` and Tandem's tools stayed broken until the
 * user quit and reopened the app.
 *
 * Recovery has to replay a handshake this proxy never owned, because raw
 * forwarding means it holds no protocol state: the client's `initialize` and
 * `notifications/initialized` are captured in flight, then replayed against a
 * freshly-constructed transport under a private `__tandem_reinit_<uuid>` id
 * whose response is swallowed rather than forwarded. `serverInfo` and
 * `protocolVersion` must match what the original handshake negotiated, or the
 * reconnect fails closed — otherwise a different process that grabbed the port
 * would inherit the client's trust.
 *
 * Failure is soft: pending requests get their `-32000`, the queue is cleared,
 * and one capped-exponential retry is armed. We do NOT exit — killing a
 * Claude Desktop child nothing will respawn is the regression this exists to
 * prevent. `shutdown(1)` keeps only its original triggers: stdio death,
 * upstream `onclose`, startup preflight failure.
 */

import { randomUUID } from "node:crypto";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  CLAUDE_SESSION_HEADER,
  redirectConsoleToStderr,
  resolveAuthTokenCandidate,
  resolveClaudeSessionId,
  resolveTandemUrl,
} from "../shared/cli-runtime.js";
import { probeTandemServer } from "./preflight.js";

redirectConsoleToStderr();

// After preflight or http.start() fails we wait ~1.5s for any already-in-
// flight `initialize` from the plugin loader to land on stdin and receive
// a -32000 reply before tear-down. Sizing covers stdin-read lag between
// preflight resolution and first message arrival — independent of
// preflight's own fetch timeout.
const PREFLIGHT_GRACE_MS = 1500;

// Per-request timeout. Node's setTimeout uses a 32-bit signed integer
// internally — values above this constant are silently clamped to 1ms,
// which would make every request immediately synthesize -32000.
const MAX_TIMEOUT_MS = 2_147_483_647; // 2^31 - 1

export function parseTimeoutMs(raw: string | undefined): number {
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_TIMEOUT_MS) {
      return parsed;
    }
    // Note: parseInt("3e4", 10) returns 3 (stops at 'e'), which passes validation.
    // Scientific notation lands here only when the leading integer is invalid.
    process.stderr.write(
      `[tandem mcp-stdio] TANDEM_REQUEST_TIMEOUT_MS must be a positive integer ≤ ${MAX_TIMEOUT_MS}; ignoring "${raw}", using 30000ms default\n`,
    );
  }
  return 30_000;
}

const STDIO_REQUEST_TIMEOUT_MS = parseTimeoutMs(process.env.TANDEM_REQUEST_TIMEOUT_MS);

/**
 * How long the replayed `initialize` may take before the reconnect gives up.
 *
 * A deadline is mandatory, not defensive. Without one, a server whose event
 * loop is wedged (a large `.docx` import, say) accepts the POST and never
 * answers, leaving the reconnect latched forever: every later request queues
 * and times out, and the bridge never recovers even after the server returns.
 * That is strictly worse than the bug being fixed. It also covers a response
 * whose `id` is `null` — a JSON-RPC error — which is not the replay id, gets
 * forwarded downstream by the raw-proxy contract, and would otherwise leave
 * the await hanging.
 *
 * Derived from the request timeout so tests can shrink both at once, capped so
 * a 30-minute `TANDEM_REQUEST_TIMEOUT_MS` cannot wedge a reconnect.
 */
const REPLAY_DEADLINE_MS = Math.min(STDIO_REQUEST_TIMEOUT_MS, 15_000);

/** Reconnect backoff ladder: 1s, doubling, capped. */
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * A session that stayed up longer than this is treated as healthy-then-reaped
 * — reconnect immediately and reset the ladder. Anything shorter escalates,
 * which is what keeps a server that mints-then-immediately-404s from driving a
 * hot loop.
 */
const SESSION_STABLE_MS = 60_000;

/**
 * Cap on messages held during a reconnect. Sized for the sub-second window a
 * reconnect actually takes; overflow still answers `-32000` rather than
 * dropping silently.
 */
const RECONNECT_QUEUE_CAP = 64;

/** JSON-RPC error code the server uses for an unknown `Mcp-Session-Id`. */
const SESSION_NOT_FOUND_CODE = -32001;

/**
 * Did this `send()` rejection come from a 404?
 *
 * Structural (`err.code === 404`), not `instanceof StreamableHTTPError` — that
 * needs a deep import into the SDK's dist and reads false across a duplicated
 * SDK copy, silently, which is the failure class this guard exists for.
 *
 * `.code` is NOT always an HTTP status: the SDK also throws
 * `StreamableHTTPError(-1, "Unexpected content type: …")`. Compare to 404
 * exactly, never `>= 400`.
 */
export function isStaleSessionError(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 404;
}

/**
 * Did that 404 actually carry `-32001 Session not found`?
 *
 * The SDK embeds the response body in the message (`Error POSTing to
 * endpoint: ${text}`), so the body is readable from the rejection. This gates
 * **replay only** — a bare 404 still triggers a reconnect. Splitting the two
 * decisions is what stops any upstream 404 (a reverse proxy, a different app
 * that grabbed the port, a squatter) from getting a mutating tool call
 * re-executed against it. A miss degrades that one call to `-32000`, which is
 * already the fallback for a request that was already dispatched.
 */
export function carriedSessionNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const marker = "Error POSTing to endpoint: ";
  const at = err.message.indexOf(marker);
  if (at === -1) return false;
  try {
    const parsed: unknown = JSON.parse(err.message.slice(at + marker.length));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.some(
      (entry) =>
        (entry as { error?: { code?: unknown } } | null)?.error?.code === SESSION_NOT_FOUND_CODE,
    );
  } catch {
    return false;
  }
}

/**
 * Has the server→client SSE stream terminally failed?
 *
 * Four distinct strings travel this path in the SDK:
 *   1. `Failed to open SSE stream: …`        — the GET itself was refused
 *   2. `SSE stream disconnected: …`          — mid-stream, SDK will retry
 *   3. `Failed to reconnect SSE stream: …`   — a retry failed, more scheduled
 *   4. `Maximum reconnection attempts (N) exceeded.` — terminal
 *
 * Only 1 and 4 match. 2 and 3 are covered by the SDK's own two retries and
 * also fire during an ordinary server restart while it is still down, so
 * reconnecting on them means racing a server that is not back yet. 4 fires
 * exactly once per outage and is the primary trigger; 1 is kept because the
 * very first GET (launched from `send()`'s 202 branch) schedules no retries at
 * all, so 4 can never arrive for it.
 */
export function isSseStreamLostError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("Maximum reconnection attempts (") ||
    err.message.includes("Failed to open SSE stream:")
  );
}

/**
 * Read the upstream's identity out of an `initialize` response, or `undefined`
 * when the message carries no `result` at all (i.e. it is a JSON-RPC error).
 *
 * One reader for both the original handshake and the replayed one, so the two
 * cannot drift on what "the same server" means — which is the entire basis of
 * the fail-closed check on reconnect.
 */
export function readHandshakeIdentity(
  msg: JSONRPCMessage,
): { protocolVersion: string | undefined; serverInfo: string } | undefined {
  const result = (msg as { result?: { protocolVersion?: unknown; serverInfo?: unknown } }).result;
  if (result === undefined) return undefined;
  return {
    protocolVersion:
      typeof result.protocolVersion === "string" ? result.protocolVersion : undefined,
    serverInfo: describeServerInfo(result.serverInfo),
  };
}

/** Private id for the replayed handshake. Prefixed for greppability in logs. */
export function makeReplayId(): string {
  return `__tandem_reinit_${randomUUID()}`;
}

/**
 * Render `serverInfo` for identity comparison across a reconnect. Any shape
 * that isn't a `{name, version}` object collapses to a sentinel, so a server
 * that omits it cannot accidentally compare equal to one that supplies it.
 */
export function describeServerInfo(info: unknown): string {
  const i = info as { name?: unknown; version?: unknown } | null | undefined;
  if (!i || typeof i.name !== "string" || typeof i.version !== "string") return "<unknown>";
  return `${i.name}@${i.version}`;
}

/**
 * The whole reconnect-pacing decision, in one pure function.
 *
 * `lastSessionLifetimeMs` is how long the session that just died had been up,
 * or 0 when none was ever established. Longer than `SESSION_STABLE_MS` means
 * "healthy session, then reaped" — reconnect with no delay (latency is the
 * entire point of the fix) and reset the ladder. Everything else escalates
 * toward the cap.
 *
 * This is a backoff, not a budget: it never *refuses* a reconnect, so the
 * bridge still heals whenever the server comes back, however many restarts it
 * took. A budget would go permanently inert after a handful of `dev:server`
 * saves.
 */
export function nextBackoffMs(
  current: number,
  lastSessionLifetimeMs: number,
): { delayMs: number; nextMs: number } {
  if (lastSessionLifetimeMs > SESSION_STABLE_MS) {
    return { delayMs: 0, nextMs: BACKOFF_INITIAL_MS };
  }
  return { delayMs: current, nextMs: Math.min(current * 2, BACKOFF_MAX_MS) };
}

// Last-gasp handlers for truly unexpected crashes: write one diagnostic to
// stderr before exit. Installed at module load; process.once bounds each
// handler to a single fire. No -32000 synthesis here because pendingRequests
// lives inside runMcpStdio()'s closure.
process.once("uncaughtException", (err: Error) => {
  process.stderr.write(
    `[tandem mcp-stdio] uncaughtException: ${err.message}\n${err.stack ?? ""}\n`,
  );
  process.exit(1);
});
process.once("unhandledRejection", (reason: unknown) => {
  const detail = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[tandem mcp-stdio] unhandledRejection: ${detail}\n`);
  process.exit(1);
});

/** Regex for a valid Tandem auth token (32+ URL-safe alphanumeric chars). */
const VALID_TOKEN_RE = /^[A-Za-z0-9_\-]{32,}$/;

/**
 * Validate the configured auth token if present.
 * Rules (invariant 4):
 * - If not set at all, or if empty/whitespace-only after trim → return null (loopback-only mode).
 * - "Bearer " prefix → exit 1 with "double-prefix" message.
 * - Must match /^[A-Za-z0-9_-]{32,}$/ (no whitespace, no newlines, no Bearer prefix).
 */
export function readAndValidateAuthToken(): string | null {
  const { token, source } = resolveAuthTokenCandidate();
  // Token not set at all, or empty/whitespace-only → loopback-only mode, no auth header, no exit.
  if (token === undefined) return null;
  const trimmed = token.trim();
  if (trimmed === "") return null;

  if (trimmed.startsWith("Bearer ")) {
    process.stderr.write(
      `[tandem mcp-stdio] ${source} is invalid (double-prefix: do not include 'Bearer ' prefix — supply the raw token only)\n`,
    );
    process.exit(1);
  }

  if (!VALID_TOKEN_RE.test(trimmed)) {
    process.stderr.write(
      `[tandem mcp-stdio] ${source} is malformed (must be 32+ URL-safe characters: [A-Za-z0-9_-])\n`,
    );
    process.exit(1);
  }

  return trimmed;
}

export async function runMcpStdio(): Promise<void> {
  const baseUrl = resolveTandemUrl();
  const authToken = readAndValidateAuthToken();

  // Forward the Claude Code session id (when this proxy was spawned by Claude
  // Code) so the HTTP MCP server can correlate tool calls with the session.
  // No-op when not in a Claude Code launch — see resolveClaudeSessionId.
  const sessionId = resolveClaudeSessionId();
  const upstreamHeaders: Record<string, string> = {};
  if (authToken) upstreamHeaders.Authorization = `Bearer ${authToken}`;
  if (sessionId !== undefined) upstreamHeaders[CLAUDE_SESSION_HEADER] = sessionId;

  /**
   * Build an upstream transport. Extracted so a reconnect cannot drift from
   * the original construction (auth header, `X-Claude-Session-Id`).
   *
   * Deliberately passes no `sessionId`: the server mints a fresh one, which is
   * the entire point. The SDK never clears `_sessionId` on a 404 — it is set
   * when a response carries the header and cleared only by `terminateSession()`
   * — so a stale id would be re-sent forever. That is why a *new* transport is
   * required rather than restarting this one, which `close()` cannot undo
   * anyway: it aborts the controller without clearing it, so `start()` throws
   * "already started" on a reused instance.
   */
  function createUpstream(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit:
        Object.keys(upstreamHeaders).length > 0 ? { headers: upstreamHeaders } : undefined,
    });
  }

  let http = createUpstream();
  const stdio = new StdioServerTransport();

  // On upstream failure we synthesize -32000 for every entry before exit.
  // Value is the per-request timeout handle so we can cancel it on response.
  const pendingRequests = new Map<string | number, ReturnType<typeof setTimeout>>();
  // Messages arriving before httpReady flips; either drained and forwarded
  // on success, or each request answered with -32000 on preflight/http-start
  // failure.
  const preReadyBuffer: JSONRPCMessage[] = [];
  let shuttingDown = false;
  let httpReady = false;

  // ---- Reconnect state -----------------------------------------------------
  // No setInterval anywhere below: every timer is a one-shot setTimeout, is
  // .unref()'d, and is cleared in a finally or in shutdown().

  /**
   * Bumped on every transport swap. Every `send().catch` captures the
   * generation it was issued under and returns early if a newer transport has
   * since taken over, so a stale rejection cannot trigger a second reconnect
   * or synthesize an error for a request the new transport is still serving.
   */
  let generation = 0;
  /** The client's `initialize`, captured in flight. Last one wins. */
  let handshakeInit: JSONRPCMessage | undefined;
  /** The client's `notifications/initialized`, if it ever sent one. */
  let handshakeInitialized: JSONRPCMessage | undefined;
  let negotiatedProtocolVersion: string | undefined;
  let negotiatedServerInfo: string | undefined;
  /** Set in the trigger, cleared when the attempt starts. Suppresses duplicate scheduling. */
  let reconnectPending = false;
  /** Set when the attempt begins, cleared in its finally. This is what queueing keys on. */
  let reconnecting = false;
  let backoffMs = BACKOFF_INITIAL_MS;
  /**
   * When the current upstream session was established, or 0 if none ever was.
   * This one variable carries the whole pacing decision, so its write sites are
   * the design: set on the original handshake response and after a successful
   * replay, and reset to 0 whenever an attempt fails. That reset is what makes
   * a stale timestamp unconstructible — without it, a failed reconnect left it
   * reading 30 minutes old, every retry re-passed the "was stable" test, and
   * the bridge hammered a down server at roughly one attempt per second.
   */
  let lastSessionOpenedAt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let replayDeadline: ReturnType<typeof setTimeout> | undefined;
  /**
   * Scalar, not a set: the single-flight latch means there is never more than
   * one in flight, and a set invites widening this to "swallow everything
   * during the window" — which is exactly what must not happen, since anything
   * else on the fresh transport is legitimate traffic to forward.
   */
  let pendingReplayId: string | null = null;
  let replayResolve: ((msg: JSONRPCMessage) => void) | null = null;
  /** Messages held while a reconnect is in flight, replayed in order afterwards. */
  const reconnectQueue: JSONRPCMessage[] = [];
  /** `${generation}:${id}` for requests already replayed once — exactly-once. */
  const noRetryKeys = new Set<string>();

  async function sendErrorResponse(
    id: string | number,
    message: string,
    detail?: string,
  ): Promise<void> {
    const errorResponse: JSONRPCMessage = {
      jsonrpc: "2.0",
      id,
      error: {
        // -32000 is the implementation-defined server error range per
        // JSON-RPC 2.0 §5.1 — upstream unavailability is an application-
        // level condition, not a generic Internal Error.
        code: -32000,
        message,
        ...(detail !== undefined ? { data: { detail } } : {}),
      },
    };
    try {
      await stdio.send(errorResponse);
    } catch (err) {
      // stdio already torn down; log so synth failures during shutdown
      // (e.g., http.onclose racing stdio.onclose) aren't silently dropped —
      // a silent drop here would recreate exactly the failure mode this
      // module exists to prevent.
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[tandem mcp-stdio] failed to send synthesized error for id ${id}: ${detail}\n`,
      );
    }
  }

  /** Arm (or re-arm) the per-request `-32000` deadline for one request id. */
  function armRequestTimer(requestId: string | number): void {
    // Clear any existing timer for this id (duplicate/retry scenario).
    const existing = pendingRequests.get(requestId);
    if (existing) clearTimeout(existing);

    const timeoutHandle = setTimeout(() => {
      // Atomic: delete returns false if synthesizePending already drained the map.
      if (!pendingRequests.delete(requestId)) return;
      void sendErrorResponse(
        requestId,
        "Tandem HTTP upstream not responding (half-open)",
        `No response after ${STDIO_REQUEST_TIMEOUT_MS}ms`,
      );
    }, STDIO_REQUEST_TIMEOUT_MS);
    pendingRequests.set(requestId, timeoutHandle);
  }

  function forwardToUpstream(msg: JSONRPCMessage): void {
    if (shuttingDown) return;
    const requestId = getRequestId(msg);
    if (requestId !== undefined) armRequestTimer(requestId);
    const gen = generation;
    http.send(msg).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tandem mcp-stdio] upstream send failed: ${detail}\n`);
      // A newer transport already took over; this rejection belongs to a
      // session nobody is waiting on any more.
      if (gen !== generation) return;

      if (isStaleSessionError(err)) {
        // Replay is gated more tightly than reconnect. The server emits its
        // 404 in dispatchToSession *before* transport.handleRequest, so a
        // request rejected with -32001 provably had zero side effects and is
        // safe to re-send. A request that was already dispatched when the
        // session died may have executed — replaying `tandem_edit` there would
        // double-mutate the document — so those take the -32000 below.
        const key = `${gen}:${String(requestId)}`;
        const canReplay =
          requestId !== undefined && carriedSessionNotFound(err) && !noRetryKeys.has(key);
        // Trigger first. If it declines — no captured initialize — nothing will
        // ever drain the queue, so the request has to fall through to -32000
        // rather than sit there until its own timer fires.
        const outcome = triggerReconnect(
          canReplay ? "stale session (request queued for replay)" : "stale session",
        );
        if (canReplay && outcome !== "declined") {
          noRetryKeys.add(key);
          // Unshift only for the request that actually started the reconnect:
          // it was issued before anything queued behind it, so it must replay
          // first. A sibling that 404s during the backoff wait goes to the back
          // — unshifting every 404 reverses their order.
          //
          // Deliberately does NOT delete the pendingRequests entry or clear
          // its timer, unlike the unreachable path below. Doing so is the
          // natural way to write this branch, and on its own it would lose the
          // request outright: the drain's `pendingRequests.has(id)` check
          // would read false, skip it as "already answered", and return no
          // response at all. `enqueueForReconnect` re-arms a missing timer as
          // a structural backstop, so it takes removing both to actually lose
          // it — which a mutation test covers.
          enqueueForReconnect(msg, /* front */ outcome === "started");
          return;
        }
      }

      if (requestId !== undefined) {
        const handle = pendingRequests.get(requestId);
        if (handle !== undefined) {
          pendingRequests.delete(requestId);
          clearTimeout(handle);
          void sendErrorResponse(requestId, "Tandem HTTP upstream unreachable", detail);
        }
      }
    });
  }

  /**
   * Hold a message for replay once the reconnect completes.
   *
   * The per-request timer is armed *before* the overflow check, so a dropped
   * message still receives its `-32000` rather than vanishing.
   */
  function enqueueForReconnect(msg: JSONRPCMessage, front = false): void {
    const requestId = getRequestId(msg);
    if (requestId !== undefined && !pendingRequests.has(requestId)) armRequestTimer(requestId);
    if (reconnectQueue.length >= RECONNECT_QUEUE_CAP) {
      process.stderr.write(
        `[tandem mcp-stdio] reconnect queue full (${RECONNECT_QUEUE_CAP}); dropping message\n`,
      );
      return;
    }
    if (front) reconnectQueue.unshift(msg);
    else reconnectQueue.push(msg);
  }

  /**
   * Replay everything held during the reconnect, in order.
   *
   * Must stay synchronous. `for (const m of q) await forward(m)` reintroduces
   * the stranding hole this queue exists to close, because `stdio.onmessage`
   * arrives on a stdin macrotask and would slip in between iterations while
   * `reconnecting` is still latched.
   */
  function drainReconnectQueue(): void {
    for (const msg of reconnectQueue.splice(0)) {
      const requestId = getRequestId(msg);
      // Its timer already fired (or shutdown synthesized for it) while the
      // reconnect ran. A second response for one id is worse than a late
      // failure, so drop it.
      if (requestId !== undefined && !pendingRequests.has(requestId)) continue;
      forwardToUpstream(msg);
    }
  }

  async function synthesizeBuffered(message: string, detail?: string): Promise<void> {
    const buffered = preReadyBuffer.splice(0);
    const ids = buffered
      .map((msg) => getRequestId(msg))
      .filter((id): id is string | number => id !== undefined);
    for (const id of ids) {
      await sendErrorResponse(id, message, detail);
    }
  }

  async function synthesizePending(message: string, detail?: string): Promise<void> {
    if (pendingRequests.size === 0) return;
    const ids = [...pendingRequests.keys()];
    // Synchronous before any await: clear all timers + drain map atomically.
    // Timer callbacks that are already queued observe empty map and return early.
    for (const handle of pendingRequests.values()) clearTimeout(handle);
    pendingRequests.clear();
    await Promise.all(ids.map((id) => sendErrorResponse(id, message, detail)));
  }

  const shutdown = async (
    code = 0,
    synth?: { message: string; detail?: string },
  ): Promise<never> => {
    if (!shuttingDown) {
      shuttingDown = true;
      // Hard deadline: if http.close() or stdio.close() hang (e.g., a half-
      // open upstream holding an SSE GET open), don't let cleanup block the
      // process exit indefinitely. .unref() means this timer doesn't itself
      // keep the event loop alive — fast paths resolve and call process.exit
      // below before the deadline fires; hung paths are forcibly terminated.
      setTimeout(() => process.exit(code), 2_000).unref();
      // Unconditionally drain all pending timers before any await — prevents
      // orphan timers from firing into the half-closed transport during
      // http.close() / stdio.close() awaits. synthesizePending will also
      // drain the map if synth is provided; the clearTimeout calls here are
      // defensive for the synth=undefined path (e.g., clean stdio.onclose).
      for (const handle of pendingRequests.values()) clearTimeout(handle);
      // Reconnect timers too — both are .unref()'d so neither can delay exit,
      // but a retry firing into a half-closed transport during the close()
      // awaits below would write confusing diagnostics for an already-decided
      // shutdown.
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      clearReplayDeadline();
      reconnectQueue.splice(0);
      if (synth) {
        await synthesizeBuffered(synth.message, synth.detail);
        await synthesizePending(synth.message, synth.detail);
      }
      await http.close().catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[tandem mcp-stdio] http.close failed: ${detail}\n`);
      });
      await stdio.close().catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[tandem mcp-stdio] stdio.close failed: ${detail}\n`);
      });
    }
    process.exit(code);
  };

  // Plugin hosts typically send `initialize` immediately after spawn (MCP
  // lifecycle §initialization). Deferring shutdown by PREFLIGHT_GRACE_MS
  // lets that request land during the preflight/start window and receive
  // a -32000 reply rather than a silent stdio close. stdio.onclose
  // short-circuits this if the loader closes stdin first.
  function deferredShutdown(synth: { message: string; detail?: string }): void {
    setTimeout(() => void shutdown(1, synth), PREFLIGHT_GRACE_MS);
  }

  /**
   * Record the client's half of the handshake so it can be replayed later.
   * Runs before the `httpReady` check, so a handshake that lands during the
   * preflight window is captured too.
   */
  function captureHandshake(msg: JSONRPCMessage): void {
    const method = (msg as { method?: unknown }).method;
    if (method === "initialize") handshakeInit = msg;
    else if (method === "notifications/initialized") handshakeInitialized = msg;
  }

  /** Record the server's half — what a later reconnect must match. */
  function captureNegotiated(msg: JSONRPCMessage): void {
    if (negotiatedProtocolVersion !== undefined) return;
    const identity = readHandshakeIdentity(msg);
    if (identity?.protocolVersion === undefined) return;
    negotiatedProtocolVersion = identity.protocolVersion;
    negotiatedServerInfo = identity.serverInfo;
    lastSessionOpenedAt = Date.now();
  }

  stdio.onmessage = (msg: JSONRPCMessage) => {
    captureHandshake(msg);
    if (!httpReady) {
      preReadyBuffer.push(msg);
      return;
    }
    // Ordering: this branch sits AFTER the httpReady check. `httpReady` stays
    // true across a reconnect and must never be reset to false — that would
    // route stdin into the one-shot preReadyBuffer, which is only ever drained
    // once, at startup.
    if (reconnecting) {
      enqueueForReconnect(msg);
      return;
    }
    forwardToUpstream(msg);
  };

  const upstreamMessageHandler = (msg: JSONRPCMessage) => {
    if (shuttingDown) return;
    // Synchronous delete+clear FIRST — before stdio.send — to prevent the
    // per-request timer from firing in the window between response arrival
    // and stdio write completion (which would synthesize a false -32000 for
    // an id that already has a real response in flight).
    const responseId = getResponseId(msg);
    // The replayed handshake's response is ours, not the client's: the client
    // never issued this id and would have no idea what to do with it. Swallow
    // exactly this one id — everything else arriving on a fresh transport is
    // legitimate upstream traffic the raw-proxy contract must forward.
    if (pendingReplayId !== null && responseId === pendingReplayId) {
      replayResolve?.(msg);
      return;
    }
    captureNegotiated(msg);
    if (responseId !== undefined) {
      const handle = pendingRequests.get(responseId);
      if (handle !== undefined) {
        clearTimeout(handle);
        pendingRequests.delete(responseId);
      }
    }
    const sendHandler = (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[tandem mcp-stdio] stdio write failed for id ${responseId ?? "<notification>"}: ${detail}\n`,
      );
      // Map entry already deleted above. Synthesize directly for this id,
      // then tear down — stdio is broken so other pending requests can't
      // be delivered either.
      if (responseId !== undefined) {
        void sendErrorResponse(responseId, "Tandem stdio write failed", detail);
      }
      void shutdown(1, {
        message: "Tandem stdio write failed",
        detail,
      });
    };
    try {
      stdio.send(msg).catch(sendHandler);
    } catch (err) {
      sendHandler(err);
    }
  };

  stdio.onerror = (err) => {
    process.stderr.write(`[tandem mcp-stdio] stdio error: ${err.message}\n${err.stack ?? ""}\n`);
  };

  stdio.onclose = () => {
    void shutdown(0);
  };

  /**
   * Attach our handlers to an upstream transport. Called for the initial one
   * and for every replacement, so the two cannot drift apart.
   */
  function wireUpstream(transport: StreamableHTTPClientTransport, gen: number): void {
    transport.onmessage = upstreamMessageHandler;

    transport.onerror = (err) => {
      const cause = (err as { cause?: unknown }).cause;
      process.stderr.write(
        `[tandem mcp-stdio] http error: ${err.message}\n${err.stack ?? ""}${cause !== undefined ? `\ncause: ${cause}` : ""}\n`,
      );
      if (gen !== generation || shuttingDown) return;
      // Predicate order is load-bearing. A GET that 404s satisfies BOTH
      // predicates (the SDK throws StreamableHTTPError(404, "Failed to open
      // SSE stream: …")), and taking the 404 branch for it would look for a
      // request to replay that does not exist.
      if (isSseStreamLostError(err)) {
        triggerReconnect("SSE stream lost");
        return;
      }
      // A POST 404 also lands here — one 404, two signals. Log only: the
      // send() rejection is authoritative because it carries the message.
    };

    transport.onclose = () => {
      // The SDK fires onclose unconditionally from inside close(), so a
      // reconnect MUST unwire this before closing the old transport or the
      // first swap kills the bridge.
      //
      // The synth branch is defensive for an SDK version that propagates
      // socket-death as onclose. The `shuttingDown` guard prevents double-synth
      // when shutdown() calls http.close() itself.
      if (shuttingDown || gen !== generation) return;
      void shutdown(1, {
        message: "Tandem HTTP upstream closed unexpectedly",
        detail: "upstream connection dropped mid-session",
      });
    };
  }

  wireUpstream(http, generation);

  /**
   * Decide whether to reconnect now or after a backoff, and arm it.
   *
   * Returns early on `reconnectPending || reconnecting` — both, not just the
   * first. One reap produces four to six `onerror` calls over a couple of
   * seconds (a single GET failure alone fires it twice), and a trigger arriving
   * after an attempt has already started would otherwise begin a concurrent
   * reconnect against the transport the first one is still building.
   */
  function triggerReconnect(reason: string): "started" | "already" | "declined" {
    if (shuttingDown) return "declined";
    // A reconnect is already coming — the caller may still queue for it, but it
    // is NOT the request that triggered one, so it queues at the back.
    if (reconnectPending || reconnecting) return "already";
    if (handshakeInit === undefined) {
      // Guessing a handshake is worse than failing one. Without the client's
      // own `initialize` we cannot faithfully re-negotiate capabilities, and a
      // fabricated one would hand the client a session it never agreed to.
      process.stderr.write(
        `[tandem mcp-stdio] upstream session is stale (${reason}) but no client initialize was captured; not re-initializing\n`,
      );
      return "declined";
    }
    reconnectPending = true;
    const lifetimeMs = lastSessionOpenedAt === 0 ? 0 : Date.now() - lastSessionOpenedAt;
    const { delayMs, nextMs } = nextBackoffMs(backoffMs, lifetimeMs);
    backoffMs = nextMs;
    if (delayMs === 0) {
      void runReconnect(reason);
      return "started";
    }
    process.stderr.write(
      `[tandem mcp-stdio] upstream session lost (${reason}); re-initializing in ${delayMs}ms\n`,
    );
    armReconnectRetry(delayMs, reason);
    return "started";
  }

  /**
   * Arm the one-shot reconnect retry. Three invariants ride on this and each is
   * silently breakable, so they live here rather than at both call sites: clear
   * any existing handle first, null it from inside the callback, and `.unref()`
   * so it can never hold the process open.
   *
   * Distinct from `armRequestTimer`, which is the per-request `-32000` deadline
   * and unrelated.
   */
  function armReconnectRetry(delayMs: number, reason: string): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void runReconnect(reason);
    }, delayMs);
    retryTimer.unref();
  }

  /** Cancel the replay deadline, if one is armed. */
  function clearReplayDeadline(): void {
    if (replayDeadline) {
      clearTimeout(replayDeadline);
      replayDeadline = undefined;
    }
  }

  /**
   * Await the replayed handshake's response under a deadline.
   *
   * `pendingReplayId` is assigned synchronously inside the executor, so it is
   * in place before the caller sends — a response cannot arrive first and be
   * forwarded downstream by mistake.
   */
  function awaitReplayResponse(replayId: string): Promise<JSONRPCMessage> {
    return new Promise<JSONRPCMessage>((resolve, reject) => {
      pendingReplayId = replayId;
      replayResolve = resolve;
      replayDeadline = setTimeout(() => {
        reject(new Error(`re-initialize timed out after ${REPLAY_DEADLINE_MS}ms`));
      }, REPLAY_DEADLINE_MS);
      replayDeadline.unref();
    });
  }

  /**
   * Swap in a fresh upstream transport and replay the handshake onto it.
   *
   * Never throws: a failure is soft (see the catch) because the alternative —
   * exiting — kills a Claude Desktop child that will not be respawned, which
   * is the exact regression this whole change exists to prevent.
   */
  async function runReconnect(reason: string): Promise<void> {
    if (shuttingDown || reconnecting) return;
    const init = handshakeInit;
    if (init === undefined) return;
    reconnectPending = false;
    reconnecting = true;
    const replayId = makeReplayId();

    try {
      generation += 1;
      const old = http;
      // The SDK's close() calls onclose unconditionally and our onclose is
      // shutdown(1), so closing the old transport must not reach it or the
      // very first reconnect kills the bridge. Two things stop that, and the
      // `generation += 1` above is the effective one — the handlers close over
      // the generation they were wired under and bail when it moves. Unwiring
      // is the belt: it also drops a slow in-flight response or error from a
      // transport nobody is listening to any more. Removing *both* is what
      // reintroduces the bug; a mutation test covers the pair.
      old.onclose = undefined;
      old.onerror = undefined;
      old.onmessage = undefined;
      await old.close().catch(() => {});

      const fresh = createUpstream();
      wireUpstream(fresh, generation);
      // Promote BEFORE start() and before the handshake, deliberately. The
      // "defensive" alternative — promote only once the handshake succeeds —
      // leaves `http` pointing at the *closed* old transport on any failure,
      // and every send() on a closed transport rejects with an AbortError that
      // carries no `.code`. Requests issued before the retry timer fires would
      // then never reach the server at all and could not re-trigger a
      // reconnect, where a session-less-but-live transport 404s and does. The
      // retry still eventually rescues either shape, so this is a window, not
      // a cliff — but it is the window a user's next tool call lands in. A
      // test fails if the assignment moves.
      http = fresh;
      await fresh.start();

      const pendingResponse = awaitReplayResponse(replayId);
      const sent = fresh.send({ ...(init as object), id: replayId } as JSONRPCMessage);
      // The deadline has to bound the POST as well as the wait for its answer.
      // A server that accepts the connection and never responds leaves `send`
      // pending forever — awaiting it first would mean the deadline's rejection
      // is never observed and `reconnecting` latches for good, which is the
      // precise failure the deadline exists to prevent.
      //
      // No explicit `.catch` on either input: Promise.race subscribes to every
      // input it is given, so a losing rejection is delivered to the race's own
      // reaction rather than to the module's `unhandledRejection` handler
      // (which would exit 1). `sent` is covered through the `.then` reaction.
      // The deadline-fires-while-the-POST-hangs test asserts the child stays
      // alive, so this is checked rather than assumed.
      const response = await Promise.race([sent.then(() => pendingResponse), pendingResponse]);

      const identity = readHandshakeIdentity(response);
      if (identity === undefined) {
        throw new Error(
          `upstream rejected re-initialize: ${JSON.stringify((response as { error?: unknown }).error)}`,
        );
      }
      // Fail closed on an identity change. Before this change a substituted
      // upstream could not complete a session at all, because the bridge never
      // re-handshaked; reconnecting turns that fail-closed into fail-open
      // unless the new server is checked against what the client agreed to.
      if (
        identity.protocolVersion !== negotiatedProtocolVersion ||
        identity.serverInfo !== negotiatedServerInfo
      ) {
        throw new Error(
          `upstream identity changed across re-initialize ` +
            `(was ${negotiatedProtocolVersion}/${negotiatedServerInfo}, ` +
            `now ${identity.protocolVersion}/${identity.serverInfo})`,
        );
      }

      // Re-opens the server→client SSE stream: the SDK starts it only from the
      // `initialized` notification's 202 branch, so skipping this would leave
      // the new session with no way to push anything.
      await fresh.send(
        handshakeInitialized ?? { jsonrpc: "2.0", method: "notifications/initialized" },
      );
      lastSessionOpenedAt = Date.now();

      // The replay's response — capabilities, serverInfo, instructions — is
      // swallowed by design, but a server restart is exactly when the tool set
      // can change. Without this nudge a newly-added tandem_* tool stays
      // invisible to the host and a removed one stays callable.
      void stdio
        .send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[tandem mcp-stdio] tools/list_changed notify failed: ${detail}\n`);
        });

      // The generation key already makes these unreachable; clearing bounds
      // the set's growth over a day-long session.
      noRetryKeys.clear();
      // Synchronous, and before the finally clears `reconnecting`, so no
      // message is ever neither queued nor sent.
      drainReconnectQueue();
      process.stderr.write(`[tandem mcp-stdio] upstream session re-initialized (${reason})\n`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tandem mcp-stdio] re-initialize failed: ${detail}\n`);
      // Soft give-up: answer what is outstanding and stay alive.
      //
      // Deliberately does NOT close the fresh transport. wireUpstream set its
      // onclose to shutdown(1) and close() fires onclose unconditionally, so
      // "tidy up the failed transport" would kill the bridge. Leaving it
      // installed is also the recovery lane: a transport holding no session id
      // gets a 404 on its next POST, which re-triggers this.
      reconnectQueue.splice(0);
      await synthesizePending("Tandem HTTP upstream session lost", detail);
      // Reset first, so the retry below cannot read a stale timestamp and
      // decide it was a long-lived session that deserves an immediate retry.
      lastSessionOpenedAt = 0;
      const { delayMs, nextMs } = nextBackoffMs(backoffMs, 0);
      backoffMs = nextMs;
      // Escalation happens here, not in triggerReconnect: the timer callback
      // enters runReconnect directly, so without this a purely-listening client
      // — one with no tool traffic to re-trigger on — would retry flat at 1s
      // forever. That client is the whole reason a retry exists at all: with no
      // GET stream and no timer, its wake channel stays dark until the host
      // restarts.
      process.stderr.write(`[tandem mcp-stdio] re-initializing in ${delayMs}ms\n`);
      armReconnectRetry(delayMs, "retry after failed re-initialize");
    } finally {
      clearReplayDeadline();
      pendingReplayId = null;
      replayResolve = null;
      reconnecting = false;
    }
  }

  // Start stdio BEFORE preflight so any `initialize` that arrives during
  // the preflight window is captured and either forwarded once upstream is
  // ready, or answered with -32000 if upstream never comes up.
  await stdio.start();

  // The SDK's StdioServerTransport watches stdin for 'data' and 'error' only —
  // it does not call onclose when the plugin host closes stdin (EOF). Register
  // our own one-shot listener so that plugin-host close (stdin.end() / HUP)
  // triggers the same clean shutdown path as stdio.onclose does.
  process.stdin.once("end", () => {
    void shutdown(0);
  });

  const probe = await probeTandemServer({ url: baseUrl });
  if (!probe.ok) {
    const guidance =
      probe.kind === "unreachable"
        ? "Start the Tauri app or run `tandem start` on the host, then retry."
        : "The Tandem server is running but unhealthy — check the host logs.";
    process.stderr.write(
      `[tandem mcp-stdio] Tandem server preflight failed at ${probe.url} (${probe.reason}).\n` +
        `[tandem mcp-stdio] ${guidance}\n`,
    );
    const synthMessage =
      probe.kind === "unreachable"
        ? "Tandem server not running. Start the Tauri app or run `tandem start`."
        : "Tandem server unhealthy (check host logs).";
    deferredShutdown({ message: synthMessage, detail: probe.reason });
    return;
  }

  // The current @modelcontextprotocol/sdk's StreamableHTTPClientTransport.start()
  // only creates an AbortController and returns synchronously — this catch is
  // defensive for future SDK versions that may perform real I/O during start().
  try {
    await http.start();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[tandem mcp-stdio] upstream http start failed: ${detail}\n`);
    deferredShutdown({ message: "Tandem HTTP upstream failed to start", detail });
    return;
  }
  httpReady = true;

  // Held to preserve forwarding semantics — push through the normal path
  // now that upstream is ready. Note: forwardToUpstream does not await the
  // http.send, so buffered requests POST in parallel. Plugin hosts wait
  // for `initialize` to resolve before sending follow-ups per MCP spec, so
  // the buffer is usually ≤1 entry; we don't enforce serial ordering here.
  // NOTE: that bound is a property of the handshake, which MCP `2026-07-28`
  // removes — a client on that revision has no initialize to serialize behind,
  // so the "usually ≤1" premise for leaving this unordered expires with it.
  const buffered = preReadyBuffer.splice(0);
  for (const msg of buffered) forwardToUpstream(msg);
}

export function getRequestId(msg: JSONRPCMessage): string | number | undefined {
  const m = msg as { id?: unknown; method?: unknown };
  if (typeof m.method !== "string") return undefined;
  if (typeof m.id === "string" || typeof m.id === "number") return m.id;
  return undefined;
}

export function getResponseId(msg: JSONRPCMessage): string | number | undefined {
  const m = msg as { id?: unknown; method?: unknown };
  if (typeof m.method === "string") return undefined;
  if (typeof m.id === "string" || typeof m.id === "number") return m.id;
  return undefined;
}
