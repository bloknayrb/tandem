/**
 * SSE event bridge: connects to Tandem server's /api/events endpoint
 * and pushes received events to Claude Code as channel notifications.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { TandemEvent } from "../server/events/types.js";
import { formatEventContent, formatEventMeta, parseTandemEvent } from "../server/events/types.js";
import { CHANNEL_MAX_RETRIES, CHANNEL_RETRY_DELAY_MS } from "../shared/constants.js";

const AWARENESS_DEBOUNCE_MS = 500;

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
          await fetch(`${tandemUrl}/api/channel-error`, {
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

  const res = await fetch(`${tandemUrl}/api/events`, { headers });
  if (!res.ok) throw new Error(`SSE endpoint returned ${res.status}`);
  if (!res.body) throw new Error("SSE endpoint returned no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Debounced awareness: only send the latest status after a quiet period
  let awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingAwareness: TandemEvent | null = null;

  function flushAwareness() {
    if (!pendingAwareness) return;
    const event = pendingAwareness;
    pendingAwareness = null;
    fetch(`${tandemUrl}/api/channel-awareness`, {
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
