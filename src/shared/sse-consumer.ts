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
 * Mode-cache policy: stale-preserving. Once a real mode has been observed
 * from `/api/mode`, a transient fetch failure (network error or non-OK)
 * NEVER changes the cached mode — the consumer keeps reporting the last
 * successfully-fetched value. The mode only changes when the server reports
 * a different mode (i.e. the user actually toggled Solo/Tandem). This holds
 * for ALL failure paths, including the startup warm-up / first-fetch path:
 * a failure after a successful fetch can never downgrade a known mode.
 * The hardcoded `TANDEM_MODE_DEFAULT` is used ONLY on a genuine cold start —
 * a failure before any successful fetch has ever landed. The channel and
 * monitor previously diverged here (channel failed open to "tandem", monitor
 * failed closed to "solo"); both flipped the mode to a default on a hiccup.
 * Neither honored the user directive that mode must not change unless the
 * user changes it — stale-preserving does.
 *
 * Retry policy: exponential backoff with stable-uptime reset (monitor's
 * pattern). The channel previously reset retries on every successful event
 * — bringing exponential backoff + stable uptime gives the channel the
 * same robustness guarantees.
 *
 * Frame-skip policy: advance `lastEventId` past malformed-JSON and
 * failed-validation frames (channel's "advance past garbage" pattern). The
 * monitor previously did NOT advance on these — its catch / `!event`
 * branches just `continue`d, so a permanently-unparseable frame would be
 * replayed from `Last-Event-ID` on every reconnect forever (an infinite
 * parse-fail loop). Unifying on the channel's semantics fixes that latent
 * infinite re-delivery bug. An oversize frame (one that outgrows
 * `CHANNEL_MAX_SSE_BUFFER_BYTES` without terminating) is the third case: its
 * `id:` line is read off the head of the buffer and advanced past before the
 * stream is torn down, because with no retry cap (#1804) a frame that could
 * never be skipped would be re-fetched every 30 s for the session.
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
  MODE_RELEASE_WAKE_ID_PREFIX,
  TANDEM_MODE_DEFAULT,
} from "./constants.js";
import type { TandemEvent } from "./events/types.js";
import { parseTandemEvent } from "./events/types.js";
import { describeFetchError, fetchWithTimeout } from "./fetch-with-timeout.js";
import { type ChannelErrorCode, type TandemMode, TandemModeSchema } from "./types.js";

const AWARENESS_DEBOUNCE_MS = 500;
const AWARENESS_CLEAR_MS = 3000;
const MODE_CACHE_TTL_MS = 2000;

/**
 * Is this the synthetic Solo→Tandem release wake?
 *
 * The server mints it as an `annotation:created` carrying a `wake_`-prefixed
 * annotationId in a namespace deliberately disjoint from real annotation ids
 * (`events/queue.ts#emitModeReleaseWake`). Matching on that prefix is the only
 * way a consumer can recognise it without a live mode read — which is the whole
 * problem, since the consumer's mode cache is stale at exactly this moment.
 */
export function isModeReleaseWake(event: TandemEvent): boolean {
  if (event.type !== "annotation:created") return false;
  // Defensive read, not decoration: this runs on every inbound frame, and a
  // payload missing `annotationId` must yield "not a wake" rather than throw.
  // A throw here escapes into the stream loop and drops the event entirely —
  // which is how a shutdown-path regression test caught this.
  const id = (event.payload as { annotationId?: unknown } | undefined)?.annotationId;
  return typeof id === "string" && id.startsWith(MODE_RELEASE_WAKE_ID_PREFIX);
}

/**
 * The `id:` of a frame that has not terminated yet, or `undefined`.
 *
 * The server writes `id:` before `data:` (`events/sse.ts`), so an oversize
 * frame's id is readable from its head even though the frame itself never can
 * be parsed. Scans every line rather than trusting the first: the field order
 * is the server's habit, not the SSE spec's rule.
 */
function readFrameId(partialFrame: string): string | undefined {
  for (const line of partialFrame.split("\n")) {
    if (line.startsWith("id: ")) return line.slice(4);
  }
  return undefined;
}

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
   * Optional hook called after the retry-exhaustion error POST returns —
   * once per outage, not once per failed attempt. The monitor uses it to
   * write its visible stdout notice. Default is a noop.
   *
   * **Nothing exits here.** This used to run immediately before
   * `process.exit(1)`; since #1804 the loop keeps reconnecting at the
   * `RETRY_MAX_DELAY_MS` cap indefinitely, because neither of this module's
   * two hosts respawns the process it killed — exiting turned a temporary
   * outage into a push path gone for the rest of the session. A consumer
   * wired here must not assume the process is about to terminate; the
   * `reportedExhaustion` latch, cleared on the next stable connection, is
   * what keeps this to one call per outage.
   *
   * `everConnected` distinguishes "we had a stream and lost it" from "Tandem
   * was never running". The monitor stays silent in the second case — a
   * never-connected run lost nothing, and any `tandem_*` tool call reports
   * the real problem better; see the long note at its `onExhaustion`.
   *
   * A never-connected report does not use up the outage budget: the first
   * successful handshake of the run resets the retry counter and the latch, so
   * the first *real* stream loss afterwards is reported as one — even when the
   * stream died before it could survive `STABLE_CONNECTION_MS`.
   */
  onExhaustion?: (info: { everConnected: boolean }) => void;
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

/** True once an SSE handshake has succeeded this run. See `onExhaustion`. */
let everConnected = false;

/**
 * Set when this outage has already been reported, cleared by
 * `STABLE_CONNECTION_MS` of continuous uptime — or by the run's FIRST
 * successful handshake, which is not an outage ending but a baseline arriving.
 *
 * The consumer retries forever (#1804) — neither host is ever respawned, so a
 * process that gives up kills the push path for the whole session — and this
 * latch is what keeps that from becoming a report and two stderr lines every
 * 30 s until the session ends.
 *
 * The first-handshake clear matters because a latch set while Tandem was never
 * running (its report swallowed by the monitor's `everConnected` guard) would
 * otherwise silence the first real stream loss: with `retries` still at the
 * threshold and the latch still set, a server that came up and died inside
 * `STABLE_CONNECTION_MS` produced no report, no notice and no stderr line.
 */
let reportedExhaustion = false;

// --- Public entry point ---

/**
 * Drive the SSE consumer: connect, parse frames, deliver events via
 * `onEvent`, debounce awareness POSTs, and reconnect with exponential
 * backoff on failure. **It never exits and never stops retrying.**
 *
 * After `CHANNEL_MAX_RETRIES` consecutive failures it reports `opts.errorCode`
 * to `/api/channel-error` and calls `opts.onExhaustion` — once per outage —
 * and keeps going at the capped backoff. Both hosts (the plugin monitor and
 * the channel shim) are launched once per Claude Code session and are never
 * respawned, so exiting here permanently killed the push path for that session
 * and the remedy printed with it named the wrong process (#1804).
 */
export async function runEventConsumer(opts: EventConsumerOptions): Promise<void> {
  // Warm the mode cache before the first event so we don't default-suppress
  // or default-deliver under an unknown user setting. Errors are already
  // logged inside getCachedMode (stale-preserving; cold-start default only
  // when no fetch has ever succeeded) — keep going.
  await getCachedMode(opts.tandemUrl, opts.logPrefix).catch(() => {});

  let retries = 0;
  let lastEventId: string | undefined;

  while (true) {
    try {
      await connectAndStreamOnce(opts, lastEventId, {
        onEventId: (id) => {
          lastEventId = id;
        },
        onFirstConnect: () => {
          // Runs exactly once per process — the `everConnected` false→true
          // transition — so unlike a clear on every handshake it cannot be
          // re-armed by a connect-then-die flap. Failures before this point
          // were "Tandem not running yet", not an outage; the retry counter
          // and the latch start fresh so the first real loss is reported.
          retries = 0;
          if (reportedExhaustion) {
            reportedExhaustion = false;
            console.error(`${opts.logPrefix} SSE connection established`);
          }
        },
        onStable: () => {
          retries = 0;
          // Clearing here, and NOT on the `everConnected` handshake line: that
          // one runs on every connect, so a connect-then-die flap would re-arm
          // the report and the host's stdout notice on every cycle — and on CC
          // 2.1.226 each stdout write is a model turn. The cost is a
          // "restored" line up to STABLE_CONNECTION_MS late.
          if (reportedExhaustion) {
            reportedExhaustion = false;
            console.error(`${opts.logPrefix} SSE connection restored`);
          }
        },
      });
    } catch (err) {
      retries++;
      if (!reportedExhaustion) {
        console.error(
          `${opts.logPrefix} SSE connection failed (attempt ${retries}):`,
          err instanceof Error ? err.message : err,
        );
      }

      // `>=` rather than `===`, with the latch doing the once-per-outage work:
      // a later edit that breaks the latch/`retries` coupling then over-reports
      // rather than going permanently silent.
      if (retries >= CHANNEL_MAX_RETRIES && !reportedExhaustion) {
        reportedExhaustion = true;
        console.error(
          `${opts.logPrefix} SSE connection lost after ${CHANNEL_MAX_RETRIES} retries; still retrying`,
        );
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
        opts.onExhaustion?.({ everConnected });
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 30s (capped).
      const delay = Math.min(CHANNEL_RETRY_DELAY_MS * 2 ** (retries - 1), RETRY_MAX_DELAY_MS);
      if (!reportedExhaustion) {
        console.error(`${opts.logPrefix} Retrying in ${delay}ms (attempt ${retries})...`);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export interface StreamCallbacks {
  onEventId: (id: string) => void;
  onStable?: () => void;
  /** Fired on the run's first successful handshake only — never on a reconnect. */
  onFirstConnect?: () => void;
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

  // Latched at the first successful handshake — see `onExhaustion`. Set here,
  // not on first event: a stream that connects and stays quiet IS connected,
  // and losing it later is worth reporting. The transition is observed by the
  // caller (retry-counter and report-latch reset); the latch itself never
  // clears.
  if (!everConnected) {
    everConnected = true;
    cb.onFirstConnect?.();
  }

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

        // Solo mode COMPATIBILITY gate: drop non-chat events when mode is "solo".
        //
        // The SERVER is authoritative for this now — `shouldForwardExternally` in
        // `server/events/queue.ts` (WS-A2 Phase 7). Against a current server this
        // gate has nothing left to CATCH while mode is Solo: the events it would
        // drop are never forwarded to an external consumer in the first place.
        //
        // That is not the same as being inert. The two gates read two different
        // values: the server reads CTRL_ROOM live, per delivery, while this side
        // reads `cachedMode` — refreshed by a fire-and-forget `/api/mode` fetch
        // behind a 2s TTL that is STALE-PRESERVING on failure (see
        // `getCachedMode`). So the two disagree in the Solo→Tandem direction: the
        // server resumes forwarding the moment mode flips, and this gate keeps
        // dropping until a SUCCESSFUL refresh lands. Normally that is about one
        // TTL, but nothing bounds it — while `/api/mode` keeps failing,
        // `cachedMode` stays "solo" for as long as the failures do, by design.
        // And the drops are permanent rather than deferred: `onEventId` advances
        // past each one, so no reconnect replays it.
        //
        // It stays anyway, and not as vague defense in depth. The monitor and
        // channel shim are version-pinned per release in `.claude-plugin/plugin.json`
        // while the desktop server updates on the Tauri updater's own track, and
        // neither side does a version handshake. A NEW consumer running against an
        // OLDER, un-gated server is therefore routine — and on that pairing this
        // gate is the only thing standing between Solo and a silent privacy leak
        // with no user-visible symptom. Retire it when monitor and server can no
        // longer skew (same-artifact shipping, or a hard minimum-server-version
        // refusal), NOT merely once the server gate looks old enough. See #1213.
        //
        // The RELEASE WAKE must be exempt or that same disagreement window eats
        // the one event WS-A2 exists to deliver: the release route flips mode
        // server-side and fires the wake microseconds later in the same handler,
        // but the check below reads `cachedMode`, and `refreshMode` is
        // fire-and-forget AND early-returns inside its TTL. So the cache still
        // says "solo", the wake is dropped, and `onEventId` advances past it so
        // it is never replayed.
        //
        // Exempting by id is safe because the namespace is disjoint by
        // construction: `emitModeReleaseWake` mints `wake_…` precisely so it
        // cannot collide with a real annotation id.
        if (event.type !== "chat:message" && !isModeReleaseWake(event)) {
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

      // Checked AFTER the boundary loop, so `buffer` is exactly one unterminated
      // frame — never complete frames waiting behind it — and its `id:` line is
      // that frame's own. Advancing past it is what keeps this from being a
      // loop: the consumer retries forever (#1804), and a reconnect with the
      // previous `Last-Event-ID` replays the same >1 MB frame, which throws
      // here again before it can ever be parsed, every 30 s for the rest of
      // the session. Same policy as the malformed-JSON and failed-validation
      // branches above: permanently undeliverable, so skip it. The throw stays
      // — this connection's buffer is unbounded until the frame ends, and
      // reconnecting past it is the only way to bound it.
      if (buffer.length > CHANNEL_MAX_SSE_BUFFER_BYTES) {
        const oversizeId = readFrameId(buffer);
        console.error(
          `${opts.logPrefix} SSE buffer exceeded ${CHANNEL_MAX_SSE_BUFFER_BYTES} bytes without a frame boundary (eventId=${oversizeId ?? "none"}); skipping the frame`,
        );
        if (oversizeId) cb.onEventId(oversizeId);
        throw new Error(
          `SSE buffer exceeded ${CHANNEL_MAX_SSE_BUFFER_BYTES} bytes without a frame boundary`,
        );
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
 * **Stale-preserving** on any failure: once a real mode has been fetched
 * successfully, a transient `/api/mode` failure (network error or non-OK)
 * NEVER changes the cached mode — `cachedMode` is left untouched and the last
 * known value is returned. The mode only ever changes when the server reports
 * a new mode, i.e. when the user actually toggles Solo/Tandem.
 *
 * `cachedModeAt === 0` is the cold-start sentinel (no successful fetch ever).
 * In that one case — and only that case — a failure falls back to the
 * documented `TANDEM_MODE_DEFAULT`. After the first success, `cachedModeAt`
 * is non-zero forever, so failures can never revert to the cold-start default.
 *
 * On failure, `cachedModeAt` is NOT updated, so the next call retries
 * immediately rather than waiting out MODE_CACHE_TTL_MS.
 */
export async function getCachedMode(
  tandemUrl: string,
  logPrefix = "[Tandem]",
): Promise<TandemMode> {
  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_TTL_MS && cachedModeAt !== 0) return cachedMode;

  const result = await fetchMode(tandemUrl);
  if (!result.ok) {
    // Stale-preserving: keep the last known mode. A failure must never
    // overwrite a successfully-observed mode. Only on a genuine cold start
    // (no successful fetch ever, cachedModeAt === 0) do we fall back to the
    // documented default. cachedModeAt is left untouched so the next call
    // retries immediately instead of serving a stale cache window.
    if (cachedModeAt !== 0) {
      console.error(
        `${logPrefix} Mode check failed (${result.reason}), preserving last known mode '${cachedMode}'`,
      );
      return cachedMode;
    }
    console.error(
      `${logPrefix} Mode check failed (${result.reason}), no prior mode — using cold-start default '${TANDEM_MODE_DEFAULT}'`,
    );
    cachedMode = TANDEM_MODE_DEFAULT; // propagate cold-start default to hot path; do NOT update cachedModeAt
    return TANDEM_MODE_DEFAULT;
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
  everConnected = false;
  reportedExhaustion = false;
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
