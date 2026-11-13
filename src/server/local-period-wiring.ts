/**
 * Wiring for the local period (#1123 A2): the hooks `models/local-period.ts`
 * needs from layers it must not import (the inbox, the event queue, the
 * delivery join, the CTRL session), handed over once at boot. Called only
 * under `BYO_MODELS_ENABLED`, from `index.ts`, OUTSIDE the `try` that primes
 * who answers chat, so a failed prime still installs it and still records
 * the selection hold (guard 2's work).
 */

import {
  CTRL_ROOM,
  Y_MAP_CHAT,
  Y_MAP_SELECTION,
  Y_MAP_USER_AWARENESS,
} from "../shared/constants.js";
import { discardSuspendedRound, suspendDeliveryRound } from "./events/delivery-state.js";
import { clearBufferedSelections, emitAnswererReturnWake } from "./events/queue.js";
import { unansweredUserChatKeys } from "./mcp/awareness.js";
import { getOpenDocs } from "./mcp/document-service.js";
import { bootLocalPeriod, installLocalPeriod } from "./models/local-period.js";
import { saveCtrlSession } from "./session/manager.js";
import { getDocument, getOrCreateDocument } from "./yjs/provider.js";

export function wireLocalPeriod(): void {
  installLocalPeriod({
    unansweredUserChat: unansweredUserChatKeys,
    chatKeys: () => [...getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT).keys()],
    currentSelections: () => {
      const out: Array<{ documentId: string; stamp: unknown }> = [];
      for (const documentId of getOpenDocs().keys()) {
        const doc = getDocument(documentId);
        if (!doc) continue;
        const selection = doc.getMap(Y_MAP_USER_AWARENESS).get(Y_MAP_SELECTION) as
          | { timestamp?: unknown }
          | undefined;
        out.push({ documentId, stamp: selection?.timestamp });
      }
      return out;
    },
    suspendDeliveryRound,
    discardSuspendedRound,
    clearBufferedSelections,
    emitReturnWake: emitAnswererReturnWake,
    // The third CTRL write site (the ruling): the classes, the owed set and the
    // open marker are durable from the switch on, through the queued path.
    persist: () => {
      saveCtrlSession(getOrCreateDocument(CTRL_ROOM)).catch((err: unknown) => {
        console.error("[Tandem] Could not save chat state at the switch of who answers chat:", err);
      });
    },
  });
  bootLocalPeriod();
}
