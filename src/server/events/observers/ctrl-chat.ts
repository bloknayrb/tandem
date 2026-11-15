/** Observer for CTRL_ROOM's Y.Map('chat'). */

import * as Y from "yjs";
import { Y_MAP_CHAT } from "../../../shared/constants.js";
import { shouldSkipChannel } from "../../../shared/origins.js";
import type { ChatMessage, FlatOffset } from "../../../shared/types.js";
import { chatClientWritesUndone } from "../../chat-client-writes.js";
import { noteChatRowsDeleted } from "../../chat-row-deletions.js";
import {
  classChatRowAdded,
  isLocalPeriodChat,
  markWithheldForLocalPeriod,
  noteChatRowDeleted,
  selectionMayBeHanded,
} from "../../models/local-period.js";
import { describeRangeFailure, validateRange } from "../../positions.js";
import { getOrCreateDocument } from "../../yjs/provider.js";
import { noteChatMessageRowKey } from "../delivery-state.js";
import type { BufferedSelection, TandemEvent } from "../types.js";
import { generateEventId } from "../types.js";
import {
  applyChatUndo,
  type ChatUndo,
  dropPendingUpdates,
  isClientConnection,
  planChatUndo,
} from "./chat-client-undo.js";

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
    // deleted keeps its class, so a same-key re-add keeps it. The one
    // exception (#2358, the posts PR): with ownership on, a row a client
    // connection added that the undo deletes at once (not a user row) is
    // never classed (`removing` below).
    //
    // #2358 (the posts PR, R4): with ownership on, a client connection's
    // change to the chat map is undone (`chat-client-undo.ts`). Decided first,
    // from this event, so a delete that is about to be put back tells nobody
    // it happened: #2419's ledger and the ownership side keep everything keyed
    // by that row (R4.2), and the row's restore (an `add` under its old key)
    // keeps its class (R4.6).
    const undo: ChatUndo | undefined =
      isClientConnection(txn.origin) && chatClientWritesUndone()
        ? planChatUndo(chatMap, event)
        : undefined;
    const deleted: string[] = [];
    // A row a client added that the undo deletes at once (not a user row) is
    // never classed, so a tab cannot fill #2419's deleted-class ledger with
    // keys of its own and evict real ones (review round 1, item 12); its
    // delete then finds no class and notes nothing.
    const removing = new Set(undo?.removed ?? []);
    for (const [key, change] of event.changes.keys) {
      if (change.action === "add") {
        if (!removing.has(key)) classChatRowAdded(key);
      } else if (change.action === "delete") {
        if (undo?.restored.has(key)) continue;
        noteChatRowDeleted(key);
        deleted.push(key);
      }
    }
    // #2358 (the chat owners PR, R3.6): a deleted row's per-message owner
    // goes, whatever the origin — through the seam, never an import of the
    // ownership module.
    noteChatRowsDeleted(deleted);
    // The undo itself: one `withInternal` write, run now (Yjs runs a nested
    // transaction's body at once and its observers after), so the push loop
    // below reads the repaired rows. `internal` is skipped by the channel
    // gate, so the undo emits no `chat:message`.
    if (undo && !applyChatUndo(ctrlDoc, chatMap, undo)) {
      // Fail closed on the bookkeeping (security review M2): a delete the
      // failed undo did not put back is a delete, so tell its ledgers now.
      const gone = [...undo.restored.keys()].filter(
        (key) => !chatMap.has(key) && event.changes.keys.get(key)?.action === "delete",
      );
      for (const key of gone) noteChatRowDeleted(key);
      noteChatRowsDeleted(gone);
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
      // The delivery round's key (#2358, the delivery-rounds PR, R1.1): the
      // row's chat-map key, noted beside the event, never on it. Read only
      // while rounds are keyed (ownership on).
      noteChatMessageRowKey(pushed, key);
      pushEvent(pushed);
    }
  };

  // #2358 (the posts PR; security review H1): with ownership on, a client
  // connection's update that leaves data pending in the CTRL doc's store is
  // dropped at once. A fully pending update changes no map, so the chat
  // observer never sees it; this sees every transaction.
  const pendingGuard = (txn: Y.Transaction) => {
    if (!isClientConnection(txn.origin) || !chatClientWritesUndone()) return;
    if (dropPendingUpdates(ctrlDoc)) {
      console.error(
        "[Tandem] A browser tab sent CTRL updates that depend on data the server never wrote; they were dropped",
      );
    }
  };

  chatMap.observe(chatObs);
  ctrlDoc.on("afterTransaction", pendingGuard);
  return () => {
    chatMap.unobserve(chatObs);
    ctrlDoc.off("afterTransaction", pendingGuard);
  };
}
