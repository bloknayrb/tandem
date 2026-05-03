import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import { sanitizeAnnotation } from "../../../shared/sanitize.js";
import type { Annotation } from "../../../shared/types.js";
import { relaySanitizationEvent } from "../../annotations/migration-log.js";
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
        ann = sanitizeAnnotation(raw, (event) => relaySanitizationEvent(docName, event));
      } catch (err) {
        console.warn(`[EventQueue] sanitizeAnnotation failed for key=${key}:`, err);
        continue;
      }

      if (change.action === "add" && ann.author === "user") {
        // ADR-027: notes are user-private; highlights are user-only UI markup.
        // Only comments surface to the channel (Claude). The early-continue
        // makes this privacy invariant structurally explicit — a future
        // refactor that drops the type check breaks visibly here, not by
        // silently leaking notes.
        if (ann.type !== "comment") continue;
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
          },
        });
      } else if (change.action === "update" && ann.author === "user" && ann.type === "comment") {
        const oldRaw = change.oldValue as Annotation | undefined;
        if (oldRaw?.type === "note") {
          // Note promoted to comment via "Send to Claude" — surface it to the channel
          // so real-time subscribers see it as a new comment event.
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
            },
          });
        } else {
          // Comment edited by user — surface edit to channel if editedAt advanced.
          const newEditedAt = ann.editedAt ?? 0;
          const oldEditedAt = (oldRaw as Annotation | undefined)?.editedAt ?? 0;
          if (newEditedAt > oldEditedAt) {
            pushEvent({
              id: generateEventId(),
              type: "annotation:edited",
              timestamp: Date.now(),
              documentId: docName,
              payload: {
                annotationId: ann.id,
                content: ann.content,
                textSnippet: ann.textSnapshot ?? "",
                editedAt: newEditedAt,
              },
            });
          }
        }
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
