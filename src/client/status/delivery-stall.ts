import { DELIVERY_STALL_MS } from "../../shared/constants.js";

/**
 * Should the editor say "your message is still waiting"?
 *
 * This is Track D-5: a projection of current truth, not an event. The `no-push`
 * and `offline` notices fire once, at send, on what was known then. This answers
 * a different question — is the thing you sent *still* unanswered — and so it
 * has to be re-derived from live state and erase itself when the state changes.
 *
 * ## Why it keys on the join and not on `subscribers`
 *
 * `subscribers > 0` says something is attached; it never says that something
 * reaches a model. An inert channel shim accepts every event and discards it,
 * and the server cannot tell it apart from a live consumer. So a surface built
 * on the count would go quiet in exactly the configuration that motivated this
 * work. `state === "awaiting-poll"` is a statement about a specific event
 * nobody has picked up, which is sound in the only direction that matters: it
 * cannot claim delivery is fine.
 *
 * ## Why it is NOT gated on `sessionLive`
 *
 * The obvious gate is "only complain if an AI is attached". But `hasSession` is
 * scoped to handshake-era clients by construction — MCP `2026-07-28` removed the
 * handshake, so a client on that revision never sets it. Gating on it means that
 * once the expiry arrives the banner never renders again, silently, and the
 * feature is dead with no failing test to say so.
 *
 * ## The threshold, and why it is not seconds
 *
 * A model that is working polls: the shipped skill instructs `tandem_checkInbox`
 * every 2–3 tool calls, so an active turn clears an outstanding forward on its
 * own within moments. `waitingMs` climbing therefore means nothing is polling
 * AND nothing is waking — the actual symptom. The residual false positive is a
 * long generation that calls no tools at all, which is why the threshold is
 * minutes rather than seconds.
 *
 * ## What it deliberately cannot catch
 *
 * `"awaiting-poll"` is only reachable when NO session has polled, because the
 * outstanding forward is process-global. With two sessions attached, a second
 * one polling on its routine cadence clears the flag and this stays silent while
 * the first is genuinely wedged. That is a real gap and it is the honest side of
 * the trade: the alternative is a per-session claim, and neither session id is
 * available on the population this exists for.
 */
export interface DeliveryStallInput {
  /** The server's join state. Unknown/absent reads as no claim. */
  state: string | null;
  /** How long the outstanding forward has waited, in ms. */
  waitingMs: number | null;
  /** Solo outranks everything — the user opted out of AI surfacing. */
  soloMode: boolean;
  /** A dead server is its own, louder story; never stack the two. */
  serverUnreachable: boolean;
}

/**
 * @returns how long the oldest unanswered message has waited, in ms, or `null`
 *   for "no claim". A bare number rather than a wrapper object: `0` is
 *   unreachable (the threshold gate is strictly greater), so `null` carries the
 *   whole no-claim/claim distinction on its own.
 */
export function deliveryStall(input: DeliveryStallInput): number | null {
  if (input.soloMode) return null;
  // The offline notice already tells this story, and better: with the server
  // gone, "Claude hasn't picked this up" is true but blames the wrong party.
  if (input.serverUnreachable) return null;
  if (input.state !== "awaiting-poll") return null;
  if (input.waitingMs === null || input.waitingMs < DELIVERY_STALL_MS) return null;
  return input.waitingMs;
}
