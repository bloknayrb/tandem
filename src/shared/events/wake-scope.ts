import type { TandemEvent } from "./types.js";

/**
 * Which events are worth interrupting Claude for.
 *
 * Narrower than the channel shim's set, which forwards everything that clears
 * the queue's gates. A channel notification is cheap to ignore; a turn written
 * on stdin compels a response, so `document:*` lifecycle — fired whenever the
 * user clicks a tab — would turn ordinary navigation into a stream of forced
 * wakes. Annotations and chat are the events where the user is actually asking
 * for something, and Claude re-reads document state from `tandem_checkInbox`
 * when it does wake.
 *
 * The Solo→Tandem release wake is a synthetic `annotation:created`
 * (`emitModeReleaseWake`), so it clears this filter by construction.
 *
 * Lives here rather than in `supervisor.ts`, where it started, because four
 * unrelated things now have to agree on the answer: the supervisor's stdin
 * wake, the SSE `?filter=wake` narrowing, the `/api/wake` WebSocket endpoint,
 * and the plugin monitor's stdout line. Two of those are user-visible honesty
 * signals, so a drifted second copy would not fail loudly — it would quietly
 * report the wrong story.
 *
 * It sits in `src/shared/` rather than `src/server/` for the fourth: the
 * monitor and channel bundles must not cross the server layer boundary, which
 * is the same reason `src/shared/events/types.ts` exists. The monitor is the
 * one caller that applies the predicate to its OUTPUT while still consuming the
 * full stream — it needs `documentId` off every event, `document:*` included,
 * to attribute the awareness indicator.
 *
 * **The delivery-state join is NOT one of them**, and it is worth saying so
 * where a maintainer will read it: the join runs on `isUnansweredAsk`, which is
 * narrower at both ends (it drops the accept/dismiss status flips, which are
 * the user acknowledging Claude's work rather than asking for anything). The
 * two predicates are deliberately separate — see `isUnansweredAsk`'s docblock —
 * so widening this one does NOT retune `waitingMs`, and believing it does is
 * the specific mistake this paragraph exists to prevent.
 */
export function isWakeWorthy(event: TandemEvent): boolean {
  return event.type.startsWith("annotation:") || event.type === "chat:message";
}

/**
 * Which events START a Tandem's Claude that is not running by choice — Off,
 * idle-stopped, or on-click not yet clicked (#2196). Narrower than
 * `isWakeWorthy`, which only decides what to tell a Claude that is already
 * running: starting a process is work, and Bryan's line for it is the user
 * talking TO Claude — a chat message, or the user's reply on a thread Claude
 * started. A new comment, a reply on the user's own highlight or an imported
 * Word comment, and accept/dismiss are not, so they wait for the next start
 * (they are still owed to it as wakes; see the supervisor's gap watch).
 *
 * The caller applies the Solo gate and the licence verdict BEFORE this
 * (`wasForwardedExternally`), so this answers only "is it addressed to Claude",
 * never "may Claude see it".
 */
export function isStartWorthy(event: TandemEvent): boolean {
  if (event.type === "chat:message") return true;
  return (
    event.type === "annotation:reply" &&
    event.payload.replyAuthor === "user" &&
    event.payload.parentAuthor === "claude"
  );
}

/**
 * The type of the one wake frame that is not an event (#2358 PR 3b-2d; ADR-054;
 * ownership design §4.4, §8.6, §8.7): written on `/api/wake` when a change of
 * owner leaves work waiting for a session other than Tandem's Claude, or for
 * nobody. It names no document, record or item: the reader polls
 * `tandem_checkInbox` and finds out there, as for every other frame. A
 * consumer that reads only `type`'s presence (a `Monitor` watch, which hands
 * each line to the model, whose skill says "a wake tells you that, never
 * what") wakes on it as on any frame; nothing in Tandem switches on a wake
 * frame's `type`, and the plugin monitor reads `/api/events`, never this
 * socket. Never an SSE event name: the push-stream nudge is
 * {@link OWNERSHIP_CHANGED_SSE_EVENT}.
 */
export const OWNERSHIP_WAKE_FRAME_TYPE = "ownership";

/**
 * The SSE event name of the push-stream nudge (#2358 PR 4a; ADR-054;
 * ownership design §8.6, §9.1): written on every `/api/events` stream, mapped
 * or not, whenever the `ownership` frame is written on `/api/wake`. Outside
 * the `TandemEvent` union, and written as exactly
 * {@link OWNERSHIP_CHANGED_SSE_FRAME}: an `event:` line, **no `id:` line**
 * (an id missing from the replay buffer would make `replaySince` replay the
 * whole buffer) and an empty `data: {}`. A current consumer
 * (`src/shared/sse-consumer.ts`) recognises the name and wakes its host with
 * no payload; an older one ignores `event:` lines, parses `{}` as an event,
 * fails validation and logs one line, advancing nothing.
 */
export const OWNERSHIP_CHANGED_SSE_EVENT = "ownership-changed";

/** The whole `ownership-changed` frame, byte for byte. */
export const OWNERSHIP_CHANGED_SSE_FRAME = `event: ${OWNERSHIP_CHANGED_SSE_EVENT}\ndata: {}\n\n`;

/** A wake notification: enough to know something happened, never what. */
export interface WakeFrame {
  id: string;
  type: TandemEvent["type"] | typeof OWNERSHIP_WAKE_FRAME_TYPE;
  timestamp: number;
}

/**
 * Strip an event down to a wake. ADR-049 decision 2.
 *
 * Built by NAMING the three fields that survive rather than deleting `payload`
 * from a copy. A denylist would silently start forwarding whatever field the
 * next event type adds; this cannot, because a new field is not on the list.
 *
 * Why strip at all — three reasons, ascending:
 *
 *  1. A frame with no content cannot leak content, so a future regression in
 *     `shouldForwardExternally` would cost timing rather than the user's words.
 *  2. A model that answers from the payload never calls `tandem_checkInbox`, so
 *     the item is never marked surfaced and is re-reported on the next wake —
 *     the duplicate-reply hazard, mechanically. This is load-bearing for the
 *     OTHER half of ADR-049: dropping session-bound arbitration is only safe
 *     because the inbox ledger arbitrates, and the ledger only arbitrates if
 *     somebody actually polls.
 *  3. Wakes are LOSSY, and this was measured, not assumed. A 25-event burst
 *     reached the SSE socket in full while at least 7 never became
 *     notifications ("output rate too high"). A model answering from a payload
 *     answers from a view it has no way to discover is incomplete. The pull
 *     path saw all 25.
 *
 * `documentId` is deliberately absent even though every payload carries one:
 * `docIdFromPath` builds it as `<basename-slug>-<hash>`, so it is a filename in
 * all but name. `events/push-liveness.ts` refuses to retain one for exactly this
 * reason, and the wake path must not reintroduce what that module dropped.
 */
export function toWakeFrame(event: TandemEvent): WakeFrame {
  return { id: event.id, type: event.type, timestamp: event.timestamp };
}
