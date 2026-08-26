import type * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import type { AnnotationReply } from "../../../shared/types.js";
import { relaySanitizationEvent } from "../../annotations/migration-log.js";
import {
  narrowForChannel,
  narrowReplyForChannel,
  replyPayload,
} from "../../annotations/projection.js";
import type { TandemEvent } from "../types.js";
import { generateEventId } from "../types.js";
import { makePerKeyChangeObserver } from "./factory.js";

export function makeRepliesObserver(deps: {
  docName: string;
  doc: Y.Doc;
  pushEvent: (e: TandemEvent) => void;
}): () => void {
  const { docName, doc, pushEvent } = deps;
  const annotationsMap = doc.getMap(Y_MAP_ANNOTATIONS);
  const repliesMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);

  return makePerKeyChangeObserver<AnnotationReply>({
    map: repliesMap,
    pushEvent,
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
      const parent = narrowForChannel(annotationsMap.get(reply?.annotationId ?? ""), {
        onLossy: (event) => relaySanitizationEvent(docName, event),
      });
      if (!parent) return undefined;

      // The parent being eligible says nothing about the reply.
      // `AnnotationReply.private` is stamped at creation from the parent's type
      // AT THAT INSTANT and is permanent, so a reply written while the parent
      // was a note stays private after a promotion. This file never read that
      // field — it was safe only because its parent-type check happened to
      // agree, which is one invariant encoded twice. Now it is read.
      const eligible = narrowReplyForChannel(reply, parent);
      if (!eligible) return undefined;

      return {
        id: generateEventId(),
        type: "annotation:reply",
        timestamp: Date.now(),
        documentId: docName,
        payload: replyPayload(eligible, parent, key),
      };
    },
  });
}
