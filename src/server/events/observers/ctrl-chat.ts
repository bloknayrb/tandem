/** Observer for CTRL_ROOM's Y.Map('chat'). */

import * as Y from "yjs";
import { Y_MAP_CHAT } from "../../../shared/constants.js";
import { shouldSkipChannel } from "../../../shared/origins.js";
import type { ChatMessage, FlatOffset } from "../../../shared/types.js";
import { describeRangeFailure, validateRange } from "../../positions.js";
import { getOrCreateDocument } from "../../yjs/provider.js";
import type { BufferedSelection, TandemEvent } from "../types.js";
import { generateEventId } from "../types.js";

export function makeCtrlChatObserver(deps: {
  ctrlDoc: Y.Doc;
  pushEvent: (e: TandemEvent) => void;
  selectionBuffer: Map<string, BufferedSelection>;
}): () => void {
  const { ctrlDoc, pushEvent, selectionBuffer } = deps;
  const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

  const chatObs = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (shouldSkipChannel(txn.origin)) return;

    for (const [key, change] of event.changes.keys) {
      if (change.action !== "add") continue;
      const msg = chatMap.get(key) as ChatMessage | undefined;
      if (!msg || msg.author !== "user") continue;

      // Attach buffered selection context if available for this document
      let selection:
        | { from: number; to: number; selectedText: string }
        | { selectedText: string }
        | undefined;
      if (msg.documentId) {
        const buffered = selectionBuffer.get(msg.documentId);
        if (buffered) {
          selectionBuffer.delete(msg.documentId);
          // Validate range is still valid before attaching offsets.
          //
          // The `try` wraps `getOrCreateDocument` ONLY. `validateRange` does not
          // throw, and leaving it inside the catch meant a validator bug would
          // be indistinguishable from "that document isn't loaded" — the same
          // degraded, text-only event either way, with a message that names
          // neither. Narrow catch, explicit rejection log.
          let doc: Y.Doc | undefined;
          try {
            doc = getOrCreateDocument(msg.documentId);
          } catch (err) {
            console.warn(
              `[EventQueue] Failed to load document for buffered selection doc=${msg.documentId}:`,
              err,
            );
          }
          if (doc) {
            const validation = validateRange(
              doc,
              buffered.from as FlatOffset,
              buffered.to as FlatOffset,
            );
            if (validation.ok) {
              selection = buffered;
            } else {
              // Range went stale or out of bounds — degrade to text only (no
              // offsets). This is the one `validateRange` hoist site with a human
              // waiting on the answer, so the degradation is logged rather than
              // inferred from an event that quietly lost its `from`/`to`.
              console.warn(
                `[EventQueue] Buffered selection dropped its offsets for doc=${msg.documentId}: ` +
                  `[${buffered.from}, ${buffered.to}] — ${describeRangeFailure(validation)}`,
              );
              selection = { selectedText: buffered.selectedText };
            }
          } else {
            selection = { selectedText: buffered.selectedText };
          }
        }
      }

      pushEvent({
        id: generateEventId(),
        type: "chat:message",
        timestamp: Date.now(),
        documentId: msg.documentId,
        payload: {
          messageId: msg.id,
          text: msg.text,
          replyTo: msg.replyTo ?? null,
          anchor: msg.anchor ?? null,
          ...(selection ? { selection } : {}),
        },
      });
    }
  };

  chatMap.observe(chatObs);
  return () => chatMap.unobserve(chatObs);
}
