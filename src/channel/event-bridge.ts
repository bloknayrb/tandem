/**
 * SSE event bridge: connects to Tandem server's /api/events endpoint
 * and pushes received events to Claude Code as channel notifications.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { authFetch } from "../shared/cli-runtime.js";
import { CHANNEL_MAX_RETRIES, CHANNEL_RETRY_DELAY_MS } from "../shared/constants.js";
import type { TandemEvent } from "../shared/events/types.js";
import { formatEventContent, formatEventMeta, parseTandemEvent } from "../shared/events/types.js";

const AWARENESS_DEBOUNCE_MS = 500;
const MODE_CACHE_TTL_MS = 2000;

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
          await authFetch(`${tandemUrl}/api/channel-error`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              error: "CHANNEL_CONNECT_FAILED",
              message: `Channel shim lost connection after ${CHANNEL_MAX_RETRIES} retries.`,
            }),
          });
        } catch (reportErr) {
          console.error(
            "[Channel] Could not report failure to server:",
            reportErr instanceof Error ? reportErr.message : reportErr,
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

  const res = await authFetch(`${tandemUrl}/api/events`, { headers });
  if (!res.ok) throw new Error(`SSE endpoint returned ${res.status}`);
  if (!res.body) throw new Error("SSE endpoint returned no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Debounced awareness: only send the latest status after a quiet period
  let awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  let clearAwarenessTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingAwareness: TandemEvent | null = null;
  const AWARENESS_CLEAR_MS = 3000; // Reset active state after 3s of no new events

  function clearAwareness(documentId?: string) {
    authFetch(`${tandemUrl}/api/channel-awareness`, {
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
    authFetch(`${tandemUrl}/api/channel-awareness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: event.documentId,
        status: `processing: ${event.type}`,
        active: true,
      }),
    }).catch((err) => {
      console.error("[Channel] Awareness update failed:", err instanceof Error ? err.message : err);
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
        console.error("[Channel] Malformed SSE event data (skipping):", data.slice(0, 200));
        continue;
      }
      if (!event) {
        console.error("[Channel] Received invalid SSE event, skipping");
        continue;
      }

      // Solo mode suppression: drop non-chat events when mode is "solo"
      if (event.type !== "chat:message") {
        const mode = await getCachedMode(tandemUrl);
        if (mode === "solo") {
          console.error(`[Channel] Solo mode: suppressed ${event.type} event`);
          if (eventId) onEventId(eventId);
          continue;
        }
      }

      if (eventId) onEventId(eventId);

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

      scheduleAwareness(event);
    }
  }
}

// Cached mode lookup — avoids an HTTP fetch per event
let cachedMode: string = "tandem";
let cachedModeAt = 0;

async function getCachedMode(tandemUrl: string): Promise<string> {
  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_TTL_MS) return cachedMode;
  try {
    const res = await authFetch(`${tandemUrl}/api/mode`);
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
      err instanceof Error ? err.message : err,
    );
    cachedModeAt = now;
  }
  return cachedMode;
}
