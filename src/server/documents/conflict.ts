/**
 * The external-conflict flag: reading it, and raising it.
 *
 * Split out for ADR-034 Unit 7a. `readPendingConflict` came from
 * `mcp/document-service.ts` and `flagExternalConflict` from
 * `mcp/file-opener.ts`; they are two halves of one piece of state
 * (`Y_MAP_EXTERNAL_CONFLICT`) that had no shared home, which is why the
 * watcher had to reach into document-service to ask a question about a map it
 * writes itself.
 *
 * Resolution deliberately lives elsewhere — `resolveExternalConflict` in
 * `documents/reload-family.ts`: clearing the flag runs the reload lifecycle,
 * which is a different dependency set entirely.
 */

import path from "path";
import type * as Y from "yjs";
import { Y_MAP_DOCUMENT_META, Y_MAP_EXTERNAL_CONFLICT } from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import type { ExternalConflictState } from "../../shared/types.js";
import { generateNotificationId } from "../../shared/utils.js";
import { pushNotification } from "../notifications.js";
import { narrowConflict } from "../session/manager.js";

/**
 * Read a document's pending external-conflict flag, if any (#1238).
 *
 * Deliberately a read at the *call site's* moment rather than something
 * `saveSession` does for itself: on the success path `saveSession` runs before
 * the flag is cleared, so a self-read there would persist a conflict the save
 * just resolved and re-raise the banner on a clean, in-sync document.
 *
 * Routed through `narrowConflict` (review finding): the raw Y.Map value is as
 * untrusted as a restored session's JSON — any WS peer with room access can
 * set `Y_MAP_EXTERNAL_CONFLICT` via Hocuspocus, and this return value feeds
 * save-blocking decisions and round-trips into the on-disk session file
 * verbatim. A bare cast would take a forged/malformed value on trust.
 */
export function readPendingConflict(doc: Y.Doc): ExternalConflictState | undefined {
  return narrowConflict(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_EXTERNAL_CONFLICT));
}

/**
 * Record an external-conflict on a document (#1069; every format since #1238):
 * write the state into Y_MAP_DOCUMENT_META (CRDT-broadcast, so clients render
 * the keep-vs-reload banner and late-joining clients still see it) and push a
 * toast. `withInternal` per ADR-031 — server-detected metadata, not user
 * intent; both the channel queue and durable-sync skip it.
 */
export function flagExternalConflict(
  id: string,
  doc: Y.Doc,
  filePath: string,
  conflict: ExternalConflictState,
): void {
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  withInternal(doc, () => meta.set(Y_MAP_EXTERNAL_CONFLICT, conflict));
  pushNotification({
    id: generateNotificationId(),
    type: "external-conflict",
    severity: "warning",
    message:
      conflict.kind === "external-edit"
        ? `${path.basename(filePath)} changed on disk while you have unsaved edits. Choose to keep your edits or reload from the file.`
        : `Unsaved edits for ${path.basename(filePath)} were restored from your last session${conflict.diskChanged ? ", but the file also changed on disk" : ""}. Choose to keep them or reload from the file.`,
    documentId: id,
    dedupKey: `external-conflict:${id}`,
    timestamp: Date.now(),
  });
}
