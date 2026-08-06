import type { AiChip } from "../hooks/useAiReadiness.svelte";

/**
 * Which notice (if any) a `tandem:addressed-ai` event should raise.
 *
 * Extracted rather than inlined in `App.svelte`, for the same reason
 * `status-ai-view.ts` was: the ordering between these branches is load-bearing
 * and easy to get subtly wrong, and a pure function can be unit-tested without
 * mounting the whole app. The precedent is not decoration — the CTA this
 * handler renders has already shipped one wrong-branch bug (see `AI_CTA`'s doc
 * comment, where a binary ternary sent `setup` users down the restart path).
 *
 * There are TWO distinct silences, and conflating them is the bug this exists
 * to prevent:
 *
 *   - `no-agent` — nothing is attached. The message waits for an agent.
 *   - `no-push`  — an agent IS attached and can read the document, but no
 *     real-time consumer is delivering to it, so it won't look until its next
 *     `tandem_checkInbox`. This is the hand-launched session, and it is the
 *     COMMON case: the channel shim needs a flag most users never type, and the
 *     supervisor's stdin wake only reaches sessions Tandem itself spawned.
 *
 * Ordering rules (order is load-bearing):
 *   1. Solo outranks everything. The user deliberately opted out of AI
 *      surfacing, so both notices contradict that intent — the same reasoning
 *      that makes `chip` null in Solo.
 *   2. A live session decides which branch applies. Without one, only the
 *      agent-absence notice can be correct; with one, only the delivery notice
 *      can be.
 *   3. `no-push` fires ONLY on a confirmed zero. `routes/health.ts:43-45` is
 *      explicit that `subscribers: 0` is a sound negative while any positive
 *      count includes an attached-but-inert shim — so `true` and `null` (field
 *      absent, redacted, or not yet read) must both stay silent. Guessing here
 *      would tell a working user their comment went nowhere.
 */
export type AddressedAiNotice =
  | { kind: "no-agent"; chip: Exclude<AiChip, null> }
  | { kind: "no-push" }
  | null;

export function addressedAiNotice(input: {
  soloMode: boolean;
  /** Fresh `/health` confirmation that an MCP transport is open. */
  sessionLive: boolean;
  /** Re-read after the probe — readiness may have settled while it was in flight. */
  chip: AiChip;
  /** `null` = unknown. Only `false` is actionable. */
  pushConsumerAttached: boolean | null;
}): AddressedAiNotice {
  // Rule 1.
  if (input.soloMode) return null;

  // Rule 2 — no agent attached.
  if (!input.sessionLive) {
    // `chip` is null while booting, and in the launcher's running-but-no-session
    // startup window. Neither is a state worth alarming about.
    return input.chip === null ? null : { kind: "no-agent", chip: input.chip };
  }

  // Rule 3 — attached, but is anything delivering?
  return input.pushConsumerAttached === false ? { kind: "no-push" } : null;
}
