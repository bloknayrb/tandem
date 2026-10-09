import { DELIVERY_STALL_MS } from "../../shared/constants";
import type { ChatMessage } from "../../shared/types";

/**
 * What has happened to the user's latest chat message, derived from the chat map
 * alone.
 *
 * Every state is something the server or Claude actually recorded: `read` is
 * `tandem_checkInbox`'s stamp (or a `tandem_reply` that named the message), and
 * `working` is an ack Claude sent with `inProgress: true`. Nothing here reads
 * `claudeActive` or `claudeWorking`: the first stays true for five minutes after
 * Claude last set a status and the second lasts one tool call, so neither says
 * "Claude is working on this message", and a row built on them was the stale
 * "thinking…" this replaces.
 */
export type ChatPickup =
  | { kind: "waiting"; waitedMs: number }
  | { kind: "received" }
  | { kind: "working" };

/** Past this the row says nothing. Long enough to outlast a cold auto-launch;
 * short enough that a message Claude rightly never answered ("thanks!"), a session
 * that died after its ack, or an unread message restored after a restart does not
 * keep claiming a state. A real stall past 2 min is `WakeStallBanner`'s story. */
export const PICKUP_MAX_AGE_MS = 10 * 60_000;

export function chatPickup(messages: readonly ChatMessage[], now: number): ChatPickup | null {
  // Only the latest user message is a candidate, so answering it can never
  // resurrect an older one as pending.
  let latest: ChatMessage | null = null;
  for (const m of messages) {
    if (m.author === "user" && (latest === null || m.timestamp >= latest.timestamp)) latest = m;
  }
  if (latest === null) return null;
  if (now - latest.timestamp > PICKUP_MAX_AGE_MS) return null;

  const after = messages.filter((m) => m.author === "claude" && m.timestamp >= latest.timestamp);
  const replies = after.filter((m) => m.replyTo === latest.id);

  if (replies.length > 0) {
    const acks = replies.filter((m) => m.inProgress === true);
    const lastAck = acks[acks.length - 1];
    if (lastAck === undefined) return null;
    // Any later Claude message that is not itself an ack ends "working", whatever
    // its `replyTo`: a result sent untagged must not leave the dots running beside it.
    const ended = after.some((m) => m.inProgress !== true && m.timestamp > lastAck.timestamp);
    return ended ? null : { kind: "working" };
  }

  // An untagged Claude message after it makes no claim either way: it may be the
  // answer from a session on an older skill, or an unrelated note. Saying "waiting"
  // beside a visible answer would be worse than saying nothing.
  if (after.some((m) => m.replyTo === undefined)) return null;

  return latest.read ? { kind: "received" } : { kind: "waiting", waitedMs: now - latest.timestamp };
}

/** One line per state; the visible row and the screen-reader announcement both
 * read it, so the two cannot drift. Only "waiting" adds anything (its elapsed time). */
const PICKUP_TEXT = {
  waiting: "Sent · waiting for your AI to pick it up",
  received: "Your AI has your message",
  working: "Your AI is working on it",
} as const satisfies Record<ChatPickup["kind"], string>;

/** The visible line for a pickup state. */
export function chatPickupLabel(pickup: ChatPickup): string {
  if (pickup.kind !== "waiting") return PICKUP_TEXT[pickup.kind];
  if (pickup.waitedMs >= DELIVERY_STALL_MS) return "Sent · still waiting for your AI";
  if (pickup.waitedMs < 10_000) return PICKUP_TEXT.waiting;
  return `${PICKUP_TEXT.waiting} · ${formatWait(pickup.waitedMs)}`;
}

/** What a screen reader hears: the state, never the ticking seconds. */
export function chatPickupAnnouncement(kind: ChatPickup["kind"] | null): string {
  return kind === null ? "" : PICKUP_TEXT[kind];
}

/** Spelled out ("12 s", "1 min") rather than `activityCenter`'s compact `12s`/`1m`:
 * this sits inside a sentence, not in a timestamp column. */
function formatWait(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
}
