/**
 * Pure decision helpers for the integration wizard's Done screen.
 *
 * Extracted from `IntegrationWizardModal.svelte` so the honesty contract
 * (WS-B) can be unit-tested without mounting the modal — the derived that
 * consumes this is a thin wrapper.
 */

import { type IntegrationConfig, targetPushSupport } from "../../shared/integrations/contract.js";

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

/** Copy for a client Tandem structurally cannot notify. */
export interface PushSupportNote {
  text: string;
  /** Screen-reader form — the visible line leans on the row's target label. */
  ariaLabel: string;
}

/**
 * Deliberately kind-agnostic: it is rendered inside a result row that already
 * names the target, and it must stay correct if a second kind ever joins
 * `"none"`. It states only the sound half of `TargetPushSupport` — that nothing
 * will notify — and reframes the consequence as deferred, not lost, matching
 * the `no-push` send notice in `status/addressed-ai-notice.ts`.
 */
const NO_PUSH_TRANSPORT: PushSupportNote = {
  text: "No real-time updates for this app — it sees your comments and messages the next time you prompt it, not as they happen.",
  ariaLabel:
    "Tandem cannot notify this app in real time. It sees your comments and messages the next time you prompt it.",
};

/**
 * The Done screen's per-target delivery line, or `null` to say nothing.
 *
 * Only the confirmed-`"none"` case renders. `"possible"` stays SILENT rather
 * than rendering an affirmative counterpart — a transport existing in the
 * config is not delivery (`connection-honesty-findings.md` A5/A7), and the
 * wizard already has a separate, correctly-hedged push-mode block for the
 * Claude Code side. Adding "real-time updates are on" here would be exactly the
 * guarantee `targetPushSupport`'s docblock forbids.
 *
 * Unknown / unapplicable kinds (`other-mcp`, or a row whose picked entry has
 * gone) also return `null`: absence of knowledge is not a negative. That is the
 * same asymmetry `PushDelivery`'s `"unknown"` encodes.
 *
 * #1299: this fact was decided at wizard time and never spoken. The reporter
 * connected Claude Desktop, saw "AI connected", sent two messages, and was
 * ignored — because for that client push does not fail, it does not exist.
 */
export function pushSupportNote(
  kind: IntegrationConfig["kind"] | undefined,
): PushSupportNote | null {
  if (kind !== "claude-code" && kind !== "claude-desktop") return null;
  return targetPushSupport(kind) === "none" ? NO_PUSH_TRANSPORT : null;
}
