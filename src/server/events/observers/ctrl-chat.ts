/** Observer for CTRL_ROOM's Y.Map('chat'). */

import * as Y from "yjs";
import { Y_MAP_CHAT } from "../../../shared/constants.js";
import { shouldSkipChannel } from "../../../shared/origins.js";
import type { ChatMessage, FlatOffset } from "../../../shared/types.js";
import {
  classChatRowAdded,
  isLocalPeriodChat,
  markWithheldForLocalPeriod,
  noteChatRowDeleted,
  selectionMayBeHanded,
} from "../../models/local-period.js";
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
    // #1123 A2: every row is classed once, the first time the server sees its
    // `add`, BEFORE the origin skip and whatever its author — so Claude's own
    // rows, the local model's and a restore's rows are classed too, and no
    // later write (a `read` stamp, `localRun`) ever re-classes one. A row
    // deleted keeps its class, so a same-key re-add keeps it.
    for (const [key, change] of event.changes.keys) {
      if (change.action === "add") classChatRowAdded(key);
      else if (change.action === "delete") noteChatRowDeleted(key);
    }

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
        // #1123 A2 (decision 11): the buffered selection is consumed either
        // way, but attached only when it may be handed — none while a local
        // model answers chat (this push then reaches only in-process
        // subscribers anyway), and afterwards only a selection whose stamp
        // differs from the one recorded at the switch back or at boot.
        const handable =
          buffered !== undefined && selectionMayBeHanded(msg.documentId, buffered.stamp);
        if (buffered) selectionBuffer.delete(msg.documentId);
        if (buffered && handable) {
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
              // An explicit copy: the buffer's `stamp` never reaches the wire.
              selection = {
                from: buffered.from,
                to: buffered.to,
                selectedText: buffered.selectedText,
              };
            } else {
              // Range went stale or out of bounds — degrade to text only (no
              // offsets). Logged rather than left to be inferred from an event
              // that quietly lost its `from`/`to`: this one runs with a human
              // waiting on the reply, and it passes no hoisted `text`, so it pays
              // a full `extractText` per chat message to answer it.
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

      const pushed: TandemEvent = {
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
      };
      // Local-period chat re-added under its key after the local period is
      // still local-period chat: never pushed to Claude (R3.4b).
      if (isLocalPeriodChat(key)) markWithheldForLocalPeriod(pushed);
      pushEvent(pushed);
    }
  };

  chatMap.observe(chatObs);
  return () => chatMap.unobserve(chatObs);
}
