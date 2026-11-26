import type * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import { atMapKey } from "../../../shared/sanitize.js";
import type { AnnotationReply } from "../../../shared/types.js";
import { relaySanitizationEvent } from "../../annotations/migration-log.js";
import {
  describeRefusal,
  describeReplyRefusal,
  isNoteworthyRefusal,
  narrowForChannel,
  narrowReplyForChannel,
  replyPayload,
} from "../../annotations/projection.js";
import { threadHoldsFinalClaudeReply } from "../../annotations/thread-handled.js";
import { clientWritesUndoneGrant } from "../../chat-client-writes.js";
import { isLocalModelRecord, markWithheldForLocalPeriod } from "../../models/local-period.js";
import type { TandemEvent } from "../types.js";
import { generateEventId } from "../types.js";
import { makePerKeyChangeObserver } from "./factory.js";
import { wasRepairedByReplyUndo } from "./reply-client-undo.js";

export function makeRepliesObserver(deps: {
  docName: string;
  doc: Y.Doc;
  pushEvent: (e: TandemEvent) => void;
}): () => void {
  const { docName, doc, pushEvent } = deps;
  const annotationsMap = doc.getMap(Y_MAP_ANNOTATIONS);
  const repliesMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);

  /**
   * Whether a reply follows a final Claude reply in its thread (#2360 PR B;
   * Bryan's Q6): the payload's `threadAnswered`, which makes it start-worthy.
   * Only a user's reply is ever projected (`narrowReplyForChannel`'s author
   * check), so no author test here. Ownership on only (the fail-closed
   * grant), checked first so a dark build reads no row and its payload is
   * unchanged.
   */
  const followsClaudeAnswer = (parentKey: string): boolean =>
    clientWritesUndoneGrant() && threadHoldsFinalClaudeReply(repliesMap.values(), parentKey);

  return makePerKeyChangeObserver<AnnotationReply>({
    map: repliesMap,
    pushEvent,
    // #2360: a client write the reply undo repaired (it runs first, being
    // registered first) derives nothing, so a forged add pushes no event.
    shouldSkipTransaction: wasRepairedByReplyUndo,
    derive: ({ key, action, value: reply }) => {
      if (action !== "add") return undefined;

      // ADR-035: the parent goes through the same narrow the annotations
      // observer uses. This file previously read it with a bare
      // `as Annotation | undefined` and never sanitized it, so the parent's
      // type was trusted exactly as stored — a legacy or CRDT-merged record
      // could carry a raw type the rest of the system would have migrated. The
      // narrow now sanitizes first and then applies both privacy halves, which
      // also closes the case where an UNTRIAGED imported comment's replies
      // reached the channel: imports derive `audience: "private"` until the
      // user triages them, and nothing here used to look.
      // `onRefused` is supplied here too. Without it this observer could drop
      // a reply the user had just watched themselves write -- parent corrupt,
      // parent private, parent deleted -- with no signal anywhere, which is the
      // "sometimes it is instant and sometimes it is not" report that costs days.
      const parentKey = reply?.annotationId ?? "";
      const narrowed = narrowForChannel(annotationsMap.get(parentKey), {
        onLossy: (event) => relaySanitizationEvent(docName, event),
        onRefused: (refusal, refused) => {
          if (!isNoteworthyRefusal(refusal)) return;
          console.warn(
            `[EventQueue] refused to project reply on key=${key}: parent ${describeRefusal(refusal, refused?.id)}`,
          );
        },
      });
      if (!narrowed) return undefined;
      // The parent was fetched BY its map key, so that key is its identity
      // (`atMapKey`), stamped after the narrow on the eligible copy. A parent
      // stored with a stale `id` would otherwise fail the parent-mismatch check
      // in `projection.ts` and drop every reply on it, while the pull side
      // (which reads keys) showed them.
      const parent = atMapKey(parentKey, narrowed);

      // The parent being eligible says nothing about the reply.
      // `AnnotationReply.private` is stamped at creation from the parent's type
      // AT THAT INSTANT and is permanent, so a reply written while the parent
      // was a note stays private after a promotion. This file never read that
      // field — it was safe only because its parent-type check happened to
      // agree, which is one invariant encoded twice. Now it is read.
      const eligible = narrowReplyForChannel(reply, parent, (refusal) => {
        console.warn(
          `[EventQueue] refused to project reply: ${describeReplyRefusal(refusal, reply?.id)}`,
        );
      });
      if (!eligible) return undefined;

      const event: TandemEvent = {
        id: generateEventId(),
        type: "annotation:reply",
        timestamp: Date.now(),
        documentId: docName,
        payload: {
          ...replyPayload(eligible, parent, key),
          ...(followsClaudeAnswer(parentKey) ? { threadAnswered: true as const } : {}),
        },
      };
      // A reply on the local model's own annotation, or the local model's own
      // reply, is local-model activity (#1123 A2, R3.4): never pushed,
      // replayed, start-worthy or a round. A user reply on Claude's own
      // annotation never is, even where the local model also replied.
      if (isLocalModelRecord(parent) || isLocalModelRecord(reply)) {
        markWithheldForLocalPeriod(event);
      }
      return event;
    },
  });
}
