/**
 * SSE event bridge: connects to Tandem server's /api/events endpoint and
 * pushes received events to Claude Code as channel notifications.
 *
 * All retry / SSE-frame / awareness / mode-cache logic lives in the shared
 * `src/shared/sse-consumer.ts` module (extracted in #282). This file is the
 * thin MCP-aware adapter that owns the delivery callback.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { formatEventContent, formatEventMeta } from "../shared/events/types.js";
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
  });
}
