/**
 * Tandem mcp-stdio subcommand — stdio ↔ Streamable HTTP JSON-RPC proxy.
 *
 * Claude Desktop's plugin loader bridges stdio MCP servers into Cowork VM
 * sessions but not HTTP MCP servers (verified empirically 2026-04-15, see
 * docs/superpowers/plans/2026-04-14-cowork-mcp-bridge.md). This subcommand
 * lets a plugin-cached stdio entry forward every JSON-RPC message to the
 * local HTTP MCP endpoint on :3479 transparently, so Cowork sees the full
 * tandem_* tool surface.
 *
 * Raw message forwarding: no handler registrations, no per-method logic.
 * Any message the upstream emits (tool results, notifications, future
 * methods we haven't heard of) reaches the stdio client unchanged.
 *
 * Intentional: no reconnection logic. If the upstream HTTP server dies
 * mid-session, `http.onclose` fires and we exit(0). Claude Desktop's plugin
 * loader will respawn us on the next tool call, and the preflight will
 * re-run with a fresh, accurate error if the server is still down. A
 * reconnect loop here would hide server death from the user.
 */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_MCP_PORT } from "../shared/constants.js";
import { ensureTandemServer } from "./preflight.js";

// stdout is the MCP wire in stdio mode — redirect incidental console output to stderr.
console.log = console.error;
console.warn = console.error;
console.info = console.error;

export async function runMcpStdio(): Promise<void> {
  const baseUrl = process.env.TANDEM_URL ?? `http://localhost:${DEFAULT_MCP_PORT}`;
  await ensureTandemServer({ url: baseUrl });

  const httpUrl = new URL(`${baseUrl.replace(/\/$/, "")}/mcp`);
  const http = new StreamableHTTPClientTransport(httpUrl);
  const stdio = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (code = 0): Promise<never> => {
    if (!shuttingDown) {
      shuttingDown = true;
      await http.close().catch(() => {});
      await stdio.close().catch(() => {});
    }
    process.exit(code);
  };

  stdio.onmessage = (msg: JSONRPCMessage) => {
    http.send(msg).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tandem mcp-stdio] upstream send failed: ${detail}\n`);
      const requestId = getRequestId(msg);
      if (requestId !== undefined) {
        const errorResponse: JSONRPCMessage = {
          jsonrpc: "2.0",
          id: requestId,
          error: {
            // -32000 is the implementation-defined server error range per
            // JSON-RPC 2.0 §5.1 — the upstream being unreachable is an
            // application-level condition, not a generic Internal Error.
            code: -32000,
            message: "Tandem HTTP upstream unreachable",
            data: { detail },
          },
        };
        stdio.send(errorResponse).catch(() => {});
      }
    });
  };

  http.onmessage = (msg: JSONRPCMessage) => {
    stdio.send(msg).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tandem mcp-stdio] stdio write failed: ${detail}\n`);
    });
  };

  stdio.onerror = (err) => {
    process.stderr.write(`[tandem mcp-stdio] stdio error: ${err.message}\n`);
  };
  http.onerror = (err) => {
    process.stderr.write(`[tandem mcp-stdio] http error: ${err.message}\n`);
  };

  stdio.onclose = () => {
    void shutdown(0);
  };
  http.onclose = () => {
    void shutdown(0);
  };

  // Start stdio first so we can report an HTTP start failure back to the
  // upstream client as a stderr line instead of a silently dead process —
  // the preflight already proved the server was reachable, but there's a
  // tiny window between preflight and http.start() where it can die.
  await stdio.start();
  try {
    await http.start();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[tandem mcp-stdio] upstream http start failed: ${detail}\n`);
    await shutdown(1);
  }
}

export function getRequestId(msg: JSONRPCMessage): string | number | undefined {
  const m = msg as { id?: unknown; method?: unknown };
  if (typeof m.method !== "string") return undefined;
  if (typeof m.id === "string" || typeof m.id === "number") return m.id;
  return undefined;
}
