/**
 * Tandem Channel Shim — core runtime, shared by:
 *   - src/channel/index.ts (standalone binary, used by the Desktop sidecar)
 *   - src/cli/channel.ts (npm-delivered entry for the plugin `tandem-channel`)
 *
 * Bridges Tandem's SSE event stream → Claude Code channel notifications,
 * and exposes a `tandem_reply` tool for Claude to respond to chat messages.
 *
 * Uses the low-level MCP `Server` class (not `McpServer`) as required by
 * the Channels API spec.
 */

import { createConnection } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { authFetch, redirectConsoleToStderr, resolveTandemUrl } from "../shared/cli-runtime.js";
import { DEFAULT_MCP_PORT } from "../shared/constants.js";
import { startEventBridge } from "./event-bridge.js";

export interface RunChannelOptions {
  /** Skip the non-fatal reachability probe. The CLI wrapper runs a strict
   *  preflight upstream and we don't want to double-log "server not reachable"
   *  noise. Defaults to false. */
  skipReachabilityLog?: boolean;
}

export async function runChannel(opts: RunChannelOptions = {}): Promise<void> {
  redirectConsoleToStderr();

  const tandemUrl = resolveTandemUrl();

  const mcp = new Server(
    { name: "tandem-channel", version: "0.1.0" },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
        tools: {},
      },
      instructions: [
        'Events from Tandem arrive as <channel source="tandem-channel" event_type="..." document_id="...">.',
        "These are real-time push notifications of user actions in the collaborative document editor.",
        "Event types: annotation:created, annotation:accepted, annotation:dismissed, annotation:reply,",
        "chat:message, document:opened, document:closed, document:switched.",
        "Chat messages may include a 'selection' field with buffered selection context.",
        "Use your tandem MCP tools (tandem_getTextContent, tandem_comment, tandem_highlight, etc.) to act on them.",
        "Reply to chat messages using tandem_reply. Pass document_id from the tag attributes.",
        "Do not reply to non-chat events — just act on them using tools.",
        "If you haven't received channel notifications recently, call tandem_checkInbox as a fallback.",
      ].join(" "),
    },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "tandem_reply",
        description: "Reply to a chat message in Tandem",
        inputSchema: {
          type: "object" as const,
          properties: {
            text: { type: "string", description: "The reply message" },
            documentId: {
              type: "string",
              description: "Document ID from the channel event (optional)",
            },
            replyTo: {
              type: "string",
              description: "Message ID being replied to (optional)",
            },
          },
          required: ["text"],
        },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "tandem_reply") {
      const args = req.params.arguments as Record<string, unknown>;
      try {
        const res = await authFetch(`${tandemUrl}/api/channel-reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        });
        let data: unknown;
        try {
          data = await res.json();
        } catch {
          data = { message: "Non-JSON response" };
        }
        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Reply failed (${res.status}): ${JSON.stringify(data)}`,
              },
            ],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to send reply: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
    throw new Error(`Unknown tool: ${req.params.name}`);
  });

  const PermissionRequestSchema = z.object({
    method: z.literal("notifications/claude/channel/permission_request"),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  });

  mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    try {
      const res = await authFetch(`${tandemUrl}/api/channel-permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: params.request_id,
          toolName: params.tool_name,
          description: params.description,
          inputPreview: params.input_preview,
        }),
      });
      if (!res.ok) {
        console.error(
          `[Channel] Permission relay got HTTP ${res.status} — browser may not see prompt`,
        );
      }
    } catch (err) {
      console.error("[Channel] Failed to forward permission request:", err);
    }
  });

  console.error(`[Channel] Tandem channel shim starting (server: ${tandemUrl})`);

  if (!opts.skipReachabilityLog) {
    const reachable = await checkServerReachable(tandemUrl);
    if (!reachable) {
      console.error(`[Channel] Cannot reach Tandem server at ${tandemUrl}`);
      console.error("[Channel] Start it with: tandem start");
      // Continue anyway — the event bridge will retry, and the server may start later
    }
  }

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error("[Channel] Connected to Claude Code via stdio");

  startEventBridge(mcp, tandemUrl).catch((err) => {
    console.error("[Channel] Event bridge failed unexpectedly:", err);
    process.exit(1);
  });
}

async function checkServerReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error(
      `[Channel] Invalid TANDEM_URL: "${url}" — expected format: http://localhost:3479`,
    );
    return false;
  }
  const port = parseInt(parsed.port || String(DEFAULT_MCP_PORT), 10);
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: parsed.hostname }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", (err) => {
      console.error(`[Channel] Server probe failed: ${err.message}`);
      socket.destroy();
      resolve(false);
    });
  });
}
