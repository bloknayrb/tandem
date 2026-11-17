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
import { appendClaudeChatMessage, unansweredUserChatKeys } from "./mcp/awareness.js";
import { getOpenDocs } from "./mcp/document-service.js";
import {
  bootLocalPeriod,
  installLocalPeriod,
  SWITCH_BACK_LINE_TEXT,
} from "./models/local-period.js";
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
    // #1123 part B, R11: the line at the user's own switch back. A new caller
    // of `appendClaudeChatMessage`, so a new AI surface (Critical Rule 9): the
    // append is `withMcp` and the licence refuses it like any AI chat write —
    // then no line appears (R11.6, accepted). A Tandem notice, never handed to
    // Claude (the inbox hands only user rows) and never an answer
    // (`answeredChatIds` skips notices); no `replyTo`, no `documentId`.
    writeSwitchBackLine: () => {
      const appended = appendClaudeChatMessage(SWITCH_BACK_LINE_TEXT, {
        chatNotice: "claude-again",
      });
      if (!appended.ok) {
        console.error(
          `[Tandem] The chat line for the switch back to Claude was not written (${appended.refusal.kind}).`,
        );
      }
    },
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
