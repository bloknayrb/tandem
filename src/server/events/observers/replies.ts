import * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import type { Annotation, AnnotationReply } from "../../../shared/types.js";
import { FILE_SYNC_ORIGIN, MCP_ORIGIN } from "../origins.js";
import type { TandemEvent } from "../types.js";
import { generateEventId } from "../types.js";

export function makeRepliesObserver(deps: {
  docName: string;
  doc: Y.Doc;
  pushEvent: (e: TandemEvent) => void;
}): () => void {
  const { docName, doc, pushEvent } = deps;
  const annotationsMap = doc.getMap(Y_MAP_ANNOTATIONS);
  const repliesMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);

  const repliesObs = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (txn.origin === MCP_ORIGIN || txn.origin === FILE_SYNC_ORIGIN) return;

    for (const [key, change] of event.changes.keys) {
      if (change.action !== "add") continue;
      const reply = repliesMap.get(key) as AnnotationReply | undefined;
      if (!reply || reply.author !== "user") continue;

      // Look up the parent annotation for the text snippet
      const parentAnn = annotationsMap.get(reply.annotationId) as Annotation | undefined;
      const textSnippet = parentAnn?.textSnapshot ?? "";

      pushEvent({
        id: generateEventId(),
        type: "annotation:reply",
        timestamp: Date.now(),
        documentId: docName,
        payload: {
          annotationId: reply.annotationId,
          replyId: reply.id,
          replyText: reply.text,
          replyAuthor: reply.author,
          textSnippet,
        },
      });
    }
  };

  repliesMap.observe(repliesObs);
  return () => repliesMap.unobserve(repliesObs);
}
