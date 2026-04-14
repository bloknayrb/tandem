/**
 * Tandem Monitor — Claude Code plugin monitor script.
 *
 * Connects to the Tandem server's /api/events SSE endpoint and prints
 * formatted event lines to stdout. Each line becomes a Claude Code
 * notification automatically via the plugin monitor mechanism.
 *
 * Replaces the channel shim for event delivery without requiring
 * --dangerously-load-development-channels.
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
import type { TandemMode } from "../shared/types.js";

const VALID_MODES = new Set<TandemMode>(["solo", "tandem"]);

// Guard the redirect so test imports don't pollute vitest's console routing.
// Production runs set VITEST !== "true".
if (process.env.VITEST !== "true") {
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
const CONNECT_FETCH_TIMEOUT_MS = 10_000; // /api/events initial handshake
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
}

export async function connectAndStream(
  lastEventId: string | undefined,
  onEventId: (id: string) => void,
  onStable: () => void = () => {},
): Promise<void> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;

  const res = await fetchWithTimeout(
    `${TANDEM_URL}/api/events`,
    { headers },
    CONNECT_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`SSE endpoint returned ${res.status}`);
  if (!res.body) throw new Error("SSE endpoint returned no body");

  // Schedule the stable-uptime reset. If the connection stays healthy for
  // STABLE_CONNECTION_MS, signal the caller to reset its retry budget.
  const stableTimer = setTimeout(onStable, STABLE_CONNECTION_MS);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Debounced awareness: only send the latest status after a quiet period
  let awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  let clearAwarenessTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingAwareness: TandemEvent | null = null;

  function clearAwareness(documentId?: string) {
    fetchWithTimeout(
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
      console.error("[Monitor] Awareness clear failed:", err instanceof Error ? err.message : err);
    });
  }

  function flushAwareness() {
    if (!pendingAwareness) return;
    const event = pendingAwareness;
    pendingAwareness = null;
    shutdownTimers.lastDocumentId = event.documentId ?? null;
    fetchWithTimeout(
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
      console.error("[Monitor] Awareness update failed:", err instanceof Error ? err.message : err);
    });

    // Auto-clear after timeout so the indicator doesn't stick
    if (clearAwarenessTimer) clearTimeout(clearAwarenessTimer);
    clearAwarenessTimer = setTimeout(() => clearAwareness(event.documentId), AWARENESS_CLEAR_MS);
    shutdownTimers.clearAwarenessTimer = clearAwarenessTimer;
  }

  function scheduleAwareness(event: TandemEvent) {
    pendingAwareness = event;
    if (awarenessTimer) clearTimeout(awarenessTimer);
    awarenessTimer = setTimeout(flushAwareness, AWARENESS_DEBOUNCE_MS);
    shutdownTimers.awarenessTimer = awarenessTimer;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream ended");

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
          const mode = await getCachedMode();
          if (mode === "solo") {
            console.error(`[Monitor] Solo mode: suppressed ${event.type} event`);
            if (eventId) onEventId(eventId);
            continue;
          }
        }

        if (eventId) onEventId(eventId);

        // Collapse newlines so multi-line content stays as a single
        // notification (each stdout line is delivered separately).
        const content = formatEventContent(event).replace(/\n/g, " ");
        process.stdout.write(content + "\n");

        scheduleAwareness(event);
      }
    }
  } finally {
    clearTimeout(stableTimer);
    // Prevent timers leaking across reconnects — stale awareness POSTs
    // from a dead connection would otherwise collide with a new one.
    if (awarenessTimer) clearTimeout(awarenessTimer);
    if (clearAwarenessTimer) clearTimeout(clearAwarenessTimer);
    pendingAwareness = null;
  }
}

// Placeholder bindings — populated by later tasks (shutdown and mode-refresh).
// Declared here so _resetMonitorStateForTests can reference them safely.
const shutdownTimers: {
  awarenessTimer: ReturnType<typeof setTimeout> | null;
  clearAwarenessTimer: ReturnType<typeof setTimeout> | null;
  lastDocumentId: string | null;
} = { awarenessTimer: null, clearAwarenessTimer: null, lastDocumentId: null };
let _modeRefreshInFlight: Promise<void> | null = null;

async function finalClearAwareness(): Promise<void> {
  if (shutdownTimers.awarenessTimer) clearTimeout(shutdownTimers.awarenessTimer);
  if (shutdownTimers.clearAwarenessTimer) clearTimeout(shutdownTimers.clearAwarenessTimer);
  // If no awareness was ever scheduled for a document, skip the POST —
  // sending {documentId: null} is ambiguous and the server may reject it.
  if (shutdownTimers.lastDocumentId === null) return;
  try {
    await fetchWithTimeout(
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
  } catch (err) {
    console.error(
      "[Monitor] Shutdown awareness clear failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Exposed for testing. Callers should NOT invoke this outside tests. */
export async function shutdownForTests(signal: string): Promise<void> {
  console.error(`[Monitor] Received ${signal}, clearing awareness and exiting`);
  await finalClearAwareness();
  process.exit(0);
}

/** Exposed for testing only — seeds the lastDocumentId that shutdown reads. */
export function _setLastDocumentIdForTests(id: string | null): void {
  shutdownTimers.lastDocumentId = id;
}

function installShutdownHandlers(): void {
  // Never install real signal handlers under vitest — tests drive
  // shutdownForTests() directly. Prevents listener accumulation and
  // stray real-SIGINT mid-test process.exit.
  if (process.env.VITEST === "true") return;
  const handler = (signal: string) => {
    shutdownForTests(signal).catch((err) => {
      console.error("[Monitor] Shutdown handler failed:", err);
      process.exit(1);
    });
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

let cachedMode: TandemMode = TANDEM_MODE_DEFAULT;
let cachedModeAt = 0;

/**
 * Get the current collaboration mode, with a 2s TTL cache.
 *
 * **Fail-closed to "solo"** on any failure (network, non-2xx, JSON
 * parse, shape mismatch). Solo is a user-driven privacy signal; leaking
 * events when the mode endpoint is broken is strictly worse than
 * temporarily over-suppressing them. The user will notice missed events
 * sooner than they'll notice leaked ones in a supposedly-quiet session.
 *
 * Cache timestamp is ONLY updated on success. On failure, cachedModeAt
 * is NOT updated — so the next call retries immediately instead of being
 * rate-limited for 2s.
 */
export async function getCachedMode(): Promise<TandemMode> {
  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_TTL_MS) return cachedMode;

  try {
    const res = await fetchWithTimeout(`${TANDEM_URL}/api/mode`, {}, MODE_FETCH_TIMEOUT_MS);
    if (!res.ok) {
      console.error(`[Monitor] Mode check returned ${res.status}, failing closed to 'solo'`);
      return "solo"; // do NOT update cache
    }
    const body = (await res.json()) as { mode?: unknown };
    if (!VALID_MODES.has(body.mode as TandemMode)) {
      console.error(
        `[Monitor] Mode check returned invalid mode ${JSON.stringify(body.mode)}, failing closed to 'solo'`,
      );
      return "solo"; // do NOT update cache
    }
    cachedMode = body.mode as TandemMode;
    cachedModeAt = now; // only on success
    return cachedMode;
  } catch (err) {
    console.error(
      "[Monitor] Mode check failed, failing closed to 'solo':",
      err instanceof Error ? err.message : err,
    );
    return "solo"; // do NOT update cache
  }
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
  _modeRefreshInFlight = null;
  shutdownTimers.awarenessTimer = null;
  shutdownTimers.clearAwarenessTimer = null;
  shutdownTimers.lastDocumentId = null;
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
const __thisFile = fileURLToPath(import.meta.url);
function normalizeForCompare(p: string): string {
  const r = resolvePath(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}
const isDirectRun =
  typeof process.argv[1] === "string" &&
  normalizeForCompare(process.argv[1]) === normalizeForCompare(__thisFile);
if (isDirectRun && process.env.VITEST !== "true") {
  main().catch((err) => {
    console.error("[Monitor] Fatal error:", err);
    process.exit(1);
  });
}
