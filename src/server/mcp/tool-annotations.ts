/**
 * MCP `ToolAnnotations` for the tools whose repeat is safe.
 *
 * A client reads these as behaviour, not documentation. Claude Code (since
 * 2.1.307) re-sends a call whose HTTP connection closed mid-call only when the
 * tool is read-only or idempotent, and non-interactive Codex refuses any call
 * that is not `readOnlyHint` (docs/spikes/2026-09-17-claude-merged-app-and-codex-mcp-probes.md
 * §5c). So a hint on a tool that is neither makes a lost response execute
 * twice, or lets a client auto-approve a write. Unannotated is the safe default
 * for anything not proven repeatable.
 *
 * `tandem_checkInbox` is deliberately unannotated: it commits its dedup ledgers
 * and marks chat read before the response is delivered, so a retry after a lost
 * response answers "No new actions" and the items are gone (#2294).
 *
 * `tests/server/mcp-tool-annotations.test.ts` holds one row per tool, with the
 * reason, against the production `tools/list`.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** No side effect at all: a pure read of server state. */
export const READ_ONLY_TOOL = {
  readOnlyHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

/**
 * Writes, but a repeat leaves the same state and destroys nothing — range
 * repairs that converge after one pass, or a status overwrite with the same text.
 */
export const IDEMPOTENT_WRITE_TOOL = {
  readOnlyHint: false,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

/**
 * Idempotent, but may overwrite a file the user owns (an existing sidecar), so
 * it is not claimed non-destructive.
 */
export const IDEMPOTENT_OVERWRITE_TOOL = {
  readOnlyHint: false,
  idempotentHint: true,
  destructiveHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;
