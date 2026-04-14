/**
 * Tandem Monitor — Claude Code plugin monitor script.
 *
 * Connects to the Tandem server's /api/events SSE endpoint and prints
 * formatted event lines to stdout. Each line becomes a Claude Code
 * notification automatically via the plugin monitor mechanism.
 *
 * Replaces the channel shim for event delivery without requiring
 * --dangerously-load-development-channels.
 *
 * **STDOUT IS RESERVED** (CLAUDE.md rule #3). The only writes to stdout are
 * the formatted event notification inside `connectAndStream` and the
 * exhaustion notice inside `main`. Everything else — including anything that
 * would otherwise call `console.log/warn/info` — is redirected to stderr by
 * the guard immediately below this comment. When adding a new dependency,
 * grep its source for `process.stdout.write` and `console.log` before
 * accepting; a stdout-writing dep bundled into this file would corrupt the
 * plugin-host line protocol silently.
 */

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { TandemEvent } from "../server/events/types.js";
import { formatEventContent, parseTandemEvent } from "../server/events/types.js";
import {
  CHANNEL_MAX_RETRIES,
  CHANNEL_RETRY_DELAY_MS,
  DEFAULT_MCP_PORT,
  TANDEM_MODE_DEFAULT,
} from "../shared/constants.js";
import { type TandemMode, TandemModeSchema } from "../shared/types.js";

const IS_VITEST = process.env.VITEST === "true";

// Guard the redirect so test imports don't pollute vitest's console routing.
if (!IS_VITEST) {
  console.log = console.error;
  console.warn = console.error;
  console.info = console.error;
}

const TANDEM_URL = `http://localhost:${DEFAULT_MCP_PORT}`;
const AWARENESS_DEBOUNCE_MS = 500;
const AWARENESS_CLEAR_MS = 3000;
const MODE_CACHE_TTL_MS = 2000;
// Bound the SSE buffer so a misbehaving server that never sends frame
// boundaries can't wedge the monitor with unbounded string growth.
const MAX_SSE_BUFFER_BYTES = 1_000_000;
const CONNECT_FETCH_TIMEOUT_MS = 10_000; // /api/events initial handshake only
const SSE_INACTIVITY_TIMEOUT_MS = 60_000; // Cancel stream if no bytes arrive within this window
const MODE_FETCH_TIMEOUT_MS = 2_000; // /api/mode cache refresh
const AWARENESS_FETCH_TIMEOUT_MS = 5_000; // /api/channel-awareness POST
const ERROR_REPORT_TIMEOUT_MS = 3_000; // /api/channel-error POST on exit
const STABLE_CONNECTION_MS = 60_000; // Reset retries after this much continuous uptime
const CHANNEL_RETRY_MAX_DELAY_MS = 30_000; // Exponential backoff cap

// AbortSignal.timeout is supported on Node 20+; tsup target is node22.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal });
}

/**
 * Format a fetch error for logging. Timeout aborts throw TimeoutError or
 * AbortError with a generic "The operation was aborted" message; tag them
 * with the endpoint and threshold so logs say which request was hung.
 */
function describeFetchError(err: unknown, endpoint: string, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `${endpoint} timed out after ${timeoutMs}ms`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function main(): Promise<void> {
  installShutdownHandlers();
  console.error(`[Monitor] Tandem monitor starting (server: ${TANDEM_URL})`);

  // Warm the mode cache before the first event so we don't default-suppress
  // or default-deliver under an unknown user setting.
  await getCachedMode().catch(() => {
    // Already logged inside getCachedMode; continue with fail-closed default
  });

  let retries = 0;
  let lastEventId: string | undefined;

  while (retries < CHANNEL_MAX_RETRIES) {
    try {
      await connectAndStream(
        lastEventId,
        (id) => {
          lastEventId = id;
          // retries is NOT reset here — only on stable uptime (onStable callback)
        },
        () => {
          // Stable connection — reset retry budget
          retries = 0;
        },
      );
    } catch (err) {
      retries++;
      console.error(
        `[Monitor] SSE connection failed (${retries}/${CHANNEL_MAX_RETRIES}):`,
        err instanceof Error ? err.message : err,
      );

      if (retries >= CHANNEL_MAX_RETRIES) {
        console.error("[Monitor] SSE connection exhausted, exiting");
        try {
          await fetchWithTimeout(
            `${TANDEM_URL}/api/channel-error`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                error: "MONITOR_CONNECT_FAILED",
                message: `Monitor lost connection after ${CHANNEL_MAX_RETRIES} retries.`,
              }),
            },
            ERROR_REPORT_TIMEOUT_MS,
          );
        } catch (reportErr) {
          console.error(
            "[Monitor] Could not report failure to server:",
            reportErr instanceof Error ? reportErr.message : reportErr,
          );
        }
        // Visible-to-Claude-Code notification. stderr is invisible to the plugin
        // host, so the user would otherwise see events just stop with no signal.
        process.stdout.write(
          "Tandem monitor disconnected — restart Tandem to restore real-time events\n",
        );
        process.exit(1);
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 30s (capped)
      const delay = Math.min(
        CHANNEL_RETRY_DELAY_MS * 2 ** (retries - 1),
        CHANNEL_RETRY_MAX_DELAY_MS,
      );
      console.error(
        `[Monitor] Retrying in ${delay}ms (attempt ${retries}/${CHANNEL_MAX_RETRIES})...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Defensive: if connectAndStream ever returns normally (it always throws today),
  // the retry loop exits without an explicit exit code. Claude Code would see the
  // plugin just stop. Fail loudly instead so the invariant is enforced.
  console.error("[Monitor] Retry loop exited unexpectedly without exhaustion");
  process.exit(1);
}

export async function connectAndStream(
  lastEventId: string | undefined,
  onEventId: (id: string) => void,
  onStable: () => void = () => {},
): Promise<void> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;

  // Split handshake timeout from body lifetime. Using AbortSignal.timeout on
  // the fetch would kill the response body ReadableStream at CONNECT_FETCH_TIMEOUT_MS,
  // causing every SSE stream to abort at 10s and making STABLE_CONNECTION_MS
  // unreachable. A local AbortController that we clear immediately after the
  // handshake settles means the body stream is no longer governed by it.
  const connectCtrl = new AbortController();
  const connectTimer = setTimeout(
    () => connectCtrl.abort(new Error("handshake timeout")),
    CONNECT_FETCH_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await fetch(`${TANDEM_URL}/api/events`, { headers, signal: connectCtrl.signal });
  } finally {
    clearTimeout(connectTimer);
  }
  if (!res.ok) throw new Error(`SSE endpoint returned ${res.status}`);
  if (!res.body) throw new Error("SSE endpoint returned no body");

  // Schedule the stable-uptime reset. If the connection stays healthy for
  // STABLE_CONNECTION_MS, signal the caller to reset its retry budget.
  const stableTimer = setTimeout(onStable, STABLE_CONNECTION_MS);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Inactivity watchdog: a healthy stream emits at least SSE keepalive comments
  // periodically. If no bytes arrive for SSE_INACTIVITY_TIMEOUT_MS, cancel the
  // reader and mark the cause — reader.cancel() resolves pending read() with
  // {done: true} (doesn't reject), so we surface the reason via a local flag.
  let lastActivityAt = Date.now();
  let inactivityTimedOut = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivityAt > SSE_INACTIVITY_TIMEOUT_MS) {
      inactivityTimedOut = true;
      reader.cancel(new Error("SSE inactivity timeout")).catch(() => {});
    }
  }, SSE_INACTIVITY_TIMEOUT_MS / 4);

  // shutdownTimers is the single source of truth for awareness timers so
  // finalClearAwareness() can flush them on SIGINT. Using locals alongside
  // would mean two references to the same handle drifting apart.
  let pendingAwareness: TandemEvent | null = null;

  function clearAwareness(documentId?: string) {
    const p = fetchWithTimeout(
      `${TANDEM_URL}/api/channel-awareness`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: documentId ?? null,
          status: "idle",
          active: false,
        }),
      },
      AWARENESS_FETCH_TIMEOUT_MS,
    ).catch((err) => {
      console.error(
        "[Monitor] Awareness clear failed:",
        describeFetchError(err, "/api/channel-awareness clear", AWARENESS_FETCH_TIMEOUT_MS),
      );
    });
    trackAwareness(p);
  }

  function flushAwareness() {
    if (!pendingAwareness) return;
    const event = pendingAwareness;
    pendingAwareness = null;
    // Only update when the event has a real documentId. A doc-less event
    // (e.g. chat:message) must NOT wipe the last-known docId — finalClearAwareness
    // needs a non-null id to send the shutdown clear.
    if (event.documentId) shutdownTimers.lastDocumentId = event.documentId;
    const p = fetchWithTimeout(
      `${TANDEM_URL}/api/channel-awareness`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: event.documentId,
          status: `processing: ${event.type}`,
          active: true,
        }),
      },
      AWARENESS_FETCH_TIMEOUT_MS,
    ).catch((err) => {
      console.error(
        "[Monitor] Awareness update failed:",
        describeFetchError(err, "/api/channel-awareness update", AWARENESS_FETCH_TIMEOUT_MS),
      );
    });
    trackAwareness(p);

    // Auto-clear after timeout so the indicator doesn't stick
    if (shutdownTimers.clearAwarenessTimer) clearTimeout(shutdownTimers.clearAwarenessTimer);
    shutdownTimers.clearAwarenessTimer = setTimeout(
      () => clearAwareness(event.documentId),
      AWARENESS_CLEAR_MS,
    );
  }

  function scheduleAwareness(event: TandemEvent) {
    pendingAwareness = event;
    if (shutdownTimers.awarenessTimer) clearTimeout(shutdownTimers.awarenessTimer);
    shutdownTimers.awarenessTimer = setTimeout(flushAwareness, AWARENESS_DEBOUNCE_MS);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (inactivityTimedOut) throw new Error("SSE inactivity timeout");
        throw new Error("SSE stream ended");
      }
      lastActivityAt = Date.now();

      buffer += decoder.decode(value, { stream: true });

      if (buffer.length > MAX_SSE_BUFFER_BYTES) {
        throw new Error(
          `SSE buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a frame boundary`,
        );
      }

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        if (frame.startsWith(":")) continue;

        let eventId: string | undefined;
        let data: string | undefined;

        for (const line of frame.split("\n")) {
          if (line.startsWith("id: ")) eventId = line.slice(4);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }

        if (!data) continue;

        let raw: unknown;
        try {
          raw = JSON.parse(data);
        } catch (err) {
          console.error(
            `[Monitor] SSE JSON parse failed (eventId=${eventId ?? "none"}, len=${data.length}): ${
              err instanceof Error ? err.message : err
            }. Tail:`,
            data.slice(Math.max(0, data.length - 200)),
          );
          continue;
        }
        const event = parseTandemEvent(raw);
        if (!event) {
          console.error(
            `[Monitor] SSE event failed validation (eventId=${eventId ?? "none"}): shape mismatch`,
          );
          continue;
        }

        // Solo mode suppression: drop non-chat events when mode is "solo"
        if (event.type !== "chat:message") {
          refreshMode(); // fire-and-forget
          if (getModeSync() === "solo") {
            console.error(`[Monitor] Solo mode: suppressed ${event.type} event`);
            if (eventId) onEventId(eventId);
            continue;
          }
        }

        // Collapse newlines so multi-line content stays as a single
        // notification (each stdout line is delivered separately).
        const content = formatEventContent(event).replace(/\n/g, " ");
        try {
          process.stdout.write(content + "\n");
        } catch (err) {
          // EPIPE on a closed plugin-host pipe — re-throw so main's retry loop
          // can decide to exhaust and exit. Do NOT checkpoint lastEventId
          // because the event wasn't delivered.
          throw err;
        }

        if (eventId) onEventId(eventId);
        scheduleAwareness(event);
      }
    }
  } finally {
    clearTimeout(stableTimer);
    clearInterval(watchdog);
    // Prevent timers leaking across reconnects — stale awareness POSTs
    // from a dead connection would otherwise collide with a new one.
    if (shutdownTimers.awarenessTimer) clearTimeout(shutdownTimers.awarenessTimer);
    if (shutdownTimers.clearAwarenessTimer) clearTimeout(shutdownTimers.clearAwarenessTimer);
    shutdownTimers.awarenessTimer = null;
    shutdownTimers.clearAwarenessTimer = null;
    pendingAwareness = null;
  }
}

// Module-level shutdown timers + mode-refresh lock. Declared at module scope
// so _resetMonitorStateForTests can clear them in a single call and
// finalClearAwareness can flush them from the signal handler.
const shutdownTimers: {
  awarenessTimer: ReturnType<typeof setTimeout> | null;
  clearAwarenessTimer: ReturnType<typeof setTimeout> | null;
  lastDocumentId: string | null;
} = { awarenessTimer: null, clearAwarenessTimer: null, lastDocumentId: null };
let _modeRefreshInFlight: Promise<void> | null = null;

// Outstanding awareness POSTs — drained on shutdown so the server's last
// seen awareness is the shutdown "active:false", not a racing update.
const outstandingAwareness = new Set<Promise<unknown>>();
function trackAwareness(p: Promise<unknown>): void {
  outstandingAwareness.add(p);
  p.finally(() => outstandingAwareness.delete(p));
}

async function finalClearAwareness(): Promise<boolean> {
  if (shutdownTimers.awarenessTimer) clearTimeout(shutdownTimers.awarenessTimer);
  if (shutdownTimers.clearAwarenessTimer) clearTimeout(shutdownTimers.clearAwarenessTimer);
  // Drain any in-flight awareness POSTs first so the shutdown "active:false"
  // is the last message the server observes.
  if (outstandingAwareness.size > 0) {
    await Promise.allSettled(outstandingAwareness);
  }
  // If no awareness was ever scheduled for a document, skip the POST —
  // sending {documentId: null} is ambiguous and the server may reject it.
  if (shutdownTimers.lastDocumentId === null) return true;
  try {
    const res = await fetchWithTimeout(
      `${TANDEM_URL}/api/channel-awareness`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: shutdownTimers.lastDocumentId,
          status: "idle",
          active: false,
        }),
      },
      AWARENESS_FETCH_TIMEOUT_MS,
    );
    if (!res.ok) {
      console.error(`[Monitor] Shutdown awareness clear returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      "[Monitor] Shutdown awareness clear failed:",
      describeFetchError(err, "/api/channel-awareness shutdown", AWARENESS_FETCH_TIMEOUT_MS),
    );
    return false;
  }
}

/** Called on SIGINT/SIGTERM and from tests. Flushes awareness then exits. */
export async function shutdownMonitor(signal: string): Promise<void> {
  console.error(`[Monitor] Received ${signal}, clearing awareness and exiting`);
  const ok = await finalClearAwareness();
  process.exit(ok ? 0 : 1);
}

/** @deprecated Use shutdownMonitor. Kept for backwards compatibility during the rename. */
export const shutdownForTests = shutdownMonitor;

/** Exposed for testing only — seeds the lastDocumentId that shutdown reads. */
export function _setLastDocumentIdForTests(id: string | null): void {
  shutdownTimers.lastDocumentId = id;
}

/** Exposed for testing only — reads the last document id that shutdown would send. */
export function _getLastDocumentIdForTests(): string | null {
  return shutdownTimers.lastDocumentId;
}

/** Exposed for testing only — seeds an outstanding awareness POST so the
 *  shutdown test can assert the drain-before-exit behavior. */
export function _addOutstandingAwarenessForTests(p: Promise<unknown>): void {
  trackAwareness(p);
}

function installShutdownHandlers(): void {
  // Never install real signal handlers under vitest — tests drive
  // shutdownMonitor() directly. Prevents listener accumulation and
  // stray real-SIGINT mid-test process.exit.
  if (IS_VITEST) return;
  const handler = (signal: string) => {
    shutdownMonitor(signal).catch((err) => {
      console.error("[Monitor] Shutdown handler failed:", err);
      process.exit(1);
    });
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

let cachedMode: TandemMode = TANDEM_MODE_DEFAULT;
let cachedModeAt = 0;
let cachedModeFailedAt = 0;

type FetchModeResult = { ok: true; mode: TandemMode } | { ok: false; reason: string };

/** Fetch + validate /api/mode. Callers apply their own failure policy. */
async function fetchMode(): Promise<FetchModeResult> {
  try {
    const res = await fetchWithTimeout(`${TANDEM_URL}/api/mode`, {}, MODE_FETCH_TIMEOUT_MS);
    if (!res.ok) return { ok: false, reason: `status ${res.status}` };
    const body = (await res.json()) as { mode?: unknown };
    const parsed = TandemModeSchema.safeParse(body.mode);
    if (!parsed.success) return { ok: false, reason: `invalid mode ${JSON.stringify(body.mode)}` };
    return { ok: true, mode: parsed.data };
  } catch (err) {
    return { ok: false, reason: describeFetchError(err, "/api/mode", MODE_FETCH_TIMEOUT_MS) };
  }
}

/**
 * Get the current collaboration mode, with a 2s TTL cache.
 *
 * **Fail-closed to "solo"** on any failure. Solo is a user-driven privacy
 * signal; leaking events when the mode endpoint is broken is strictly worse
 * than temporarily over-suppressing them.
 *
 * On failure, `cachedMode` is set to "solo" so getModeSync() on the hot path
 * also reports solo — but `cachedModeAt` is NOT updated, so the next call
 * retries immediately rather than waiting out MODE_CACHE_TTL_MS.
 */
export async function getCachedMode(): Promise<TandemMode> {
  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_TTL_MS) return cachedMode;

  const result = await fetchMode();
  if (!result.ok) {
    console.error(`[Monitor] Mode check failed (${result.reason}), failing closed to 'solo'`);
    cachedMode = "solo"; // propagate to hot path; do NOT update cachedModeAt
    return "solo";
  }
  cachedMode = result.mode;
  cachedModeAt = now;
  return cachedMode;
}

/** Sync reader — always returns the last known mode. Use this on the hot path. */
export function getModeSync(): TandemMode {
  return cachedMode;
}

/**
 * Background refresh — fire-and-forget, deduplicated.
 *
 * Leaves `cachedMode` UNCHANGED on failure (stale-preferred). getCachedMode
 * fails closed at startup because no baseline exists; refreshMode prefers
 * stale because flipping mid-session would randomly suppress events and
 * surprise the user.
 */
function refreshMode(): void {
  if (_modeRefreshInFlight) return;
  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_TTL_MS) return;
  // Rate-limit retries after a failure so a server returning 500 quickly
  // (or hanging up to MODE_FETCH_TIMEOUT_MS) doesn't spawn a new fetch on
  // every hot-path event.
  if (now - cachedModeFailedAt < MODE_CACHE_TTL_MS) return;

  // Fire-and-forget. The inner try/finally catches fetch errors, but we
  // attach an outer .catch as a belt-and-suspenders guard against any future
  // synchronous throw before the try escaping to the hot-path caller that
  // cannot handle it.
  _modeRefreshInFlight = (async () => {
    try {
      const result = await fetchMode();
      if (result.ok) {
        cachedMode = result.mode;
        cachedModeAt = Date.now();
        cachedModeFailedAt = 0;
      } else {
        cachedModeFailedAt = Date.now();
        console.error(
          `[Monitor] Background mode refresh failed (${result.reason}), keeping cached`,
        );
      }
    } finally {
      _modeRefreshInFlight = null;
    }
  })().catch((err) => {
    console.error("[Monitor] refreshMode unexpected error:", err);
    _modeRefreshInFlight = null;
  });
}

/**
 * Testing-only. Resets module-level state so tests within a single file
 * don't contaminate each other. Also strips any process signal handlers
 * registered by previous main() calls to prevent listener accumulation
 * (Node emits MaxListenersExceededWarning after 10).
 *
 * DO NOT call this from production code.
 */
export function _resetMonitorStateForTests(): void {
  cachedMode = TANDEM_MODE_DEFAULT;
  cachedModeAt = 0;
  cachedModeFailedAt = 0;
  _modeRefreshInFlight = null;
  shutdownTimers.awarenessTimer = null;
  shutdownTimers.clearAwarenessTimer = null;
  shutdownTimers.lastDocumentId = null;
  outstandingAwareness.clear();
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
}

// Auto-run when invoked directly (e.g. `node dist/monitor/index.js` or
// `tsx src/monitor/index.ts`). Skipped under vitest so tests can import
// and drive individual functions.
//
// Cross-platform direct-run detection: compare resolved file paths
// (not URL strings) because Windows file:// URLs normalize differently
// than process.argv[1] backslashes. Case-insensitive on win32 because
// C:\ vs c:\ drive letters can drift depending on how the CLI was invoked.
function normalizeForCompare(p: string): string {
  const r = resolvePath(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}
const __thisFileNormalized = normalizeForCompare(fileURLToPath(import.meta.url));
const isDirectRun =
  typeof process.argv[1] === "string" &&
  normalizeForCompare(process.argv[1]) === __thisFileNormalized;
if (isDirectRun && !IS_VITEST) {
  main().catch((err) => {
    console.error("[Monitor] Fatal error:", err);
    process.exit(1);
  });
}
