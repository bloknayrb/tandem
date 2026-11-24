import { BYO_MODELS_ENABLED, DELIVERY_STALL_MS } from "../../shared/constants";
import { DEFAULT_RUN_DEADLINE_MS, effectiveLocalRun } from "../../shared/local-run";
import { type ChatMessage, isChatNoticeRow } from "../../shared/types";

/**
 * What has happened to the user's latest chat message, derived from the chat map
 * and — for a message a local model handles (#1123 part B, R5) — the editor's
 * read of who answers chat (`hooks/useChatAnswerer.svelte.ts`), passed in as
 * {@link LocalPickupInputs}. Without those inputs (or while
 * `BYO_MODELS_ENABLED` is off) it is derived from the chat map alone, exactly
 * as before part B.
 *
 * Every Claude-side state is something the server or Claude actually recorded: `received`
 * is `read` (a cursor-less `tandem_checkInbox`'s stamp, a cursor poll's
 * acknowledgement, or a `tandem_reply` that named the message) OR `delivered`
 * (a cursor poll handed it out). `read` alone is not enough: under the cursor
 * (#2064) it waits for Claude's NEXT poll, so a Claude working on the message
 * for minutes without polling would read "still waiting" and raise the Claude
 * Code offer. `working` is an ack Claude sent with `inProgress: true`.
 *
 * Nothing here reads `claudeActive` or `claudeWorking`: the first is set by
 * `tandem_status` and stays true for up to five minutes after Claude's last
 * presence-wrapped tool call, and the second is set only around a few wrapped
 * tool calls (30 s cap), so neither says "Claude is working on this message",
 * and a row built on them was the stale "thinking…" this replaces.
 */
export type ChatPickup =
  | { kind: "waiting"; waitedMs: number }
  | { kind: "received" }
  | { kind: "working" }
  /** #1123 part B (R5.1): Tandem restarted mid-run (effective `interrupted`). */
  | { kind: "local-interrupted" }
  /** The local model's run is going (Decision B2). */
  | { kind: "local-working" }
  /** A run that stopped, with no reply row and no notice row for the message. */
  | { kind: "local-stopped" }
  /** Sent by this window to its local model; no run recorded yet (Ruling B-a). */
  | { kind: "local-sent" };

/**
 * What the pickup row needs beyond the chat map for a message a local model
 * handles (#1123 part B, R5.5). All from the chat-answerer store; App passes
 * null while the flag is off.
 */
export interface LocalPickupInputs {
  /** The server process's run id from the store's read, or null (not known). */
  runGeneration: string | null;
  /** Messages this window sent while its read was known local and the
   *  licence admitted AI (Ruling B-6). */
  sentLocal: ReadonlySet<string>;
  /** The read is known, and says the local model. */
  readKnownLocal: boolean;
  /** The licence refuses the AI. */
  aiOff: boolean;
}

/** Past this, a `running` state that cannot be judged (the run id is not
 *  known) is no longer shown: the run deadline plus a minute (R5.1). */
export const LOCAL_RUN_UNJUDGED_MAX_MS = DEFAULT_RUN_DEADLINE_MS + 60_000;

/** Past this the row says nothing. Long enough to outlast a cold auto-launch;
 * short enough that a message Claude rightly never answered ("thanks!"), a session
 * that died after its ack, or an unread message restored after a restart does not
 * keep claiming a state. A real stall past 2 min is `WakeStallBanner`'s story. */
export const PICKUP_MAX_AGE_MS = 10 * 60_000;

/**
 * Each unanswered message's pickup and stall clock, by message id: the
 * `since` a flag-on server publishes under `Y_MAP_OWNERSHIP_CHAT` (#2358 PR
 * 5d, ownership design §6.5), the message's last change of owner, or its
 * arrival if it never had one. Empty while ownership is off.
 */
export type PickupClock = ReadonlyMap<string, { readonly since: number }>;

const NO_CLOCK: PickupClock = new Map();

export function chatPickup(
  messages: readonly ChatMessage[],
  now: number,
  local: LocalPickupInputs | null = null,
  clock: PickupClock = NO_CLOCK,
): ChatPickup | null {
  // Only the latest user message is a candidate, so answering it can never
  // resurrect an older one as pending.
  let latest: ChatMessage | null = null;
  for (const m of messages) {
    if (m.author === "user" && (latest === null || m.timestamp >= latest.timestamp)) latest = m;
  }
  if (latest === null) return null;
  // #2358 PR 5e (ownership design §6.5; Bryan, 2026-11-24, "Both
  // (Recommended)"): where the server publishes the message's clock, the row
  // counts from it, for its waiting time and for this cut-off alike, so a
  // handover does not show an old message as instantly stalled. Otherwise
  // (ownership off, or a message it publishes nothing for) from the message's
  // own timestamp, as before.
  const since = clock.get(latest.id)?.since ?? latest.timestamp;
  if (now - since > PICKUP_MAX_AGE_MS) return null;

  const lit = BYO_MODELS_ENABLED && local !== null;
  if (lit) {
    const verdict = localPickup(messages, latest, now, local);
    if (verdict !== "today") return verdict;
  }

  // A `superseded` acknowledgement (#2358, the posts PR, R3.7: the server marks
  // one when its message changed owner) is left out of both the replies and
  // what ends "working", so a re-owed message reads "waiting" again. Only the
  // server writes it, and only with ownership on; the client reads no flag.
  // Notice rows (#1123 part B) are the server's, not an answer: under the
  // flag they never count as a reply or as an untagged Claude row, so the
  // switch-back line (which names no message) never ends the row of a
  // message owed to Claude.
  const after = messages.filter(
    (m) =>
      m.author === "claude" &&
      m.timestamp >= latest.timestamp &&
      m.superseded !== true &&
      !(lit && isChatNoticeRow(m)),
  );
  const replies = after.filter((m) => m.replyTo === latest.id);

  if (replies.length > 0) {
    const acks = replies.filter((m) => m.inProgress === true);
    const lastAck = acks[acks.length - 1];
    if (lastAck === undefined) return null;
    // Any Claude message from the ack onward that is not itself an ack ends
    // "working", whatever its `replyTo`: a result sent untagged must not leave the
    // dots running beside it. `>=`, so a result stamped in the ack's millisecond counts.
    const ended = after.some((m) => m.inProgress !== true && m.timestamp >= lastAck.timestamp);
    return ended ? null : { kind: "working" };
  }

  // An untagged Claude message after it makes no claim either way: it may be the
  // answer from a session on an older skill, or an unrelated note. Saying "waiting"
  // beside a visible answer would be worse than saying nothing. A `replyTo` naming
  // no user message (a wrong id) is untagged too; one naming an EARLIER user
  // message is not, so an answer to A never clears B.
  const userIds = new Set(messages.filter((m) => m.author === "user").map((m) => m.id));
  if (after.some((m) => m.replyTo === undefined || !userIds.has(m.replyTo))) return null;

  return latest.read || latest.delivered === true
    ? { kind: "received" }
    : { kind: "waiting", waitedMs: now - since };
}

/**
 * R5.1's table, top to bottom, for the latest user message: a local verdict,
 * or `"today"` for today's rows. The rows keyed on `localRun` apply whatever
 * window sent the message (it is the server's record that the local model
 * handled it).
 */
function localPickup(
  messages: readonly ChatMessage[],
  latest: ChatMessage,
  now: number,
  local: LocalPickupInputs,
): ChatPickup | null | "today" {
  const run = effectiveLocalRun(latest.localRun, local.runGeneration);
  const noticeFor = messages.some((m) => isChatNoticeRow(m) && m.replyTo === latest.id);
  if (run !== undefined) {
    // Shown beside a row a restart may have folded (part C, R4).
    if (run.reason === "interrupted") return { kind: "local-interrupted" };
    if (run.status === "running") {
      // Not judgeable (the run id is not known) and past the deadline: the
      // row can no longer say it is running.
      if (local.runGeneration === null && now - latest.timestamp > LOCAL_RUN_UNJUDGED_MAX_MS) {
        return null;
      }
      return { kind: "local-working" };
    }
    if (run.status === "replied") return null;
    // Stopped: a reply row for the message (the local model's partial one,
    // or a Claude's `tandem_reply` naming it after a switch back) or a notice
    // speaks if present. A superseded acknowledgement (#2358) answers nothing.
    const replyFor = messages.some(
      (m) =>
        m.author === "claude" &&
        !isChatNoticeRow(m) &&
        m.superseded !== true &&
        (m.id === run.replyId || m.replyTo === latest.id),
    );
    if (replyFor || noticeFor) return null;
    return { kind: "local-stopped" };
  }
  // No `localRun`: A1's no-document and no-local-model notices write none.
  if (noticeFor) return null;
  // The local model never stamps a user row: either stamp means a Claude has it.
  if (latest.read || latest.delivered === true) return "today";
  if (local.sentLocal.has(latest.id) && local.readKnownLocal && !local.aiOff) {
    return { kind: "local-sent" };
  }
  return "today";
}

/** One line per state; the visible row and the screen-reader announcement both
 * read it, so the two cannot drift. Only "waiting" adds anything (its elapsed time). */
const PICKUP_TEXT = {
  waiting: "Sent · waiting for your AI to pick it up",
  received: "Your AI has your message",
  working: "Your AI is working on it",
  "local-interrupted": "Tandem restarted while your local model was working on this.",
  "local-working": "Your local model is working on this…",
  "local-stopped": "Your local model stopped without answering.",
  "local-sent": "Sent to your local model",
} as const satisfies Record<ChatPickup["kind"], string>;

/** Is this one of the local model's rows (#1123 part B)? */
export function isLocalPickup(pickup: ChatPickup | null): boolean {
  return pickup !== null && pickup.kind.startsWith("local-");
}

/** The latest message has waited past the delivery-stall threshold: the row
 * reads "still waiting", and the Claude Code offer may show beside it. */
export function isPickupStalled(pickup: ChatPickup | null): boolean {
  return pickup?.kind === "waiting" && pickup.waitedMs >= DELIVERY_STALL_MS;
}

/** The visible line for a pickup state. */
export function chatPickupLabel(pickup: ChatPickup): string {
  if (pickup.kind !== "waiting") return PICKUP_TEXT[pickup.kind];
  if (isPickupStalled(pickup)) return "Sent · still waiting for your AI";
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
