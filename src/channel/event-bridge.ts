/**
 * SSE event bridge: connects to Tandem server's /api/events endpoint and
 * pushes received events to Claude Code as channel notifications.
 *
 * All retry / SSE-frame / awareness / mode-cache logic lives in the shared
 * `src/shared/sse-consumer.ts` module (extracted in #282). This file is the
 * thin MCP-aware adapter that owns the delivery callback.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  formatEventContent,
  formatEventMeta,
  LICENSE_REFUSED_EVENT_TYPE,
} from "../shared/events/types.js";
import { runEventConsumer } from "../shared/sse-consumer.js";
import { CHANNEL_CONNECT_FAILED } from "../shared/types.js";

/**
 * Stdio-mode SSE bridge. New push-path work should target src/monitor/.
 * This path remains active for stdio-mode Claude Code connections.
 */
export async function startEventBridge(mcp: Server, tandemUrl: string): Promise<void> {
  return runEventConsumer({
    tandemUrl,
    logPrefix: "[Channel]",
    errorCode: CHANNEL_CONNECT_FAILED,
    onEvent: (event) =>
      mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: formatEventContent(event),
          meta: formatEventMeta(event),
        },
      }),
    // #1521: stderr is invisible to the model, so a refused stream would
    // otherwise go silent. One channel notification per refused stretch (the
    // consumer latches it; it re-arms on the next admitted handshake), the same
    // cost as the plugin monitor's stdout line. `content` is the server's fixed
    // refusal copy, never document or chat content. The meta key and value use
    // underscores: the Channels API silently drops hyphenated keys.
    onLicenseRefused: (message) => {
      mcp
        .notification({
          method: "notifications/claude/channel",
          params: { content: message, meta: { event_type: LICENSE_REFUSED_EVENT_TYPE } },
        })
        .catch((err: unknown) => {
          console.error("[Channel] Failed to send the licence-refusal notice:", err);
        });
    },
  });
}
