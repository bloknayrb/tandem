/**
 * Tandem mcp-stdio subcommand — stdio ↔ Streamable HTTP JSON-RPC proxy.
 *
 * Claude Desktop's plugin loader bridges stdio MCP servers into sandboxed
 * sessions but not HTTP MCP servers, so plugin-cached stdio entries that
 * forward to the local HTTP MCP endpoint are the only supported way to
 * surface tandem_* tools into those sessions.
 *
 * Raw message forwarding: no handler registrations, no per-method logic.
 * Any message the upstream emits (tool results, notifications, future
 * methods we haven't heard of) reaches the stdio client unchanged.
 *
 * Intentional: no reconnection logic. If the upstream HTTP server dies
 * mid-session, `http.onclose` fires and we exit(0). The plugin loader will
 * respawn us on the next tool call and the preflight will re-run with a
 * fresh, accurate error if the server is still down. A reconnect loop here
 * would hide server death from the user.
 */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { redirectConsoleToStderr, resolveTandemUrl } from "../shared/cli-runtime.js";
import { ensureTandemServer } from "./preflight.js";

redirectConsoleToStderr();

export async function runMcpStdio(): Promise<void> {
  const baseUrl = resolveTandemUrl();
  await ensureTandemServer({ url: baseUrl });

  const http = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
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

  // stdio first: if http.start() throws in the window between preflight and
  // here, the stderr log still reaches the upstream instead of dying silent.
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
