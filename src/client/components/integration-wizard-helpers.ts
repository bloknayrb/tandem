/**
 * Pure decision helpers for the integration wizard's Done screen.
 *
 * Extracted from `IntegrationWizardModal.svelte` so the honesty contract
 * (WS-B) can be unit-tested without mounting the modal — the derived that
 * consumes this is a thin wrapper.
 */

export type DoneHeaderState = "connected" | "waiting" | "partial";

/**
 * The Done header must not claim connection before it happens (WS-B). A
 * successful config WRITE is not a connection — Claude has to restart to load
 * the entry — so the headline and its success glyph gate on the actual
 * `claudeConnected` round-trip, not on the apply succeeding. A green check
 * above "waiting" copy would re-tell the very lie this feature fixes.
 *
 * - `partial` — at least one apply item errored (takes precedence; a broken
 *   write can't have connected).
 * - `connected` — Claude has actually reached the server.
 * - `waiting` — config written, no connection yet (the common post-apply state).
 */
export function computeDoneHeaderState(
  anyApplyErrors: boolean,
  claudeConnected: boolean,
): DoneHeaderState {
  if (anyApplyErrors) return "partial";
  return claudeConnected ? "connected" : "waiting";
}
