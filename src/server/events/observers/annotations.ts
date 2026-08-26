import type * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import type { Annotation } from "../../../shared/types.js";
import { relaySanitizationEvent } from "../../annotations/migration-log.js";
import {
  acceptedPayload,
  createdPayload,
  describeRefusal,
  dismissedPayload,
  editedPayload,
  narrowForChannel,
} from "../../annotations/projection.js";
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
      // ADR-035: the single narrow. Sanitizes, then requires
      // `audience === "outbound" && type !== "note"`. Everything below builds
      // its payload from `ann`, and the builders take `ChannelEligible` — so a
      // branch that forgets to narrow is a compile error, not a silent leak.
      const ann = narrowForChannel(raw, {
        onLossy: (event) => relaySanitizationEvent(docName, event),
        onRefused: (refusal, refused) => {
          if (refusal.reason !== "unsanitizable") return;
          console.warn(
            `[EventQueue] sanitizeAnnotation failed for key=${key}: ${describeRefusal(refusal, refused?.id)}`,
          );
        },
      });
      if (!ann) return undefined;

      // The narrow says whether this annotation MAY be projected. It cannot say
      // which transition happened — only the action/author/status cascade below
      // can tell an add from an edit from an accept, so each keeps its own gate.
      if (action === "add" && ann.author === "user") {
        // Comments only on the add path. Kept alongside the narrow rather than
        // folded into it: this is a product rule about which of the user's own
        // annotations start a conversation, not the privacy rule.
        if (ann.type !== "comment") return undefined;
        return {
          id: generateEventId(),
          type: "annotation:created",
          timestamp: Date.now(),
          documentId: docName,
          payload: createdPayload(ann),
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
            payload: createdPayload(ann),
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
          payload: editedPayload(ann, newEditedAt),
        };
      }

      if (action === "update" && ann.author === "claude") {
        // No `type` check here any more: the narrow already refused notes, and
        // it refused them against the SANITIZED value rather than the raw one,
        // which is strictly stronger than the guard this replaces.
        if (ann.status === "accepted") {
          return {
            id: generateEventId(),
            type: "annotation:accepted",
            timestamp: Date.now(),
            documentId: docName,
            payload: acceptedPayload(ann),
          };
        }
        if (ann.status === "dismissed") {
          return {
            id: generateEventId(),
            type: "annotation:dismissed",
            timestamp: Date.now(),
            documentId: docName,
            payload: dismissedPayload(ann),
          };
        }
      }

      return undefined;
    },
  });
}
