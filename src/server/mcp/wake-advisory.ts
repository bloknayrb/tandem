/**
 * The wake advisory — a trailing note telling a session nothing can reach it.
 *
 * ## What it fires on, and why that is the only sound trigger
 *
 * `getSubscriberCount() === 0`. Nothing outside this process is attached, so no
 * wake path exists for ANY session — which makes the advice correct for every
 * session simultaneously, with no per-session claim involved. That matters
 * because no per-session claim is available: `claudeSessionId` is absent for the
 * direct-HTTP entry (the hand-launched population this exists for) and
 * `mcpSessionId` is absent for any client on MCP `2026-07-28`.
 *
 * A zero subscriber count is the one sound negative in the whole
 * connection-honesty surface. Every positive value is not its converse: an
 * attached channel shim whose host never negotiated `claude/channel` accepts
 * every event and discards it, and the server cannot tell that apart from a live
 * consumer.
 *
 * **Known gap, stated rather than hidden.** Because a positive count silences
 * this, a session that is genuinely uncovered while some OTHER consumer is
 * attached gets no advisory. Silence-because-we-think-you're-covered has the
 * same user-visible outcome as asserting delivery, so this is a real cost. It is
 * accepted because the alternative — firing whenever we cannot prove coverage —
 * fires forever on the default desktop install, where the supervisor is attached
 * and the launched session is genuinely being woken.
 *
 * ## Why it is rate-limited the way it is
 *
 * At most once per "nothing attached" period. A draft that fired on every call
 * would have produced 30–120 advisories per session: the shipped skill instructs
 * `tandem_checkInbox` every 2–3 tool calls, and `/loop 30s` is a documented
 * workflow. Beyond the annoyance, a model reading "arm one if you haven't" on
 * the 40th call — 90k tokens after arming — will arm a second one. And it
 * teaches that Tandem's trailing text is skimmable noise, which is paid for by
 * `RANGE_MOVED` and every other load-bearing message sharing that channel.
 *
 * A consumer attaching re-arms it, so the advice returns if the wake path is
 * later lost. That is a real transition, not a timer.
 *
 * ## What it must never contain
 *
 * The arm command itself. Emitting an executable shell command into the same
 * `content` array as document text teaches Claude that Tandem tool output
 * legitimately carries commands to run — which a malicious `.docx` or an
 * imported Word comment can then imitate. The command lives in `SKILL.md`, one
 * place, and this points at it.
 *
 * No counts and no content either. A pending count would need a read-only,
 * ledger-non-mutating, `hideFromAI`-exact replica of the `checkInbox` filter
 * chain; approximating it leaks in Solo.
 */

import { readModeState } from "../mode.js";

/**
 * Has the advisory already fired during the current "nothing attached" period?
 * Reset when a consumer is observed, so the next loss of the wake path speaks
 * again.
 */
let advisedWhileEmpty = false;

export const WAKE_ADVISORY_TEXT =
  "[Tandem] Nothing is currently subscribed to Tandem's event stream, so no " +
  "user activity can reach you on its own — you will only see it when you call " +
  "tandem_checkInbox. If you want to be woken while idle, the `tandem` skill " +
  "describes how to arm a watch.";

/**
 * Decide whether to append the advisory, and record that we did.
 *
 * Impure by design: the rate limit is the feature, so the decision and the
 * bookkeeping cannot be separated without letting a caller ask twice and get
 * two advisories.
 */
export function takeWakeAdvisory(externalConsumerCount: number): string | null {
  // Solo gates before any string is built. During Solo the user has opted out
  // of AI surfacing entirely, and nagging a session into arming a watch is the
  // opposite of the mode's promise. `indeterminate` fails CLOSED — silent —
  // matching every other push-path gate.
  if (readModeState() !== "tandem") return null;

  if (externalConsumerCount > 0) {
    advisedWhileEmpty = false;
    return null;
  }
  if (advisedWhileEmpty) return null;
  advisedWhileEmpty = true;
  return WAKE_ADVISORY_TEXT;
}

/** Testing-only. */
export function resetWakeAdvisoryForTests(): void {
  advisedWhileEmpty = false;
}
