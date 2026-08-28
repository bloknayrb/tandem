/**
 * Attaching a document's annotation envelope to its Y.Doc.
 *
 * Split out of `mcp/file-opener.ts` for ADR-034 Unit 7a. Both the open
 * pipeline and `renameDocument` wire annotations, and neither needs anything
 * else file-opener holds, so this sits below both rather than between them.
 */

import path from "path";
import type * as Y from "yjs";
import { generateNotificationId } from "../../shared/utils.js";
import { docHash } from "../annotations/doc-hash.js";
import { recoverRenamedEnvelope } from "../annotations/rename-recovery.js";
import { annotationFileExists, createStore } from "../annotations/store.js";
import { loadAndMerge } from "../annotations/sync.js";
import { setFileSyncContext } from "../events/queue.js";
import { pushNotification } from "../notifications.js";

/**
 * Wire a document's annotations to the durable per-doc store.
 *
 * Runs `loadAndMerge` so on-disk state merges with whatever the Y.Doc already
 * holds (session restore, force-reload content, or a freshly-loaded file),
 * then registers the resulting observer cleanup against the event queue's
 * per-doc registry so reattach-on-doc-swap keeps persistence alive.
 *
 * Errors here MUST NOT fail the open — annotations are additive durability,
 * not required for rendering. We log and continue.
 *
 * Returns `{ wired: boolean }` so callers that care about a genuine internal
 * failure can branch on it (#1057). `wired` is `true` only when `loadAndMerge`
 * AND `setFileSyncContext` both ran to completion. An internal failure (e.g. a
 * `loadAndMerge` throw) is still SWALLOWED — the open/save must never fail — but
 * now reports `{ wired: false }` so the caller knows `setFileSyncContext` never
 * ran and any prior file-sync context is still registered and live.
 * `renameDocument` gates its old-envelope removal on this to close the
 * internal-failure steal vector that the boundary-rejection guard alone misses.
 * (Boundary rejections — e.g. a failed dynamic import upstream — are unaffected
 * here and continue to propagate to the caller's own try/catch.)
 */
export async function wireAnnotationStore(
  id: string,
  doc: Y.Doc,
  filePath: string,
  opts?: { allowRecovery?: boolean; migrateTombstonesFrom?: string },
): Promise<{ wired: boolean }> {
  try {
    const hash = docHash(filePath);

    // Rename recovery (#313): on a genuine first open, if NO envelope exists at
    // this document's path-hash, the file may have been renamed (new path -> new
    // hash), orphaning its annotations. Try to re-associate an orphaned envelope
    // by exact content match. Runs BEFORE loadAndMerge so the re-keyed envelope
    // is the one loadAndMerge picks up. Gating on "no existing envelope"
    // guarantees recovery never steals from a live envelope.
    //
    // Only enabled for the normal-open path. Force-reload (clearAndReload)
    // deliberately clears the envelope and must NOT resurrect a stale orphan;
    // upload:// recovery is deferred (see rename-recovery.ts header).
    if (opts?.allowRecovery && !(await annotationFileExists(hash))) {
      await recoverRenamedEnvelope(doc, hash, filePath);
    }

    const store = createStore(hash, { filePath });
    // Rename only (#1040, windows a2/a3): `migrateTombstonesFrom` (the oldHash)
    // tells loadAndMerge to fold the oldHash tombstone ledger forward into this
    // (new) hash AFTER its `store.load()` read but BEFORE the merge consults the
    // ledger. That single, precisely-placed fold catches a DELETE that arrives
    // either before this call (recorded into oldHash during the fs.rename) or
    // DURING the load read (recorded by the still-attached old observer), so the
    // merge applies the tombstone instead of re-inserting the just-deleted record
    // from the RMW envelope. Undefined on every normal open/reload — no fold.
    const cleanup = await loadAndMerge(
      {
        ydoc: doc,
        store,
        docHash: hash,
        meta: { filePath },
      },
      { migrateTombstonesFrom: opts?.migrateTombstonesFrom },
    );
    setFileSyncContext(id, { ydoc: doc, store, docHash: hash, meta: { filePath } }, cleanup);
    return { wired: true };
  } catch (err) {
    // Annotations are additive durability — never block a doc open. But a
    // silent console.error means the user never knows their pre-existing
    // annotations aren't loading and new ones won't persist. Surface via
    // the notification bus (deduped per-file so a per-route retry storm
    // doesn't flood the UI).
    console.error("[Tandem] wireAnnotationStore failed for %s (%s):", id, filePath, err);
    pushNotification({
      id: generateNotificationId(),
      type: "save-error",
      severity: "warning",
      message: `Annotations for ${path.basename(filePath) || id} are not being saved this session. See server log.`,
      dedupKey: `annotation-wire:${id}`,
      timestamp: Date.now(),
    });
    // Signal the internal failure to callers that care (#1057). `wired:false`
    // means setFileSyncContext did NOT run, so the prior file-sync context (if
    // any) is still registered and live. renameDocument uses this to fire its
    // !rewired guard and dispose the stale oldHash observer before clear(),
    // closing the steal vector even on an internal loadAndMerge throw. Other
    // callers ignore the result — the swallow keeps open/save non-fatal.
    return { wired: false };
  }
}
