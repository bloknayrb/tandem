import * as Y from "yjs";
import {
  type ReconciledDoc,
  reconcileAnnotationKeys,
} from "../../src/server/annotations/key-identity.js";
import { Y_MAP_ANNOTATION_REPLIES } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import type { AnnotationReply } from "../../src/shared/types.js";

/**
 * A reconciled document holding exactly `replies`, keyed by reply id, for
 * driving `channelVisibleReplies` / `collectInboxUserReplies` directly. The
 * reply gate loads replies from the token's own document, filtered by the
 * parent's id, so each reply must name its parent in `annotationId`.
 */
export function reconciledReplies(replies: readonly AnnotationReply[]): ReconciledDoc {
  const doc = new Y.Doc();
  const map = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
  withInternal(doc, () => {
    for (const reply of replies) map.set(reply.id, reply);
  });
  return reconcileAnnotationKeys(doc);
}
