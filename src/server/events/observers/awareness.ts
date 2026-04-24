import * as Y from "yjs";
import {
  CTRL_ROOM,
  SELECTION_DWELL_DEFAULT_MS,
  SELECTION_DWELL_MAX_MS,
  SELECTION_DWELL_MIN_MS,
  Y_MAP_DWELL_MS,
  Y_MAP_USER_AWARENESS,
} from "../../../shared/constants.js";
import type { FlatOffset } from "../../../shared/types.js";
import { getOrCreateDocument } from "../../yjs/provider.js";
import { MCP_ORIGIN } from "../origins.js";
import type { BufferedSelection } from "../types.js";

/**
 * Read the user's configured selection dwell time from CTRL_ROOM.
 *
 * Called at timer-schedule time (not fire time), so mid-dwell slider changes
 * don't affect an in-flight timer — the updated value takes effect on the
 * next selection change.
 *
 * Falls back to `SELECTION_DWELL_DEFAULT_MS` when:
 *   - CTRL_ROOM has no dwell key set (normal on cold startup, before the
 *     client's broadcast effect runs)
 *   - The stored value is the wrong type or outside [MIN, MAX] — the client
 *     clamps on write, so this branch indicates a bug or client/server
 *     constant drift. Logged as a warning so it can be diagnosed.
 */
function getDwellMs(): number {
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
  const val = awareness.get(Y_MAP_DWELL_MS);
  if (val === undefined) return SELECTION_DWELL_DEFAULT_MS;
  if (typeof val === "number" && val >= SELECTION_DWELL_MIN_MS && val <= SELECTION_DWELL_MAX_MS) {
    return val;
  }
  console.warn(
    `[EventQueue] Invalid dwell time in CTRL_ROOM awareness (type=${typeof val}, value=${String(val)}); using default ${SELECTION_DWELL_DEFAULT_MS}ms`,
  );
  return SELECTION_DWELL_DEFAULT_MS;
}

export function makeAwarenessObserver(deps: {
  docName: string;
  doc: Y.Doc;
  selectionBuffer: Map<string, BufferedSelection>;
}): () => void {
  const { docName, doc, selectionBuffer } = deps;
  const userAwareness = doc.getMap(Y_MAP_USER_AWARENESS);
  let selectionDwellTimer: ReturnType<typeof setTimeout> | null = null;

  const awarenessObs = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (txn.origin === MCP_ORIGIN) return;

    if (event.keysChanged.has("selection")) {
      const selection = userAwareness.get("selection") as
        | { from: FlatOffset; to: FlatOffset; selectedText?: string }
        | undefined;

      // Cancel any pending dwell timer
      if (selectionDwellTimer) {
        clearTimeout(selectionDwellTimer);
        selectionDwellTimer = null;
      }

      // Skip cleared selections — also clear the buffer
      if (!selection || selection.from === selection.to) {
        selectionBuffer.delete(docName);
        return;
      }

      // Buffer after dwell to filter transient drag selections
      selectionDwellTimer = setTimeout(() => {
        selectionDwellTimer = null;
        selectionBuffer.set(docName, {
          from: selection.from,
          to: selection.to,
          selectedText: selection.selectedText ?? "",
        });
      }, getDwellMs());
    }
  };

  userAwareness.observe(awarenessObs);
  return () => {
    userAwareness.unobserve(awarenessObs);
    if (selectionDwellTimer) clearTimeout(selectionDwellTimer);
    selectionBuffer.delete(docName);
  };
}
