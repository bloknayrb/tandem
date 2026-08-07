import type { AiChip, PushDelivery } from "../hooks/useAiReadiness.svelte";

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
 * There are THREE distinct silences, and conflating them is the bug this exists
 * to prevent:
 *
 *   - `offline`  — the SERVER is gone, so the question "is an AI attached" has
 *     no meaningful answer. This is the newest branch and it exists because the
 *     other two both imply a working server. Without it the case fell into the
 *     `chip === null` hole below and produced NO notice at all: `state` is
 *     `booting` whenever `connected()` is false, so a send into a dead server
 *     was silent. That silence replaced a wrong message with no message, which
 *     is not the same as fixing it.
 *   - `no-agent` — the server is fine, nothing is attached. The message waits.
 *   - `no-push`  — an agent IS attached and can read the document, but no
 *     real-time consumer is delivering to it, so it won't look until its next
 *     `tandem_checkInbox`. This is the hand-launched session, and it is the
 *     COMMON case: the channel shim needs a flag most users never type, and the
 *     supervisor's stdin wake only reaches sessions Tandem itself spawned.
 *
 * Ordering rules (order is load-bearing):
 *   1. Solo outranks everything. The user deliberately opted out of AI
 *      surfacing, so all three notices contradict that intent — the same
 *      reasoning that makes `chip` null in Solo.
 *   2. Server-reachability outranks the AI questions, because both of those
 *      presuppose a server to be attached to. `sessionLive` is false when the
 *      server is gone, but only as a CONSEQUENCE — reading it as "no AI" and
 *      promising the message will be seen "when one connects" is a second false
 *      promise in place of the one this whole change removed.
 *   3. A live session decides which of the remaining branches applies. Without
 *      one, only the agent-absence notice can be correct; with one, only the
 *      delivery notice can be.
 *   4. `no-push` fires ONLY on a confirmed zero. `routes/health.ts:43-45` is
 *      explicit that `subscribers: 0` is a sound negative while any positive
 *      count includes an attached-but-inert shim — so `true` and `null` (field
 *      absent, redacted, or not yet read) must both stay silent. Guessing here
 *      would tell a working user their comment went nowhere.
 */
export type AddressedAiNotice =
  | { kind: "offline" }
  | { kind: "no-agent"; chip: Exclude<AiChip, null> }
  | { kind: "no-push" };

export function addressedAiNotice(input: {
  /** Must be re-read after any await — see the caller. */
  soloMode: boolean;
  /**
   * `/health` has gone quiet for a full strike run — the server itself is gone,
   * not merely un-attached. Keyed on the run rather than a single failed read
   * so a blip cannot raise an alarm about data loss.
   */
  serverUnreachable: boolean;
  /** Fresh `/health` confirmation that an MCP transport is open. */
  sessionLive: boolean;
  /** Re-read after the probe — readiness may have settled while it was in flight. */
  chip: AiChip;
  /** Only `"none"` is actionable; `"attached"` and `"unknown"` stay silent. */
  pushDelivery: PushDelivery;
}): AddressedAiNotice | null {
  // Rule 1. Belt-and-braces: the production caller short-circuits on Solo
  // before reaching here (to skip the probe), so this branch is defensive —
  // it exists so the decision is total for any future caller rather than
  // depending on every call site remembering.
  if (input.soloMode) return null;

  // Rule 2 — the server, before the AI. Deliberately ahead of the `sessionLive`
  // branch: with the server gone `sessionLive` is false too, so ordering these
  // the other way round would report the consequence and hide the cause.
  if (input.serverUnreachable) return { kind: "offline" };

  // Rule 3 — no agent attached.
  if (!input.sessionLive) {
    // `chip` is null while booting, and in the launcher's running-but-no-session
    // startup window. Neither is a state worth alarming about.
    return input.chip === null ? null : { kind: "no-agent", chip: input.chip };
  }

  // Rule 4 — attached, but is anything delivering?
  return input.pushDelivery === "none" ? { kind: "no-push" } : null;
}
