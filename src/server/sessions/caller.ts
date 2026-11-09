/**
 * Who is calling an MCP tool (#2358, ADR-054; ownership design §3.1).
 *
 * The caller is resolved **once**, at the entry of `withErrorBoundary`, and
 * handed to the tool handler as an explicit argument. Nothing reads the
 * ambient request context inside a handler body: this module is the only one
 * in `src` that imports a context getter (pinned by
 * `tests/server/mcp-context-seam.test.ts`; PR 1b adds `wake-url.ts`'s one
 * getter for `peerIsLoopback`).
 */

import { ownershipEnabled } from "../ownership-flag.js";
import { getMcpContext } from "./context.js";
import { getOwnershipTransportMode, LOCAL_OWNER_ID } from "./ownership.js";

export interface ToolCaller {
  /**
   * The calling Claude Code session id (`X-Claude-Session-Id`), when the
   * transport carried one. Optional on every path, as CLAUDE.md requires.
   */
  readonly claudeSessionId?: string;
  /** The caller's owner record. Always set while ownership is on; never while it is off. */
  readonly ownerId?: string;
}

/**
 * The caller of the tool call in flight, or `null` when ownership is on and no
 * caller can be named — which `withErrorBoundary` refuses (fail closed).
 *
 * - **Flag off:** the Claude session id from the request context, exactly the
 *   value `getCurrentSessionId()` returned to `tandem_reply` before #2358.
 *   Never null.
 * - **Flag on:** the dispatched transport's `ownerId`; with no request context
 *   at all, the process-wide `local` record if this is a stdio-mode server;
 *   otherwise `null`. In HTTP mode every request dispatched to a registered
 *   transport runs inside a context carrying that transport's `ownerId`, so a
 *   `null` there is a wiring fault, not something a client can cause. A
 *   process no boot has told its mode (a unit test) is treated like HTTP mode.
 */
export function resolveToolCaller(): ToolCaller | null {
  const ctx = getMcpContext();
  const claudeSessionId = ctx?.claudeSessionId;
  if (!ownershipEnabled()) {
    return claudeSessionId === undefined ? {} : { claudeSessionId };
  }
  if (ctx?.ownerId !== undefined) {
    return claudeSessionId === undefined
      ? { ownerId: ctx.ownerId }
      : { ownerId: ctx.ownerId, claudeSessionId };
  }
  if (ctx === undefined && getOwnershipTransportMode() === "stdio") {
    return { ownerId: LOCAL_OWNER_ID };
  }
  return null;
}
