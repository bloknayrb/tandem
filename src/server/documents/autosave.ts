/**
 * Arming the auto-save loop.
 *
 * Its own module (ADR-034 Unit 7a) rather than a name on the open seam: both
 * the open pipeline and the reload family arm it, so leaving it in either one
 * would have put an implementation detail on a published surface and made the
 * other import it from a module it otherwise has no business reading.
 */

import { generateNotificationId } from "../../shared/utils.js";
import { autoSaveAllToDisk } from "../mcp/document-service.js";
import { pushNotification } from "../notifications.js";
import { isAutoSaveRunning, saveSession, startAutoSave } from "../session/manager.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { readPendingConflict } from "./conflict.js";
import { isDirty } from "./dirty.js";
import { getOpenDocs } from "./registry.js";

export function ensureAutoSave(): void {
  if (isAutoSaveRunning()) return;
  startAutoSave(async () => {
    // Session saves (all documents — preserves CRDT state for restart recovery).
    // `dirty` rides along (#1069) so reopen can tell whether the session holds
    // unsaved edits — the restore-vs-reload prompt keys off it. `conflict`
    // rides along too (#1238): this pass runs BEFORE autoSaveAllToDisk below,
    // so on a conflicted document it is the writer that persists the pending
    // keep-vs-reload choice across a restart.
    //
    // Per-document try/catch (#1750): without it one throwing document — an
    // `ENAMETOOLONG` session key was the reported instance — aborted the loop,
    // so every document after it in iteration order silently never got a
    // session write AND `autoSaveAllToDisk` below never ran, suppressing the
    // entire 60 s disk flush for every open document until that tab was closed.
    // That is why #1750 reads as "cannot save".
    let failures = 0;
    for (const [docId, state] of getOpenDocs()) {
      const d = getOrCreateDocument(docId);
      try {
        await saveSession(state.filePath, state.format, d, {
          dirty: isDirty(docId),
          conflict: readPendingConflict(d),
        });
      } catch (err) {
        failures++;
        console.error("[AutoSave] saveSession failed for %s:", state.filePath, err);
      }
    }
    if (failures > 0) {
      // One deduped notification per tick, not per document. A persistent
      // failure still pushes one record per 60 s into the 50-entry ring.
      pushNotification({
        id: generateNotificationId(),
        type: "general-error",
        severity: "warning",
        message: `Could not save ${failures} document session${failures === 1 ? "" : "s"}. Recovery state may be out of date.`,
        dedupKey: "session-save-failed",
        timestamp: Date.now(),
      });
    }
    // Disk saves (eligible .md/.txt documents only)
    await autoSaveAllToDisk();
  });
}
