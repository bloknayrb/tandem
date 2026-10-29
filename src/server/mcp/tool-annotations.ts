/**
 * MCP `ToolAnnotations` for the tools whose repeat is safe.
 *
 * A client reads these as behaviour, not documentation. Claude Code (since
 * 2.1.307, per its CHANGELOG.md) re-sends a call whose HTTP connection closed
 * mid-call only when the tool is read-only or idempotent, and non-interactive
 * Codex gates approval on them — it refused every call while Tandem declared
 * none (docs/spikes/2026-09-17-claude-merged-app-and-codex-mcp-probes.md §5c). So a hint on a tool that is neither makes a lost response execute
 * twice, or lets a client auto-approve a write. Unannotated is the safe default
 * for anything not proven repeatable.
 *
 * `tandem_checkInbox` is idempotent WITH a cursor (#2294), and what is
 * idempotent is its writes, not its response. Every write follows from the
 * cursor passed IN: the acknowledgement it applies (chat stamped read — a
 * second stamp writes nothing — and registry entries marked acknowledged), the
 * seqs it assigns to items it returns (a repeat looks the same versions up),
 * the entries it retires (gone after the first call), and range repairs that
 * converge like `tandem_getAnnotations`'. Its response is what that cursor is
 * owed at the time: everything the lost response held, plus anything newer,
 * less anything that stopped qualifying.
 *
 * WITHOUT a cursor it is not idempotent — it stamps what it returns into the
 * shared ledger, so a repeat returns none of it — and the hint is still safe:
 * a client retries only a call whose response it lost, those items were
 * already stamped by that first call and are gone with or without the retry,
 * and the retry adds neither a loss nor a duplicate, only what arrived since.
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
