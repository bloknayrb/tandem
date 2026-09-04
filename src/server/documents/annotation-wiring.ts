/**
 * Attaching a document's annotation envelope to its Y.Doc.
 *
 * Split out of `mcp/file-opener.ts` for ADR-034 Unit 7a (that module was
 * deleted in Unit 7c). Both the open pipeline and `renameDocument` wire
 * annotations, and neither needed anything else file-opener held, so this sits
 * below both rather than between them.
 */

import path from "path";
import type * as Y from "yjs";
import { generateNotificationId } from "../../shared/utils.js";
import { docHash } from "../annotations/doc-hash.js";
import { recoverRenamedEnvelope } from "../annotations/rename-recovery.js";
import { annotationFileExists, createStore } from "../annotations/store.js";
import { loadAndMerge } from "../annotations/sync.js";
import { setFileSyncContext } from "../events/queue.js";
import { collectAnnotations, refreshAllRanges } from "../mcp/annotations.js";
import { pushNotification } from "../notifications.js";

/**
 * Re-anchor every annotation whose relRange belongs to a destroyed lineage
 * (#1800 fallback restore). The clone copies annotation RECORDS byte-exact
 * but their CRDT anchors point at the scratch doc's lineage, so
 * `createAbsolutePositionFromRelativePosition` returns null on the live doc
 * and every restored annotation would take `refreshRange`'s dead-relRange
 * branch — re-anchored from stored flat offsets, which is only safe because
 * the clone is byte-exact. Byte-exactness expires at the first edit, so the
 * repair cannot wait for whoever calls `refreshAllRanges` next: nothing on
 * the open path calls it (every server caller is downstream of a later
 * action and the client never writes back), while `loadAndMerge` snapshots
 * the dead relRange into the durable envelope on this very open.
 *
 * `map` is a PARAMETER, not `doc.getMap(Y_MAP_ANNOTATIONS)` computed here:
 * this module has no `shared/constants.ts` edge and computing it here would
 * add a second boundary row. The caller already holds the map.
 *
 * The hash is `docHash(filePath)`, mirroring the watcher's reload hash — not
 * the document id, which is a different key entirely.
 *
 * `MCP_ORIGIN` over note records is correct: `collectAnnotations` does not
 * filter notes, anchor maintenance is not an edit/resolve/remove (ADR-027
 * guards those, and the watcher's reload already refreshes under the same
 * default origin), `MCP_ORIGIN` is in `CHANNEL_SKIP` (no spurious channel
 * event), and the dirty observer watches the body fragment only.
 *
 * The repair rewrites every record through `sanitizeAnnotation` (inside
 * `collectAnnotations`) and persists the normalized shape — a silent legacy
 * migration on the recovery path, and with the post-merge call site reaching
 * DISK, broader than "on the recovery path". A "byte-identical to the
 * fallback's record" assertion would therefore be wrong; assert resolution.
 *
 * Two call sites in `documents/open.ts`: (a) inside the clone transact with
 * `skipTransact: true` (the default would re-tag with `withMcp`, the wrong
 * origin here and a nested re-tag) — persisted because `loadAndMerge` runs
 * later and reads the Y.Maps directly, origin-blind; (b) after the merge,
 * gated on `fallbackRestored`, with the DEFAULT transact — by then the
 * durable observer is attached and only a non-`DURABLE_SKIP` origin queues
 * the repaired state to disk.
 */
export function repairClonedAnchors(
  doc: Y.Doc,
  map: Y.Map<unknown>,
  filePath: string,
  opts: { skipTransact: boolean },
): void {
  refreshAllRanges(collectAnnotations(map, docHash(filePath)), doc, map, opts);
}

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
