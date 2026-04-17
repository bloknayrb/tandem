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
// preflight resolution and first message arrival — independent of
// preflight's own fetch timeout.
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

  // On upstream failure we synthesize -32000 for every entry before exit.
  const pendingIds = new Set<string | number>();
  // Messages arriving before httpReady flips; either drained and forwarded
  // on success, or each request answered with -32000 on preflight/http-start
  // failure.
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
      // `delete` returns true iff the id was still pending — prevents double-
      // synth if a future change ever allows synthesizePending to fire while
      // http.send is still in flight. (Not a current bug; belt-and-suspenders.)
      if (requestId !== undefined && pendingIds.delete(requestId)) {
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
      await http.close().catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[tandem mcp-stdio] http.close failed: ${detail}\n`);
      });
      await stdio.close().catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[tandem mcp-stdio] stdio.close failed: ${detail}\n`);
      });
    }
    process.exit(code);
  };

  // Plugin hosts typically send `initialize` immediately after spawn (MCP
  // lifecycle §initialization). Deferring shutdown by PREFLIGHT_GRACE_MS
  // lets that request land during the preflight/start window and receive
  // a -32000 reply rather than a silent stdio close. stdio.onclose
  // short-circuits this if the loader closes stdin first.
  function deferredShutdown(synth: { message: string; detail?: string }): void {
    setTimeout(() => void shutdown(1, synth), PREFLIGHT_GRACE_MS);
  }

  stdio.onmessage = (msg: JSONRPCMessage) => {
    if (!httpReady) {
      preReadyBuffer.push(msg);
      return;
    }
    forwardToUpstream(msg);
  };

  http.onmessage = (msg: JSONRPCMessage) => {
    const responseId = getResponseId(msg);
    stdio.send(msg).then(
      () => {
        if (responseId !== undefined) pendingIds.delete(responseId);
      },
      (err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[tandem mcp-stdio] stdio write failed for id ${responseId ?? "<notification>"}: ${detail}\n`,
        );
        // Leave responseId in pendingIds — shutdown's synthesizePending will
        // retry via sendErrorResponse. If stdio is truly gone, that send also
        // fails and we log twice. Safe delete-after-send narrows the pending
        // window; it never widens for well-ordered responses.
        void shutdown(1, {
          message: "Tandem stdio write failed",
          detail,
        });
      },
    );
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
    // We've observed the current @modelcontextprotocol/sdk (0.20.x) only
    // firing onclose from inside its own close() method — i.e., as a
    // consequence of *our* shutdown. The synth branch below is defensive
    // for future SDK versions that may propagate socket-death as onclose.
    // The `shuttingDown` guard prevents double-synth when shutdown() calls
    // http.close() itself.
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
    const guidance =
      probe.kind === "unreachable"
        ? "Start the Tauri app or run `tandem start` on the host, then retry."
        : "The Tandem server is running but unhealthy — check the host logs.";
    process.stderr.write(
      `[tandem mcp-stdio] Tandem server preflight failed at ${probe.url} (${probe.reason}).\n` +
        `[tandem mcp-stdio] ${guidance}\n`,
    );
    const synthMessage =
      probe.kind === "unreachable"
        ? "Tandem server not running. Start the Tauri app or run `tandem start`."
        : "Tandem server unhealthy (check host logs).";
    deferredShutdown({ message: synthMessage, detail: probe.reason });
    return;
  }

  // The current @modelcontextprotocol/sdk's StreamableHTTPClientTransport.start()
  // only creates an AbortController and returns synchronously — this catch is
  // defensive for future SDK versions that may perform real I/O during start().
  try {
    await http.start();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[tandem mcp-stdio] upstream http start failed: ${detail}\n`);
    deferredShutdown({ message: "Tandem HTTP upstream failed to start", detail });
    return;
  }
  httpReady = true;

  // Held to preserve forwarding semantics — push through the normal path
  // now that upstream is ready. Note: forwardToUpstream does not await the
  // http.send, so buffered requests POST in parallel. Plugin hosts wait
  // for `initialize` to resolve before sending follow-ups per MCP spec, so
  // the buffer is usually ≤1 entry; we don't enforce serial ordering here.
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
