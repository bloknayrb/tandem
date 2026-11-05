import type { AnnotationReply } from "../../shared/types";

/**
 * A Claude answer inside a user's comment thread (#2360): what the attention
 * machinery announces and what the card marker tracks. Everything here but
 * `text` is routing data — ids and a time, never document content. `text` is
 * the answer itself, read only by the notification wording under the user's
 * notification-content setting.
 */
export interface ThreadAnswer {
  /** The tab that observed the reply — never a field read off the reply. */
  documentId: string;
  annotationId: string;
  /** Globally unique; also the `Y_MAP_REPLY_SEEN` key. */
  replyId: string;
  text: string;
  timestamp: number;
}

/** The parent fields the predicate reads (a `sanitizeAnnotation`d record). */
export interface ThreadAnswerParent {
  author: string;
  type: string;
  audience?: string;
}

/**
 * What `yjsSync` captured inside a document provider's first `synced`
 * callback: the reply ids present then, and when.
 */
export interface ReplyBaseline {
  ids: readonly string[];
  capturedAt: number;
}

/**
 * Is `reply` Claude answering the user's own comment? Claude's replies on its
 * own cards are part of a conversation it started, which the card already
 * surfaces; notes are never Claude's (ADR-027) and highlights show no replies.
 * A `private` reply is the user's by construction (#1000), whatever its author
 * field says.
 *
 * The parent must also be Claude-facing — `audience === "outbound"`, the same
 * test as the server's `isClaudeFacing` (`annotations/projection.ts`), where an
 * absent field is not consent. Claude cannot legitimately write into a private
 * thread, so this is defence in depth: a forged or pre-guard reply there is
 * never previewed on a lock screen or opened on the card.
 */
export function isThreadAnswer(
  reply: Pick<AnnotationReply, "author" | "private">,
  parent: ThreadAnswerParent | undefined,
): boolean {
  return (
    reply.author === "claude" &&
    reply.private !== true &&
    parent?.author === "user" &&
    parent.type === "comment" &&
    parent.audience === "outbound"
  );
}

/**
 * Picks out the thread answers that arrived *live*: the ones a notification,
 * flash or chime may announce. Pure, like `reply-detector.ts`, whose rules it
 * mirrors for one document's `Y_MAP_ANNOTATION_REPLIES`:
 *
 * - **Nothing before the provider has synced** (`baseline === null`): the
 *   observer sees the whole history before `synced`.
 * - **The baseline ids are what `yjsSync` captured inside that document's
 *   provider `synced` callback**, not "whatever is present the first time we
 *   look", so an answer landing between `synced` and the first effect run is
 *   still announced.
 * - **History by time, on every pass.** A reply stamped before the baseline
 *   was captured is history even when it is not in the baseline. The server
 *   can broadcast a document as open before it has merged that document's
 *   stored replies (`openDocumentWhenReady` publishes `openDocs` before
 *   `prepare()` finishes), so the provider can sync, capture a baseline
 *   without them, and then receive them as a delta. Server and client share
 *   one clock on loopback. A genuinely live answer is always newer.
 * - **Known ids are keyed on Y.Doc identity.** A server restart rebuilds the
 *   tab on a new doc that syncs the full history again, so it re-seeds from
 *   that doc's baseline. The same doc never re-seeds: a reconnect delta, or a
 *   reload that deletes and re-inserts the same reply id, is announced at most
 *   once.
 * - **Only a thread answer becomes known** (announced, or skipped as history
 *   by time). Anything else is judged again
 *   on the next pass, so a reply that lands before its parent annotation is
 *   announced once the parent arrives instead of being dropped.
 */
export interface ThreadAnswerDetector {
  observe(input: {
    doc: object;
    documentId: string;
    baseline: ReplyBaseline | null;
    replies: readonly AnnotationReply[];
    parents: ReadonlyMap<string, ThreadAnswerParent>;
  }): ThreadAnswer[];
}

export function createThreadAnswerDetector(): ThreadAnswerDetector {
  const knownByDoc = new WeakMap<object, Set<string>>();

  return {
    observe({ doc, documentId, baseline, replies, parents }) {
      if (baseline === null) return [];
      let known = knownByDoc.get(doc);
      if (known === undefined) {
        known = new Set(baseline.ids);
        knownByDoc.set(doc, known);
      }
      const fresh: ThreadAnswer[] = [];
      for (const reply of replies) {
        if (known.has(reply.id)) continue;
        if (!isThreadAnswer(reply, parents.get(reply.annotationId))) continue;
        known.add(reply.id);
        if (reply.timestamp < baseline.capturedAt) continue;
        fresh.push({
          documentId,
          annotationId: reply.annotationId,
          replyId: reply.id,
          text: reply.text,
          timestamp: reply.timestamp,
        });
      }
      return fresh;
    },
  };
}
