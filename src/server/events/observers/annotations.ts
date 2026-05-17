import type * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import { sanitizeAnnotation } from "../../../shared/sanitize.js";
import type { Annotation } from "../../../shared/types.js";
import { relaySanitizationEvent } from "../../annotations/migration-log.js";
import type { TandemEvent } from "../types.js";
import { generateEventId } from "../types.js";
import { makePerKeyChangeObserver } from "./factory.js";

export function makeAnnotationsObserver(deps: {
  docName: string;
  doc: Y.Doc;
  pushEvent: (e: TandemEvent) => void;
}): () => void {
  const { docName, doc, pushEvent } = deps;
  const annotationsMap = doc.getMap(Y_MAP_ANNOTATIONS);

  return makePerKeyChangeObserver<Annotation>({
    map: annotationsMap,
    pushEvent,
    derive: ({ key, action, value: raw, oldValue: oldRaw }): TandemEvent | undefined => {
      if (!raw) return undefined;

      let ann: Annotation;
      try {
        ann = sanitizeAnnotation(raw, (event) => relaySanitizationEvent(docName, event));
      } catch (err) {
        console.warn(`[EventQueue] sanitizeAnnotation failed for key=${key}:`, err);
        return undefined;
      }

      if (action === "add" && ann.author === "user") {
        // ADR-027: notes are user-private; highlights are user-only UI markup.
        // Only comments surface to the channel (Claude). The early return
        // makes this privacy invariant structurally explicit — a future
        // refactor that drops the type check breaks visibly here, not by
        // silently leaking notes.
        if (ann.type !== "comment") return undefined;
        return {
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
        };
      }

      if (action === "update" && ann.author === "user" && ann.type === "comment") {
        if (oldRaw?.type === "note") {
          // Note promoted to comment via "Send to Claude" — surface it to the channel
          // so real-time subscribers see it as a new comment event.
          return {
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
          };
        }
        // Comment edited by user — surface edit to channel if editedAt advanced.
        const newEditedAt = ann.editedAt ?? 0;
        const oldEditedAt = oldRaw?.editedAt ?? 0;
        if (newEditedAt <= oldEditedAt) return undefined;
        return {
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
        };
      }

      if (action === "update" && ann.author === "claude") {
        if (ann.status === "accepted") {
          return {
            id: generateEventId(),
            type: "annotation:accepted",
            timestamp: Date.now(),
            documentId: docName,
            payload: {
              annotationId: ann.id,
              textSnippet: ann.textSnapshot ?? "",
            },
          };
        }
        if (ann.status === "dismissed") {
          return {
            id: generateEventId(),
            type: "annotation:dismissed",
            timestamp: Date.now(),
            documentId: docName,
            payload: {
              annotationId: ann.id,
              textSnippet: ann.textSnapshot ?? "",
            },
          };
        }
      }

      return undefined;
    },
  });
}
