/**
 * Shared SSE consumer for the Tandem channel shim and plugin monitor.
 *
 * Extracted in #282 to deduplicate ~140 lines of retry / frame-parse /
 * awareness / mode-cache logic that used to be copy-pasted between
 * `src/channel/event-bridge.ts` and `src/monitor/index.ts`.
 *
 * Callers inject their per-event delivery mechanism via the `onEvent`
 * callback. The shared module never touches the MCP SDK or stdout — that
 * preserves the MCP-free constraint and keeps the channel shim and monitor
 * free to evolve their delivery surfaces independently.
 *
 * Per-request timeouts (#364) mirror the original monitor pattern: every
 * outbound fetch has a bounded deadline, the SSE body has an inactivity
 * watchdog, and the parse buffer is capped so a malformed upstream can't
 * OOM us. Without these, a half-open Tandem server wedges the consumer
 * silently.
 *
 * Mode-cache policy: fail-closed to "solo" on any failure (monitor's
 * privacy-sensitive default). The channel previously failed open to
 * "tandem" — fail-closed is strictly safer (leaking events when the mode
 * endpoint is broken is worse than temporarily over-suppressing them) and
 * unifies the two consumers on the same contract.
 *
 * Retry policy: exponential backoff with stable-uptime reset (monitor's
 * pattern). The channel previously reset retries on every successful event
 * — bringing exponential backoff + stable uptime gives the channel the
 * same robustness guarantees.
 */

import { API_CHANNEL_AWARENESS, API_CHANNEL_ERROR, API_EVENTS, API_MODE } from "./api-paths.js";
import { authFetch } from "./cli-runtime.js";
import {
  CHANNEL_AWARENESS_FETCH_TIMEOUT_MS,
  CHANNEL_CONNECT_FETCH_TIMEOUT_MS,
  CHANNEL_ERROR_REPORT_TIMEOUT_MS,
  CHANNEL_MAX_RETRIES,
  CHANNEL_MAX_SSE_BUFFER_BYTES,
  CHANNEL_MODE_FETCH_TIMEOUT_MS,
  CHANNEL_RETRY_DELAY_MS,
  CHANNEL_SSE_INACTIVITY_TIMEOUT_MS,
  TANDEM_MODE_DEFAULT,
} from "./constants.js";
import type { TandemEvent } from "./events/types.js";
import { parseTandemEvent } from "./events/types.js";
import { describeFetchError, fetchWithTimeout } from "./fetch-with-timeout.js";
import { type ChannelErrorCode, type TandemMode, TandemModeSchema } from "./types.js";

const AWARENESS_DEBOUNCE_MS = 500;
const AWARENESS_CLEAR_MS = 3000;
const MODE_CACHE_TTL_MS = 2000;
const STABLE_CONNECTION_MS = 60_000; // Reset retries after this much continuous uptime
const RETRY_MAX_DELAY_MS = 30_000; // Exponential backoff cap

export interface EventConsumerOptions {
  /** Base URL of the Tandem server (no trailing slash). */
  tandemUrl: string;
  /** Log prefix used in stderr lines (e.g. `[Channel]` or `[Monitor]`). */
  logPrefix: string;
  /** Error code POSTed to /api/channel-error on retry exhaustion. */
  errorCode: ChannelErrorCode;
  /**
   * Per-event delivery callback. Called for every parsed, non-suppressed
   * SSE event. If this throws or rejects, `lastEventId` is NOT advanced and
   * the stream is torn down so the retry loop reconnects with the previous
   * `Last-Event-ID` — the server replays the dropped event.
   */
  onEvent: (event: TandemEvent, eventId: string | undefined) => Promise<void> | void;
  /**
   * Optional hook called after the retry-exhaustion error POST returns but
   * before `process.exit(1)`. The monitor uses it to write the visible
   * "disconnected" notice to stdout. Default is a noop.
   */
  onExhaustion?: () => void;
}

// --- Module-level state ---
//
// Kept at module scope (not function-local) so `flushFinalAwareness` (called
// from the monitor's signal handler) can drain in-flight awareness POSTs
// and send the shutdown clear. `_resetSseConsumerStateForTests` clears
// every byte of state below in one call.

const shutdownTimers: {
  awarenessTimer: ReturnType<typeof setTimeout> | null;
  clearAwarenessTimer: ReturnType<typeof setTimeout> | null;
  lastDocumentId: string | null;
} = { awarenessTimer: null, clearAwarenessTimer: null, lastDocumentId: null };

/** Outstanding awareness POSTs — drained on shutdown so the server's last
 *  seen awareness is the shutdown "active:false", not a racing update. */
const outstandingAwareness = new Set<Promise<unknown>>();
function trackAwareness(p: Promise<unknown>): void {
  outstandingAwareness.add(p);
  p.finally(() => outstandingAwareness.delete(p));
}

let cachedMode: TandemMode = TANDEM_MODE_DEFAULT;
let cachedModeAt = 0;
let cachedModeFailedAt = 0;
let _modeRefreshInFlight: Promise<void> | null = null;

// --- Public entry point ---

/**
 * Drive the SSE consumer: connect, parse frames, deliver events via
 * `onEvent`, debounce awareness POSTs, and reconnect with exponential
 * backoff on failure. Reports `opts.errorCode` to `/api/channel-error` and
 * calls `process.exit(1)` after `CHANNEL_MAX_RETRIES` consecutive
 * failures.
 */
export async function runEventConsumer(opts: EventConsumerOptions): Promise<void> {
  // Warm the mode cache before the first event so we don't default-suppress
  // or default-deliver under an unknown user setting. Errors are already
  // logged inside getCachedMode (fail-closed to "solo") — keep going.
  await getCachedMode(opts.tandemUrl, opts.logPrefix).catch(() => {});

  let retries = 0;
  let lastEventId: string | undefined;

  while (retries < CHANNEL_MAX_RETRIES) {
    try {
      await connectAndStreamOnce(opts, lastEventId, {
        onEventId: (id) => {
          lastEventId = id;
        },
        onStable: () => {
          retries = 0;
        },
      });
    } catch (err) {
      retries++;
      console.error(
        `${opts.logPrefix} SSE connection failed (${retries}/${CHANNEL_MAX_RETRIES}):`,
        err instanceof Error ? err.message : err,
      );

      if (retries >= CHANNEL_MAX_RETRIES) {
        console.error(`${opts.logPrefix} SSE connection exhausted, reporting error and exiting`);
        try {
          await fetchWithTimeout(
            `${opts.tandemUrl}${API_CHANNEL_ERROR}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                error: opts.errorCode,
                message: `${opts.logPrefix} lost connection after ${CHANNEL_MAX_RETRIES} retries.`,
              }),
            },
            CHANNEL_ERROR_REPORT_TIMEOUT_MS,
          );
        } catch (reportErr) {
          console.error(
            `${opts.logPrefix} Could not report failure to server:`,
            describeFetchError(reportErr, API_CHANNEL_ERROR, CHANNEL_ERROR_REPORT_TIMEOUT_MS),
          );
        }
        opts.onExhaustion?.();
        process.exit(1);
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 30s (capped).
      const delay = Math.min(CHANNEL_RETRY_DELAY_MS * 2 ** (retries - 1), RETRY_MAX_DELAY_MS);
      console.error(
        `${opts.logPrefix} Retrying in ${delay}ms (attempt ${retries}/${CHANNEL_MAX_RETRIES})...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Defensive: under normal exhaustion the catch above calls process.exit(1)
  // before we return here. Survives any future refactor that removes the
  // exit or makes it non-terminating (e.g. test shim).
  console.error(
    `${opts.logPrefix} Retry loop exited unexpectedly (retries=${retries}/${CHANNEL_MAX_RETRIES})`,
  );
  process.exit(1);
}

export interface StreamCallbacks {
  onEventId: (id: string) => void;
  onStable?: () => void;
}

/**
 * Single-attempt SSE consumer. Performs one handshake, streams frames,
 * and returns / throws when the stream ends. Exported for tests that want
 * to exercise per-attempt behavior without driving the full retry loop.
 *
 * Production code should call `runEventConsumer` instead — it owns the
 * reconnect/backoff/exhaustion-report logic.
 */
export async function connectAndStreamOnce(
  opts: EventConsumerOptions,
  lastEventId: string | undefined,
  cb: StreamCallbacks,
): Promise<void> {
  const onStable = cb.onStable ?? (() => {});
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;

  // Split handshake timeout from body lifetime. Using AbortSignal.timeout on
  // the fetch would kill the response body ReadableStream when the timeout
  // fires — every SSE stream would abort at CHANNEL_CONNECT_FETCH_TIMEOUT_MS,
  // making STABLE_CONNECTION_MS unreachable. A local AbortController cleared
  // in `finally` after the handshake settles means the body stream is no
  // longer governed by it.
  const connectCtrl = new AbortController();
  const connectTimer = setTimeout(
    () => connectCtrl.abort(new Error("handshake timeout")),
    CHANNEL_CONNECT_FETCH_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await authFetch(`${opts.tandemUrl}${API_EVENTS}`, {
      headers,
      signal: connectCtrl.signal,
    });
  } finally {
    clearTimeout(connectTimer);
  }
  if (!res.ok) throw new Error(`SSE endpoint returned ${res.status}`);
  if (!res.body) throw new Error("SSE endpoint returned no body");

  // Stable-uptime reset: if the connection stays healthy for
  // STABLE_CONNECTION_MS, signal the caller to reset its retry budget.
  const stableTimer = setTimeout(onStable, STABLE_CONNECTION_MS);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Inactivity watchdog. A healthy stream emits keepalive comments
  // periodically; if no bytes arrive for CHANNEL_SSE_INACTIVITY_TIMEOUT_MS,
  // cancel the reader. reader.cancel() resolves a pending read() with
  // {done: true} (does not reject), so we surface the cause via a flag.
  let lastActivityAt = Date.now();
  let inactivityTimedOut = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivityAt > CHANNEL_SSE_INACTIVITY_TIMEOUT_MS) {
      inactivityTimedOut = true;
      reader.cancel(new Error("SSE inactivity timeout")).catch(() => {});
    }
  }, CHANNEL_SSE_INACTIVITY_TIMEOUT_MS / 4);

  let pendingAwareness: TandemEvent | null = null;

  function clearAwarenessNow(documentId?: string) {
    const p = fetchWithTimeout(
      `${opts.tandemUrl}${API_CHANNEL_AWARENESS}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: documentId ?? null,
          status: "idle",
          active: false,
        }),
      },
      CHANNEL_AWARENESS_FETCH_TIMEOUT_MS,
    ).catch((err) => {
      console.error(
        `${opts.logPrefix} Awareness clear failed:`,
        describeFetchError(
          err,
          `${API_CHANNEL_AWARENESS} clear`,
          CHANNEL_AWARENESS_FETCH_TIMEOUT_MS,
        ),
      );
    });
    trackAwareness(p);
  }

  function flushAwareness() {
    if (!pendingAwareness) return;
    const event = pendingAwareness;
    pendingAwareness = null;
    // Only update when the event has a real documentId. A doc-less event
    // (e.g. chat:message) must NOT wipe the last-known docId —
    // flushFinalAwareness needs a non-null id to send the shutdown clear.
    if (event.documentId) shutdownTimers.lastDocumentId = event.documentId;
    const p = fetchWithTimeout(
      `${opts.tandemUrl}${API_CHANNEL_AWARENESS}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: event.documentId,
          status: `processing: ${event.type}`,
          active: true,
        }),
      },
      CHANNEL_AWARENESS_FETCH_TIMEOUT_MS,
    ).catch((err) => {
      console.error(
        `${opts.logPrefix} Awareness update failed:`,
        describeFetchError(
          err,
          `${API_CHANNEL_AWARENESS} update`,
          CHANNEL_AWARENESS_FETCH_TIMEOUT_MS,
        ),
      );
    });
    trackAwareness(p);

    // Auto-clear after timeout so the indicator doesn't stick.
    if (shutdownTimers.clearAwarenessTimer) clearTimeout(shutdownTimers.clearAwarenessTimer);
    shutdownTimers.clearAwarenessTimer = setTimeout(
      () => clearAwarenessNow(event.documentId),
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

      if (buffer.length > CHANNEL_MAX_SSE_BUFFER_BYTES) {
        throw new Error(
          `SSE buffer exceeded ${CHANNEL_MAX_SSE_BUFFER_BYTES} bytes without a frame boundary`,
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
            `${opts.logPrefix} SSE JSON parse failed (eventId=${eventId ?? "none"}, len=${
              data.length
            }): ${err instanceof Error ? err.message : err}. Tail:`,
            data.slice(Math.max(0, data.length - 200)),
          );
          // Permanently unparseable — advance past it to prevent infinite
          // re-delivery on reconnect.
          if (eventId) cb.onEventId(eventId);
          continue;
        }

        const event = parseTandemEvent(raw);
        if (!event) {
          console.error(
            `${opts.logPrefix} SSE event failed validation (eventId=${
              eventId ?? "none"
            }): shape mismatch`,
          );
          if (eventId) cb.onEventId(eventId);
          continue;
        }

        // Solo mode suppression: drop non-chat events when mode is "solo".
        if (event.type !== "chat:message") {
          refreshMode(opts.tandemUrl, opts.logPrefix); // fire-and-forget
          if (getModeSync() === "solo") {
            console.error(`${opts.logPrefix} Solo mode: suppressed ${event.type} event`);
            if (eventId) cb.onEventId(eventId);
            continue;
          }
        }

        // Deliver the event. False-checkpoint guard: `cb.onEventId` MUST
        // stay below this so lastEventId never advances past an event that
        // didn't reach the consumer's delivery surface.
        try {
          await opts.onEvent(event, eventId);
        } catch (err) {
          console.error(`${opts.logPrefix} onEvent failed (transport broken?):`, err);
          throw err;
        }

        if (eventId) cb.onEventId(eventId);
        scheduleAwareness(event);
      }
    }
  } finally {
    // Single source of truth for timer cleanup — every exit path (success,
    // throw, reader.cancel) runs through here so awareness/inactivity
    // timers can't leak across reconnects.
    clearTimeout(stableTimer);
    clearInterval(watchdog);
    if (shutdownTimers.awarenessTimer) clearTimeout(shutdownTimers.awarenessTimer);
    if (shutdownTimers.clearAwarenessTimer) clearTimeout(shutdownTimers.clearAwarenessTimer);
    shutdownTimers.awarenessTimer = null;
    shutdownTimers.clearAwarenessTimer = null;
    pendingAwareness = null;
  }
}

// --- Mode cache ---

type FetchModeResult = { ok: true; mode: TandemMode } | { ok: false; reason: string };

/** Fetch + validate /api/mode. Callers apply their own failure policy. */
async function fetchMode(tandemUrl: string): Promise<FetchModeResult> {
  try {
    const res = await fetchWithTimeout(
      `${tandemUrl}${API_MODE}`,
      {},
      CHANNEL_MODE_FETCH_TIMEOUT_MS,
    );
    if (!res.ok) return { ok: false, reason: `status ${res.status}` };
    const body = (await res.json()) as { mode?: unknown };
    const parsed = TandemModeSchema.safeParse(body.mode);
    if (!parsed.success) return { ok: false, reason: `invalid mode ${JSON.stringify(body.mode)}` };
    return { ok: true, mode: parsed.data };
  } catch (err) {
    return { ok: false, reason: describeFetchError(err, API_MODE, CHANNEL_MODE_FETCH_TIMEOUT_MS) };
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
export async function getCachedMode(
  tandemUrl: string,
  logPrefix = "[Tandem]",
): Promise<TandemMode> {
  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_TTL_MS) return cachedMode;

  const result = await fetchMode(tandemUrl);
  if (!result.ok) {
    console.error(`${logPrefix} Mode check failed (${result.reason}), failing closed to 'solo'`);
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
function refreshMode(tandemUrl: string, logPrefix: string): void {
  if (_modeRefreshInFlight) return;
  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_TTL_MS) return;
  // Rate-limit retries after a failure so a server returning 500 quickly
  // (or hanging up to MODE_FETCH_TIMEOUT_MS) doesn't spawn a new fetch on
  // every hot-path event.
  if (now - cachedModeFailedAt < MODE_CACHE_TTL_MS) return;

  // Fire-and-forget. fetchMode() converts network/parse errors into
  // { ok: false }, and the inner try/finally clears `_modeRefreshInFlight` on
  // both success and thrown rejection — so today, the outer .catch is
  // unreachable. It exists as a belt-and-suspenders guard.
  _modeRefreshInFlight = (async () => {
    try {
      const result = await fetchMode(tandemUrl);
      if (result.ok) {
        cachedMode = result.mode;
        cachedModeAt = Date.now();
        cachedModeFailedAt = 0;
      } else {
        cachedModeFailedAt = Date.now();
        console.error(
          `${logPrefix} Background mode refresh failed (${result.reason}), keeping cached`,
        );
      }
    } finally {
      _modeRefreshInFlight = null;
    }
  })().catch((err) => {
    console.error(`${logPrefix} refreshMode unexpected error:`, err);
    cachedModeFailedAt = Date.now();
  });
}

// --- Shutdown drain (used by the monitor's signal handler) ---

/**
 * Drain any in-flight awareness POSTs and send a final shutdown
 * "active: false" so the server's last-observed awareness state is clean.
 *
 * Returns true on success (or no-op when no docId was ever scheduled),
 * false when the shutdown POST itself fails.
 */
export async function flushFinalAwareness(
  tandemUrl: string,
  logPrefix = "[Tandem]",
): Promise<boolean> {
  if (shutdownTimers.awarenessTimer) clearTimeout(shutdownTimers.awarenessTimer);
  if (shutdownTimers.clearAwarenessTimer) clearTimeout(shutdownTimers.clearAwarenessTimer);
  if (outstandingAwareness.size > 0) {
    await Promise.allSettled(outstandingAwareness);
  }
  // If no awareness was ever scheduled for a document, skip the POST —
  // sending {documentId: null} is ambiguous and the server may reject it.
  if (shutdownTimers.lastDocumentId === null) return true;
  try {
    const res = await fetchWithTimeout(
      `${tandemUrl}${API_CHANNEL_AWARENESS}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: shutdownTimers.lastDocumentId,
          status: "idle",
          active: false,
        }),
      },
      CHANNEL_AWARENESS_FETCH_TIMEOUT_MS,
    );
    if (!res.ok) {
      console.error(`${logPrefix} Shutdown awareness clear returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `${logPrefix} Shutdown awareness clear failed:`,
      describeFetchError(
        err,
        `${API_CHANNEL_AWARENESS} shutdown`,
        CHANNEL_AWARENESS_FETCH_TIMEOUT_MS,
      ),
    );
    return false;
  }
}

// --- Test-only helpers ---

/** Testing-only. Resets module-level state so tests within a single file
 *  don't contaminate each other. DO NOT call from production code. */
export function _resetSseConsumerStateForTests(): void {
  cachedMode = TANDEM_MODE_DEFAULT;
  cachedModeAt = 0;
  cachedModeFailedAt = 0;
  _modeRefreshInFlight = null;
  shutdownTimers.awarenessTimer = null;
  shutdownTimers.clearAwarenessTimer = null;
  shutdownTimers.lastDocumentId = null;
  outstandingAwareness.clear();
}

/** Testing-only — seeds the lastDocumentId that shutdown reads. */
export function _setLastDocumentIdForTests(id: string | null): void {
  shutdownTimers.lastDocumentId = id;
}

/** Testing-only — reads the last document id that shutdown would send. */
export function _getLastDocumentIdForTests(): string | null {
  return shutdownTimers.lastDocumentId;
}

/** Testing-only — seeds an outstanding awareness POST so the shutdown test
 *  can assert the drain-before-exit behavior. */
export function _addOutstandingAwarenessForTests(p: Promise<unknown>): void {
  trackAwareness(p);
}
