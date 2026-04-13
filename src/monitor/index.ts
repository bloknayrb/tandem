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

import type { TandemEvent } from "../server/events/types.js";
import { formatEventContent, parseTandemEvent } from "../server/events/types.js";
import {
  CHANNEL_MAX_RETRIES,
  CHANNEL_RETRY_DELAY_MS,
  DEFAULT_MCP_PORT,
} from "../shared/constants.js";

// stdout is the monitor event wire — redirect console to stderr
console.log = console.error;
console.warn = console.error;
console.info = console.error;

const TANDEM_URL = `http://localhost:${DEFAULT_MCP_PORT}`;
const AWARENESS_DEBOUNCE_MS = 500;
const AWARENESS_CLEAR_MS = 3000;
const MODE_CACHE_TTL_MS = 2000;

// --- Main loop ---

async function main(): Promise<void> {
  console.error(`[Monitor] Tandem monitor starting (server: ${TANDEM_URL})`);

  let retries = 0;
  let lastEventId: string | undefined;

  while (retries < CHANNEL_MAX_RETRIES) {
    try {
      await connectAndStream(lastEventId, (id) => {
        lastEventId = id;
        retries = 0;
      });
    } catch (err) {
      retries++;
      console.error(
        `[Monitor] SSE connection failed (${retries}/${CHANNEL_MAX_RETRIES}):`,
        err instanceof Error ? err.message : err,
      );

      if (retries >= CHANNEL_MAX_RETRIES) {
        console.error("[Monitor] SSE connection exhausted, exiting");
        try {
          await fetch(`${TANDEM_URL}/api/channel-error`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              error: "MONITOR_CONNECT_FAILED",
              message: `Monitor lost connection after ${CHANNEL_MAX_RETRIES} retries.`,
            }),
          });
        } catch {
          // Best-effort error report
        }
        process.exit(1);
      }

      await new Promise((r) => setTimeout(r, CHANNEL_RETRY_DELAY_MS));
    }
  }
}

// --- SSE consumer ---

async function connectAndStream(
  lastEventId: string | undefined,
  onEventId: (id: string) => void,
): Promise<void> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;

  const res = await fetch(`${TANDEM_URL}/api/events`, { headers });
  if (!res.ok) throw new Error(`SSE endpoint returned ${res.status}`);
  if (!res.body) throw new Error("SSE endpoint returned no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Debounced awareness: only send the latest status after a quiet period
  let awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  let clearAwarenessTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingAwareness: TandemEvent | null = null;

  function clearAwareness(documentId?: string) {
    fetch(`${TANDEM_URL}/api/channel-awareness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: documentId ?? null,
        status: "idle",
        active: false,
      }),
    }).catch(() => {});
  }

  function flushAwareness() {
    if (!pendingAwareness) return;
    const event = pendingAwareness;
    pendingAwareness = null;
    fetch(`${TANDEM_URL}/api/channel-awareness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: event.documentId,
        status: `processing: ${event.type}`,
        active: true,
      }),
    }).catch((err) => {
      console.error("[Monitor] Awareness update failed:", err instanceof Error ? err.message : err);
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error("SSE stream ended");

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

      let event: TandemEvent | null;
      try {
        event = parseTandemEvent(JSON.parse(data));
      } catch {
        console.error("[Monitor] Malformed SSE event data (skipping):", data.slice(0, 200));
        continue;
      }
      if (!event) {
        console.error("[Monitor] Received invalid SSE event, skipping");
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

      // Each stdout line = one Claude notification.
      // Collapse newlines so multi-line content stays as a single notification.
      const content = formatEventContent(event).replace(/\n/g, " ");
      process.stdout.write(content + "\n");

      scheduleAwareness(event);
    }
  }
}

// --- Cached mode lookup ---

let cachedMode: string = "tandem";
let cachedModeAt = 0;

async function getCachedMode(): Promise<string> {
  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_TTL_MS) return cachedMode;
  try {
    const res = await fetch(`${TANDEM_URL}/api/mode`);
    if (res.ok) {
      const { mode } = (await res.json()) as { mode: string };
      cachedMode = mode;
    } else {
      console.error(`[Monitor] Mode check returned ${res.status}, using cached: "${cachedMode}"`);
    }
    cachedModeAt = now;
  } catch (err) {
    console.error(
      "[Monitor] Mode check failed, delivering event (fail-open):",
      err instanceof Error ? err.message : err,
    );
    cachedModeAt = now;
  }
  return cachedMode;
}

// --- Start ---

main().catch((err) => {
  console.error("[Monitor] Fatal error:", err);
  process.exit(1);
});
