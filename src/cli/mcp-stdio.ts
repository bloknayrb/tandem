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
 * Error surfacing (issue #336): the stdio transport is started before
 * preflight and http.start(), and early messages are buffered until the
 * upstream is ready. If the upstream never becomes ready — or dies mid-
 * session — every in-flight request ID is answered with a synthesized
 * `-32000` JSON-RPC error instead of a silent stdio close. Plugin hosts
 * surface `-32000` as actionable; a silent close is what produces "tools
 * never appear in Cowork" with nothing diagnosable in the logs.
 *
 * Intentional: no reconnection logic. If the upstream HTTP server dies
 * mid-session, we synthesize errors for pending requests and exit 1.
 * The plugin loader will respawn us on the next tool call and preflight
 * will re-run with a fresh, accurate error if the server is still down.
 */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { redirectConsoleToStderr, resolveTandemUrl } from "../shared/cli-runtime.js";
import { probeTandemServer } from "./preflight.js";

redirectConsoleToStderr();

// After preflight or http.start() fails we wait ~1.5s for any already-in-
// flight `initialize` from the plugin loader to land on stdin and receive
// a -32000 reply before tear-down. Sizing covers stdin-read lag between
// preflight resolution and the first message arrival; unrelated to
// preflight's own 2s fetch timeout.
const PREFLIGHT_GRACE_MS = 1500;

// Last-gasp handlers for truly unexpected crashes: write one diagnostic to
// stderr before exit. Installed at module load; process.once bounds each
// handler to a single fire. No -32000 synthesis here because pendingIds
// lives inside runMcpStdio()'s closure.
process.once("uncaughtException", (err: Error) => {
  process.stderr.write(
    `[tandem mcp-stdio] uncaughtException: ${err.message}\n${err.stack ?? ""}\n`,
  );
  process.exit(1);
});
process.once("unhandledRejection", (reason: unknown) => {
  const detail = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[tandem mcp-stdio] unhandledRejection: ${detail}\n`);
  process.exit(1);
});

export async function runMcpStdio(): Promise<void> {
  const baseUrl = resolveTandemUrl();

  const http = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  const stdio = new StdioServerTransport();

  // Requests forwarded to upstream but not yet responded to. On upstream
  // failure we synthesize -32000 for every entry before exit.
  const pendingIds = new Set<string | number>();
  // Messages received from stdin before `httpReady` flips. On success they
  // are drained and forwarded; on preflight/http-start failure each request
  // in the buffer gets a -32000 reply.
  const preReadyBuffer: JSONRPCMessage[] = [];
  let shuttingDown = false;
  let httpReady = false;

  async function sendErrorResponse(
    id: string | number,
    message: string,
    detail?: string,
  ): Promise<void> {
    const errorResponse: JSONRPCMessage = {
      jsonrpc: "2.0",
      id,
      error: {
        // -32000 is the implementation-defined server error range per
        // JSON-RPC 2.0 §5.1 — upstream unavailability is an application-
        // level condition, not a generic Internal Error.
        code: -32000,
        message,
        ...(detail !== undefined ? { data: { detail } } : {}),
      },
    };
    try {
      await stdio.send(errorResponse);
    } catch (err) {
      // stdio already torn down; log so synth failures during shutdown
      // (e.g., http.onclose racing stdio.onclose) aren't silently dropped —
      // a silent drop here would recreate exactly the failure mode this
      // module exists to prevent.
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[tandem mcp-stdio] failed to send synthesized error for id ${id}: ${detail}\n`,
      );
    }
  }

  function forwardToUpstream(msg: JSONRPCMessage): void {
    const requestId = getRequestId(msg);
    if (requestId !== undefined) pendingIds.add(requestId);
    http.send(msg).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tandem mcp-stdio] upstream send failed: ${detail}\n`);
      if (requestId !== undefined) {
        pendingIds.delete(requestId);
        void sendErrorResponse(requestId, "Tandem HTTP upstream unreachable", detail);
      }
    });
  }

  async function synthesizeBuffered(message: string, detail?: string): Promise<void> {
    const buffered = preReadyBuffer.splice(0);
    const ids = buffered
      .map((msg) => getRequestId(msg))
      .filter((id): id is string | number => id !== undefined);
    for (const id of ids) {
      await sendErrorResponse(id, message, detail);
    }
  }

  async function synthesizePending(message: string, detail?: string): Promise<void> {
    if (pendingIds.size === 0) return;
    const ids = [...pendingIds];
    pendingIds.clear();
    await Promise.all(ids.map((id) => sendErrorResponse(id, message, detail)));
  }

  const shutdown = async (
    code = 0,
    synth?: { message: string; detail?: string },
  ): Promise<never> => {
    if (!shuttingDown) {
      shuttingDown = true;
      if (synth) {
        await synthesizeBuffered(synth.message, synth.detail);
        await synthesizePending(synth.message, synth.detail);
      }
      await http.close().catch(() => {});
      await stdio.close().catch(() => {});
    }
    process.exit(code);
  };

  stdio.onmessage = (msg: JSONRPCMessage) => {
    if (!httpReady) {
      preReadyBuffer.push(msg);
      return;
    }
    forwardToUpstream(msg);
  };

  http.onmessage = (msg: JSONRPCMessage) => {
    const responseId = getResponseId(msg);
    if (responseId !== undefined) pendingIds.delete(responseId);
    stdio.send(msg).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tandem mcp-stdio] stdio write failed: ${detail}\n`);
    });
  };

  stdio.onerror = (err) => {
    process.stderr.write(`[tandem mcp-stdio] stdio error: ${err.message}\n${err.stack ?? ""}\n`);
  };
  http.onerror = (err) => {
    const cause = (err as { cause?: unknown }).cause;
    process.stderr.write(
      `[tandem mcp-stdio] http error: ${err.message}\n${err.stack ?? ""}${cause !== undefined ? `\ncause: ${cause}` : ""}\n`,
    );
  };

  stdio.onclose = () => {
    void shutdown(0);
  };
  http.onclose = () => {
    if (shuttingDown) return;
    void shutdown(1, {
      message: "Tandem HTTP upstream closed unexpectedly",
      detail: "upstream connection dropped mid-session",
    });
  };

  // Start stdio BEFORE preflight so any `initialize` that arrives during
  // the preflight window is captured and either forwarded once upstream is
  // ready, or answered with -32000 if upstream never comes up.
  await stdio.start();

  const probe = await probeTandemServer({ url: baseUrl });
  if (!probe.ok) {
    process.stderr.write(
      `[tandem mcp-stdio] Tandem server not reachable at ${probe.url} (${probe.reason}).\n` +
        `[tandem mcp-stdio] Start the Tauri app or run \`tandem start\` on the host, then retry.\n`,
    );
    // Stay listen-only briefly so any already-buffered request (the plugin
    // loader typically writes `initialize` the moment after spawn) gets a
    // -32000 reply before we tear down. stdio.onclose short-circuits if
    // the loader closes stdin first.
    setTimeout(() => {
      void shutdown(1, {
        message: "Tandem server not running. Start the Tauri app or run `tandem start`.",
        detail: probe.reason,
      });
    }, PREFLIGHT_GRACE_MS);
    return;
  }

  try {
    await http.start();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[tandem mcp-stdio] upstream http start failed: ${detail}\n`);
    setTimeout(() => {
      void shutdown(1, {
        message: "Tandem HTTP upstream failed to start",
        detail,
      });
    }, PREFLIGHT_GRACE_MS);
    return;
  }
  httpReady = true;

  // Drain any requests that arrived while preflight + http.start() were
  // running. They were held to preserve forwarding semantics — now that
  // upstream is ready, push them through the normal path.
  const buffered = preReadyBuffer.splice(0);
  for (const msg of buffered) forwardToUpstream(msg);
}

export function getRequestId(msg: JSONRPCMessage): string | number | undefined {
  const m = msg as { id?: unknown; method?: unknown };
  if (typeof m.method !== "string") return undefined;
  if (typeof m.id === "string" || typeof m.id === "number") return m.id;
  return undefined;
}

export function getResponseId(msg: JSONRPCMessage): string | number | undefined {
  const m = msg as { id?: unknown; method?: unknown };
  if (typeof m.method === "string") return undefined;
  if (typeof m.id === "string" || typeof m.id === "number") return m.id;
  return undefined;
}
