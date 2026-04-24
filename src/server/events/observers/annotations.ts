import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import { sanitizeAnnotation } from "../../../shared/sanitize.js";
import type { Annotation } from "../../../shared/types.js";
import { FILE_SYNC_ORIGIN, MCP_ORIGIN } from "../origins.js";
import type { TandemEvent } from "../types.js";
import { generateEventId } from "../types.js";

export function makeAnnotationsObserver(deps: {
  docName: string;
  doc: Y.Doc;
  pushEvent: (e: TandemEvent) => void;
}): () => void {
  const { docName, doc, pushEvent } = deps;
  const annotationsMap = doc.getMap(Y_MAP_ANNOTATIONS);

  const annotationsObs = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (txn.origin === MCP_ORIGIN || txn.origin === FILE_SYNC_ORIGIN) return;

    for (const [key, change] of event.changes.keys) {
      const raw = annotationsMap.get(key) as Annotation | undefined;
      if (!raw) continue;

      let ann: Annotation;
      try {
        ann = sanitizeAnnotation(raw);
      } catch (err) {
        console.warn(`[EventQueue] sanitizeAnnotation failed for key=${key}:`, err);
        continue;
      }

      if (change.action === "add" && ann.author === "user") {
        pushEvent({
          id: generateEventId(),
          type: "annotation:created",
          timestamp: Date.now(),
          documentId: docName,
          payload: {
            annotationId: ann.id,
            annotationType: ann.type,
            content: ann.content,
            textSnippet: ann.textSnapshot ?? "",
            ...(ann.suggestedText !== undefined ? { hasSuggestedText: true } : {}),
            ...(ann.directedAt ? { directedAt: ann.directedAt } : {}),
          },
        });
      } else if (change.action === "update" && ann.author === "claude") {
        if (ann.status === "accepted") {
          pushEvent({
            id: generateEventId(),
            type: "annotation:accepted",
            timestamp: Date.now(),
            documentId: docName,
            payload: {
              annotationId: ann.id,
              textSnippet: ann.textSnapshot ?? "",
            },
          });
        } else if (ann.status === "dismissed") {
          pushEvent({
            id: generateEventId(),
            type: "annotation:dismissed",
            timestamp: Date.now(),
            documentId: docName,
            payload: {
              annotationId: ann.id,
              textSnippet: ann.textSnapshot ?? "",
            },
          });
        }
      }
    }
  };

  annotationsMap.observe(annotationsObs);
  return () => annotationsMap.unobserve(annotationsObs);
}
