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

/**
 * Copy for a client Tandem structurally cannot notify.
 *
 * `text` only — no `ariaLabel` sibling, unlike `AI_CTA` and `AiIndicatorView`.
 * Those describe a terse control ("AI connected", a button) whose visible text
 * under-specifies it; this is a full sentence rendered as plain body text in a
 * `<span>`, so the accessible name IS the text. Adding an `aria-label` would
 * also be ARIA-prohibited on a generic element and can suppress the content it
 * was meant to clarify.
 */
export interface PushSupportNote {
  text: string;
}

/**
 * Deliberately kind-agnostic: it is rendered inside a result row that already
 * names the target, and it must stay correct if a second kind ever joins
 * `"none"`. It states only the sound half of `TargetPushSupport` — that nothing
 * will notify — and reframes the consequence as deferred, not lost.
 *
 * Two words in it are load-bearing, and the first draft got both wrong.
 *
 * "Tandem can't notify this one", not "no real-time updates for this app": the
 * sentence is read INSIDE Tandem, where "this app" is at least as likely to
 * parse as Tandem itself. Naming the actor fixes the referent without naming a
 * kind, so the row's own label still supplies which target.
 *
 * "the next time it CHECKS IN", not "the next time you prompt it". Delivery is
 * the AI's action, not the user's: Claude sees a comment when it calls
 * `tandem_checkInbox`, which a given turn may simply not do. Promising it lands
 * on the next prompt is a delivery guarantee of exactly the kind
 * `targetPushSupport`'s docblock forbids — the same sin as reading
 * `subscribers > 0` as "push works", pointed the other way. This is now the
 * verbatim tail of `CONNECTED_NO_PUSH` in `status/status-ai-view.ts` and of the
 * `no-push` send notice, which is what "matches the sibling copy" was always
 * supposed to mean.
 */
const NO_PUSH_TRANSPORT: PushSupportNote = {
  text: "Tandem can't notify this one in real time — it'll see your comments and messages the next time it checks in, not as they happen.",
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
 * The guard EXCLUDES the kinds `targetPushSupport` cannot speak for rather than
 * listing the ones it can. Those are the same two sets today, but only the
 * exclusion form stays honest: `IntegrationConfig["kind"]` minus `"other-mcp"`
 * IS `DetectedTarget["kind"]`, so a future detected kind reaches the predicate
 * automatically. An allow-list would have silenced it — quietly reinstating the
 * very "we knew and didn't say" bug this function exists to fix, and the
 * predicate-pinned test above would not have caught it, since a kind absent
 * from the list is also absent from the loop.
 *
 * #1299: this fact was decided at wizard time and never spoken. The reporter
 * connected Claude Desktop, saw "AI connected", sent two messages, and was
 * ignored — because for that client push does not fail, it does not exist.
 */
export function pushSupportNote(
  kind: IntegrationConfig["kind"] | undefined,
): PushSupportNote | null {
  if (kind === undefined || kind === "other-mcp") return null;
  return targetPushSupport(kind) === "none" ? NO_PUSH_TRANSPORT : null;
}
