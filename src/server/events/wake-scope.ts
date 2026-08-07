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
 * Lives here rather than in `supervisor.ts`, where it started, because three
 * unrelated things now have to agree on the answer: the supervisor's stdin
 * wake, the delivery-state join (a `document:switched` from a tab click is not
 * a message going unanswered), and the SSE `?filter=wake` narrowing. Two of
 * those are user-visible honesty signals, so a drifted second copy would not
 * fail loudly — it would quietly report the wrong story.
 */
export function isWakeWorthy(event: TandemEvent): boolean {
  return event.type.startsWith("annotation:") || event.type === "chat:message";
}

/** A wake notification: enough to know something happened, never what. */
export interface WakeFrame {
  id: string;
  type: TandemEvent["type"];
  timestamp: number;
}

/**
 * Strip an event down to a wake. ADR-047 decision 2.
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
 *     OTHER half of ADR-047: dropping session-bound arbitration is only safe
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
