/** Observer for CTRL_ROOM's Y.Map('chat'). */

import * as Y from "yjs";
import { Y_MAP_CHAT } from "../../../shared/constants.js";
import type { ChatMessage, FlatOffset } from "../../../shared/types.js";
import { validateRange } from "../../positions.js";
import { getOrCreateDocument } from "../../yjs/provider.js";
import { MCP_ORIGIN } from "../origins.js";
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
    if (txn.origin === MCP_ORIGIN) return;

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
          // Validate range is still valid before attaching offsets
          try {
            const doc = getOrCreateDocument(msg.documentId);
            const validation = validateRange(
              doc,
              buffered.from as FlatOffset,
              buffered.to as FlatOffset,
            );
            if (validation.ok) {
              selection = buffered;
            } else {
              // Range went stale — attach text only (no offsets)
              selection = { selectedText: buffered.selectedText };
            }
          } catch (err) {
            console.warn(
              `[EventQueue] Failed to validate buffered selection for doc=${msg.documentId}:`,
              err,
            );
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
