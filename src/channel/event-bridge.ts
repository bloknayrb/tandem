/**
 * SSE event bridge: connects to Tandem server's /api/events endpoint
 * and pushes received events to Claude Code as channel notifications.
 *
 * Per-request timeouts (#364) mirror the monitor pattern: every outbound
 * fetch has a bounded deadline, the SSE body has an inactivity watchdog,
 * and the parse buffer is capped so a malformed upstream can't OOM us.
 * Without these, a half-open Tandem server wedges the bridge silently.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { authFetch } from "../shared/cli-runtime.js";
import {
  CHANNEL_AWARENESS_FETCH_TIMEOUT_MS,
  CHANNEL_CONNECT_FETCH_TIMEOUT_MS,
  CHANNEL_ERROR_REPORT_TIMEOUT_MS,
  CHANNEL_MAX_RETRIES,
  CHANNEL_MAX_SSE_BUFFER_BYTES,
  CHANNEL_MODE_FETCH_TIMEOUT_MS,
  CHANNEL_RETRY_DELAY_MS,
  CHANNEL_SSE_INACTIVITY_TIMEOUT_MS,
} from "../shared/constants.js";
import type { TandemEvent } from "../shared/events/types.js";
import { formatEventContent, formatEventMeta, parseTandemEvent } from "../shared/events/types.js";
import { describeFetchError, fetchWithTimeout } from "../shared/fetch-with-timeout.js";

const AWARENESS_DEBOUNCE_MS = 500;
const MODE_CACHE_TTL_MS = 2000;

/**
 * Stdio-mode SSE bridge. New push-path work should target src/monitor/.
 * This path remains active for stdio-mode Claude Code connections.
 */
export async function startEventBridge(mcp: Server, tandemUrl: string): Promise<void> {
  let retries = 0;
  let lastEventId: string | undefined;

  while (retries < CHANNEL_MAX_RETRIES) {
    try {
      await connectAndStream(mcp, tandemUrl, lastEventId, (id) => {
        lastEventId = id;
        retries = 0;
      });
    } catch (err) {
      retries++;
      console.error(
        `[Channel] SSE connection failed (${retries}/${CHANNEL_MAX_RETRIES}):`,
        err instanceof Error ? err.message : err,
      );

      if (retries >= CHANNEL_MAX_RETRIES) {
        console.error("[Channel] SSE connection exhausted, reporting error and exiting");
        try {
          await fetchWithTimeout(
            `${tandemUrl}/api/channel-error`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                error: "CHANNEL_CONNECT_FAILED",
                message: `Channel shim lost connection after ${CHANNEL_MAX_RETRIES} retries.`,
              }),
            },
            CHANNEL_ERROR_REPORT_TIMEOUT_MS,
          );
        } catch (reportErr) {
          console.error(
            "[Channel] Could not report failure to server:",
            describeFetchError(
              reportErr,
              "/api/channel-error",
              CHANNEL_ERROR_REPORT_TIMEOUT_MS,
            ),
          );
        }
        process.exit(1);
      }

      await new Promise((r) => setTimeout(r, CHANNEL_RETRY_DELAY_MS));
    }
  }
}

async function connectAndStream(
  mcp: Server,
  tandemUrl: string,
  lastEventId: string | undefined,
  onEventId: (id: string) => void,
): Promise<void> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;

  // Split handshake timeout from body lifetime. Using AbortSignal.timeout on
  // the fetch would kill the response body ReadableStream when the timeout
  // fires — every SSE stream would abort at CHANNEL_CONNECT_FETCH_TIMEOUT_MS.
  // A local AbortController cleared in `finally` after the handshake settles
  // means the body stream is no longer governed by it.
  const connectCtrl = new AbortController();
  const connectTimer = setTimeout(
    () => connectCtrl.abort(new Error("handshake timeout")),
    CHANNEL_CONNECT_FETCH_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await authFetch(`${tandemUrl}/api/events`, { headers, signal: connectCtrl.signal });
  } finally {
    clearTimeout(connectTimer);
  }
  if (!res.ok) throw new Error(`SSE endpoint returned ${res.status}`);
  if (!res.body) throw new Error("SSE endpoint returned no body");

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

  // Debounced awareness: only send the latest status after a quiet period
  let awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  let clearAwarenessTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingAwareness: TandemEvent | null = null;
  const AWARENESS_CLEAR_MS = 3000; // Reset active state after 3s of no new events

  function clearAwareness(documentId?: string) {
    fetchWithTimeout(
      `${tandemUrl}/api/channel-awareness`,
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
        "[Channel] clearAwareness failed (non-fatal):",
        describeFetchError(
          err,
          "/api/channel-awareness clear",
          CHANNEL_AWARENESS_FETCH_TIMEOUT_MS,
        ),
      );
    });
  }

  function flushAwareness() {
    if (!pendingAwareness) return;
    const event = pendingAwareness;
    pendingAwareness = null;
    fetchWithTimeout(
      `${tandemUrl}/api/channel-awareness`,
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
        "[Channel] Awareness update failed:",
        describeFetchError(
          err,
          "/api/channel-awareness update",
          CHANNEL_AWARENESS_FETCH_TIMEOUT_MS,
        ),
      );
    });

    // Auto-clear after timeout so the indicator doesn't stick
    if (clearAwarenessTimer) clearTimeout(clearAwarenessTimer);
    clearAwarenessTimer = setTimeout(() => clearAwareness(event.documentId), AWARENESS_CLEAR_MS);
  }

  function scheduleAwareness(event: TandemEvent) {
    pendingAwareness = event;
    if (awarenessTimer) clearTimeout(awarenessTimer);
    awarenessTimer = setTimeout(flushAwareness, AWARENESS_DEBOUNCE_MS);
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

        let event: TandemEvent | null;
        try {
          event = parseTandemEvent(JSON.parse(data));
        } catch {
          console.error(
            "[Channel] Malformed SSE event data (skipping), eventId=%s:",
            eventId,
            data.slice(0, 200),
          );
          // Permanently unparseable — advance past it to prevent infinite re-delivery on reconnect.
          if (eventId) onEventId(eventId);
          continue;
        }
        if (!event) {
          console.error(
            "[Channel] Invalid SSE event structure (skipping), eventId=%s:",
            eventId,
            data.slice(0, 200),
          );
          if (eventId) onEventId(eventId);
          continue;
        }

        // Solo mode: intentionally suppressed (not a delivery failure) — advance past it.
        if (event.type !== "chat:message") {
          const mode = await getCachedMode(tandemUrl);
          if (mode === "solo") {
            console.error(`[Channel] Solo mode: suppressed ${event.type} event`);
            if (eventId) onEventId(eventId);
            continue;
          }
        }

        try {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: formatEventContent(event),
              meta: formatEventMeta(event),
            },
          });
        } catch (err) {
          console.error("[Channel] MCP notification failed (transport broken?):", err);
          throw err;
        }

        // Advance only after notification succeeds so a transport failure
        // doesn't silently skip events on reconnect.
        if (eventId) onEventId(eventId);

        scheduleAwareness(event);
      }
    }
  } finally {
    // Single source of truth for timer cleanup — every exit path (success,
    // throw, reader.cancel) runs through here so awareness/inactivity
    // timers can't leak across reconnects.
    clearInterval(watchdog);
    if (awarenessTimer) clearTimeout(awarenessTimer);
    if (clearAwarenessTimer) clearTimeout(clearAwarenessTimer);
  }
}

// Cached mode lookup — avoids an HTTP fetch per event
let cachedMode: string = "tandem";
let cachedModeAt = 0;

async function getCachedMode(tandemUrl: string): Promise<string> {
  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_TTL_MS) return cachedMode;
  try {
    const res = await fetchWithTimeout(
      `${tandemUrl}/api/mode`,
      {},
      CHANNEL_MODE_FETCH_TIMEOUT_MS,
    );
    if (res.ok) {
      const { mode } = (await res.json()) as { mode: string };
      cachedMode = mode;
    } else {
      console.error(`[Channel] Mode check returned ${res.status}, using cached: "${cachedMode}"`);
    }
    cachedModeAt = now;
  } catch (err) {
    console.error(
      "[Channel] Mode check failed, delivering event (fail-open):",
      describeFetchError(err, "/api/mode", CHANNEL_MODE_FETCH_TIMEOUT_MS),
    );
    cachedModeAt = now;
  }
  return cachedMode;
}
