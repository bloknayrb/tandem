/**
 * Push-consumer liveness — diagnostics only.
 *
 * A channel shim or plugin monitor POSTs `/api/channel-awareness` as it receives
 * SSE events (`sse-consumer.ts` — debounced, so a burst collapses to one post, and
 * skipped entirely for annotation traffic that Solo mode suppresses, since that
 * filter sits above the post). That tells us one thing, precisely:
 * the server→consumer leg of the push path is working. It is the only positive
 * evidence of that leg we have.
 *
 * It is NOT evidence that a model received anything. A channel shim whose host
 * never negotiated the `claude/channel` capability still connects, still
 * receives SSE, and still posts here — while discarding every notification it
 * emits. The server cannot distinguish that from a live one, because the
 * decision is made client-side and nothing comes back.
 *
 * So: surface this in `/health` and `tandem doctor` to answer "is anything
 * attached, and is it receiving?", and never render it as Claude's presence or
 * gate behaviour on it. Claude's presence is written by Claude's own tool
 * dispatches — `tandem_status` and the typing-presence `working` marker.
 */

export interface PushConsumerLiveness {
  /** Epoch ms of the most recent consumer heartbeat, or null if none this run. */
  lastEventAt: number | null;
  /** Total heartbeats this run — distinguishes "never attached" from "quiet". */
  eventCount: number;
}

let lastEventAt: number | null = null;
let eventCount = 0;

/**
 * The caller's `documentId` is deliberately NOT retained.
 *
 * A document id is not opaque — `docIdFromPath` builds it as
 * `<basename-slug>-<hash>`, so `Q4-layoffs-plan.md` becomes `q4-layoffs-plan-1a2b3c`.
 * Retaining it would put a filename in every `/health` response for the life of the
 * process, sourced from an unvalidated request body on a loopback-auth-exempt route,
 * to answer a question ("is anything attached, and is it receiving?") that the two
 * counters below already answer. Nothing ever read it.
 */
export function recordPushConsumerEvent(_input: {
  status: string;
  active: boolean;
  documentId: string | null;
}): void {
  lastEventAt = Date.now();
  eventCount += 1;
}

export function getPushConsumerLiveness(): PushConsumerLiveness {
  return { lastEventAt, eventCount };
}

/** Testing-only. */
export function resetPushConsumerLivenessForTests(): void {
  lastEventAt = null;
  eventCount = 0;
}
