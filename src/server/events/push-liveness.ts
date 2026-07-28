/**
 * Push-consumer liveness — diagnostics only.
 *
 * A channel shim or plugin monitor POSTs `/api/channel-awareness` on every SSE
 * event it receives (`sse-consumer.ts`). That tells us one thing, precisely:
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
  /** Document the last heartbeat referenced, when it carried one. */
  lastDocumentId: string | null;
  /** Total heartbeats this run — distinguishes "never attached" from "quiet". */
  eventCount: number;
}

let lastEventAt: number | null = null;
let lastDocumentId: string | null = null;
let eventCount = 0;

export function recordPushConsumerEvent(input: {
  status: string;
  active: boolean;
  documentId: string | null;
}): void {
  lastEventAt = Date.now();
  eventCount += 1;
  // Only advance on a real id — a doc-less heartbeat (e.g. a chat event, or the
  // shutdown clear) must not wipe the last-known document.
  if (input.documentId) lastDocumentId = input.documentId;
}

export function getPushConsumerLiveness(): PushConsumerLiveness {
  return { lastEventAt, lastDocumentId, eventCount };
}

/** Testing-only. */
export function resetPushConsumerLivenessForTests(): void {
  lastEventAt = null;
  lastDocumentId = null;
  eventCount = 0;
}
