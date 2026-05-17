import type * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import type { Annotation, AnnotationReply } from "../../../shared/types.js";
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
      if (action !== "add" || !reply || reply.author !== "user") return undefined;

      // Look up the parent annotation for the text snippet.
      const parentAnn = annotationsMap.get(reply.annotationId) as Annotation | undefined;
      // ADR-027: notes are user-private; highlights are user-only UI markup.
      // Only replies on comments surface to the channel (Claude). The early-
      // return makes this privacy invariant structurally explicit — a future
      // refactor that drops the type check breaks visibly here, not by
      // silently leaking note/highlight reply text + textSnapshot via SSE.
      if (!parentAnn || parentAnn.type !== "comment") return undefined;
      const textSnippet = parentAnn.textSnapshot ?? "";

      return {
        id: generateEventId(),
        type: "annotation:reply",
        timestamp: Date.now(),
        documentId: docName,
        payload: {
          annotationId: reply.annotationId,
          replyId: key,
          replyText: reply.text,
          replyAuthor: reply.author,
          textSnippet,
        },
      };
    },
  });
}
