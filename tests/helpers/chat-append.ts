import type { ClaudeChatAppend } from "../../src/server/mcp/awareness.js";

/**
 * Unwrap an admitted `appendClaudeChatMessage` result to its message id (#1521).
 * Throws on a licence refusal, which none of these callers expect: they run
 * with the gate dark, where every append is admitted.
 */
export function appendedId(result: ClaudeChatAppend): string {
  if (!result.ok) throw new Error(`appendClaudeChatMessage refused: ${result.refusal.message}`);
  return result.id;
}
