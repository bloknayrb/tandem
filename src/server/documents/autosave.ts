/**
 * Arming the auto-save loop.
 *
 * Its own module (ADR-034 Unit 7a) rather than a name on the open seam: both
 * the open pipeline and the reload family arm it, so leaving it in either one
 * would have put an implementation detail on a published surface and made the
 * other import it from a module it otherwise has no business reading.
 */

import { autoSaveAllToDisk } from "../mcp/document-service.js";
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
    for (const [docId, state] of getOpenDocs()) {
      const d = getOrCreateDocument(docId);
      await saveSession(state.filePath, state.format, d, {
        dirty: isDirty(docId),
        conflict: readPendingConflict(d),
      });
    }
    // Disk saves (eligible .md/.txt documents only)
    await autoSaveAllToDisk();
  });
}
