/**
 * Per-request Claude-session context for MCP tool handlers.
 *
 * Tool handlers are registered once per `McpServer` and receive only their
 * declared arguments — there is no parameter carrying "who called me". This
 * module provides that out-of-band, so a handler can learn its calling Claude
 * Code session without threading an extra argument through all six
 * `register*Tools` functions.
 *
 * **Why AsyncLocalStorage is safe here.** The SDK dispatches `tools/call`
 * through an unbroken promise chain rooted in the awaited
 * `transport.handleRequest(...)` call in the `/mcp` route:
 *
 *   handleRequest (streamableHttp.js)
 *     → onmessage(...)                  (webStandardStreamableHttp.js, sync call)
 *     → Protocol._onrequest             (shared/protocol.js)
 *     → Promise.resolve().then(handler) (shared/protocol.js)
 *     → McpServer's CallToolRequestSchema handler (server/mcp.js)
 *     → the registered tool callback
 *
 * Every hop is a `.then()`/`await` continuation of the original call — there is
 * no `setTimeout`/`setImmediate`, no independent event-emitter tick, and no
 * detour through the standalone GET SSE stream (that stream carries only
 * server-initiated notifications; a tool call's request/response correlation
 * happens on its own POST stream). AsyncLocalStorage propagates across exactly
 * this kind of chain, so a `run()` wrapping the awaited `handleRequest` is
 * visible to the tool handler.
 *
 * The corollary is a constraint: the `run()` MUST wrap the entire awaited
 * `handleRequest` call. Wrapping only the synchronous dispatch, or resolving
 * the context into a module-level "current session" variable instead, would be
 * racy under concurrent requests from different sessions.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface McpRequestContext {
  /**
   * The Claude Code session id from `X-Claude-Session-Id`, when the calling
   * transport carries one.
   *
   * Absent for callers configured with a direct-HTTP `.mcp.json` entry
   * (`{type:"http", url}`), which has no subprocess for Claude Code to inject
   * `CLAUDE_CODE_SESSION_ID` into and only static headers written at setup
   * time. Present for the stdio-bridge entry (`tandem mcp-stdio`), which runs
   * as a Claude Code subprocess and forwards the id. Callers must treat this as
   * optional and degrade to session-agnostic behavior, never assume it.
   */
  claudeSessionId?: string;
  /** The MCP transport session id (`Mcp-Session-Id`). Always present. */
  mcpSessionId?: string;
}

const storage = new AsyncLocalStorage<McpRequestContext>();

/** Run `fn` with the given request context bound for its entire async extent. */
export function runWithMcpContext<T>(ctx: McpRequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The full context for the in-flight MCP request, or undefined outside one. */
export function getMcpContext(): McpRequestContext | undefined {
  return storage.getStore();
}

/**
 * The calling Claude Code session id, or undefined when unknown.
 *
 * Undefined has two distinct causes that callers generally should not
 * distinguish: not inside an MCP request at all (server-internal work), or a
 * transport that carries no `X-Claude-Session-Id` (see `McpRequestContext`).
 * Both mean "no session identity available" — fall back to session-agnostic
 * behavior rather than inventing an id.
 */
export function getCurrentSessionId(): string | undefined {
  return storage.getStore()?.claudeSessionId;
}
