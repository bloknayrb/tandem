/**
 * Reloading a document from disk, and the watcher that triggers it.
 *
 * Split out of `mcp/file-opener.ts` for ADR-034 Unit 7a. The reload lifecycle
 * is a self-contained loop -- watch, decide conflict-vs-reload, repopulate,
 * re-anchor -- that shared nothing with the open entries beyond living in the
 * same file.
 *
 * `reloadInProgress` travels with `reloadFromDisk` deliberately. It is the
 * per-document concurrent-reload guard, and it has two callers outside this
 * module (`restoreDocumentFromBackup` and `resolveExternalConflict`, both of
 * which turn a skip into a coded failure rather than reporting a success the
 * Y.Doc does not reflect). Leaving it behind would make this module import
 * back into `mcp/`; duplicating the Set would leave both halves green while
 * silently no longer suppressing anything.
 */

import fs from "fs/promises";
import path from "path";
import {
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_SAVED_AT_VERSION,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import { withReload } from "../../shared/origins.js";
import { toFlatOffset } from "../../shared/positions/types.js";
import { isSnapshotTruncated, snapshotSearchPrefix } from "../../shared/snapshot.js";
import type { Annotation } from "../../shared/types.js";
import { generateNotificationId } from "../../shared/utils.js";
import { docHash } from "../annotations/doc-hash.js";
import { relaySanitizationEvent } from "../annotations/migration-log.js";
import { attachObservers } from "../events/queue.js";
import { getAdapter } from "../file-io/index.js";
import { watchFile } from "../file-watcher.js";
// The one edge in this module pointing back at `mcp/` (ADR-034 residue, and
// recorded as such in the boundary inventory): annotation sanitization has not
// been split out of the MCP layer yet.
import { sanitizeAnnotation } from "../mcp/annotations.js";
import { pushNotification } from "../notifications.js";
import { anchoredRange, refreshAllRanges, validateRange } from "../positions.js";
import { getDocument, getOrCreateDocument } from "../yjs/provider.js";
import { flagExternalConflict, readPendingConflict } from "./conflict.js";
import { isDirty, markClean } from "./dirty.js";
import { writeImportLossReport } from "./populate.js";
import { getOpenDocs } from "./registry.js";

/** Per-document concurrent-reload guard -- see the module header. */
const reloadInProgress = new Set<string>();

/**
 * Is a reload holding this document's guard right now?
 *
 * `restoreDocumentFromBackup` checks this BEFORE writing the snapshot to disk:
 * `reloadFromDisk` would otherwise skip silently, leaving the Y.Doc on
 * pre-restore content while disk holds the snapshot bytes. A read-only probe,
 * so it deliberately cannot be used to acquire.
 */
export function isReloadInProgress(id: string): boolean {
  return reloadInProgress.has(id);
}

/**
 * Take the guard, or report that someone else holds it.
 *
 * Exported alongside `releaseReloadGuard` because `reloadDocumentFromMarkdown`
 * runs its own clear+repopulate transaction and must serialize against the
 * watcher path -- two of them interleaving on one Y.Doc is the failure this
 * Set exists to prevent. A named acquire/release pair rather than the Set
 * itself: a second module holding a mutable Set can desynchronize it in ways
 * no test would name.
 */
export function acquireReloadGuard(id: string): boolean {
  if (reloadInProgress.has(id)) return false;
  reloadInProgress.add(id);
  return true;
}

/** Release a guard taken with `acquireReloadGuard`. Safe to call unheld. */
export function releaseReloadGuard(id: string): void {
  reloadInProgress.delete(id);
}

/**
 * Reload document content from disk without clearing annotations.
 * Used by the file watcher when an external tool modifies the source file.
 *
 * Steps:
 * 1. Read new content from disk (async I/O outside transaction)
 * 2. Single transaction: clear awareness maps + repopulate content (NOT annotations)
 * 3. After transaction: refreshAllRanges to re-anchor annotation CRDT positions
 * 4. Second pass: textSnapshot-based relocation for still-stale annotations
 * 5. Reattach event queue observers
 *
 * Returns `true` when the reload ran, `false` when it was skipped because a
 * concurrent reload holds the per-doc guard. The file-watcher caller ignores
 * the result (the in-flight reload reads the same disk state); the
 * backup-restore caller turns a skip into RELOAD_IN_PROGRESS so it never
 * reports success while the Y.Doc still holds pre-restore content.
 */
export async function reloadFromDisk(
  id: string,
  filePath: string,
  format: string,
): Promise<boolean> {
  if (!acquireReloadGuard(id)) {
    console.error("[FileWatcher] reload already in progress for %s, skipping", id);
    return false;
  }
  try {
    console.error("[FileWatcher] reloadFromDisk: reloading %s from %s", id, filePath);

    const doc = getOrCreateDocument(id);
    // Captured RAW (not narrowed) before any async I/O, so the clear below can
    // do an identity comparison against whatever's in the map at delete-time —
    // see the comment there. Not `readPendingConflict()`: its narrowed return
    // rebuilds a fresh object every call, which would defeat the comparison.
    const rawConflictBeforeReload = doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_EXTERNAL_CONFLICT);

    // 1. Read new content outside the transaction (async I/O). Pre-parse
    //    through the adapter so we use the same code path as opens
    //    (ADR-036 + PR #707 review — single source of truth). For md/txt
    //    `parse` is essentially a no-op wrap; .docx needs the raw Buffer
    //    (a utf-8 decode would corrupt the ZIP before mammoth sees it).
    // Stat BEFORE the read: if another write lands in between, the loaded
    // content is NEWER than the recorded baseline, so the next save trips the
    // external-modification guard (safe, conservative). Stat-after-read would
    // invert that — a baseline newer than the loaded content masks the
    // interleaved write and lets a save overwrite it.
    const resolvedPath = path.resolve(filePath);
    const diskStat = await fs.stat(resolvedPath).catch(() => null);
    const fileContent =
      format === "docx"
        ? await fs.readFile(resolvedPath)
        : await fs.readFile(resolvedPath, "utf-8");
    const reloadAdapter = getAdapter(format);
    const reloadPrepared = await reloadAdapter.parse(fileContent);

    // 2. Single transaction: clear awareness + repopulate content, preserve
    //    annotations. `withReload`: channel skips, durable-sync persists, the
    //    tombstone observer records — file-watcher reload semantics.
    withReload(doc, () => {
      const awareness = doc.getMap(Y_MAP_AWARENESS);
      awareness.forEach((_, k) => awareness.delete(k));

      const userAwareness = doc.getMap(Y_MAP_USER_AWARENESS);
      userAwareness.forEach((_, k) => userAwareness.delete(k));

      // Repopulate content via adapter.apply (clears XmlFragment internally).
      // Any apply-time issues are dropped here — reload is a recovery path,
      // not a user-initiated open; surfacing inject failures via toast on
      // every file-watcher reload would be noisy. The original surface in
      // openFromDisk catches inject failures during the initial open.
      reloadAdapter.apply(doc, reloadPrepared, { fileName: path.basename(filePath) });

      // The body now mirrors the externally-written disk content. Refresh the
      // savedAt baseline to the file's mtime so the external-modification save
      // guard (stat.mtimeMs > lastSavedAt + 1000) doesn't permanently block
      // future saves against the pre-reload baseline, and clear any external-
      // conflict flag (#1069) — a completed reload IS the resolution.
      //
      // Guarded, not unconditional (review finding): steps 1's fs.stat/readFile
      // were async, so the file watcher could have flagged a NEWER conflict
      // while they were in flight. Deleting unconditionally would silently wipe
      // that newer, real conflict for content this reload never saw. Only clear
      // if the map's current raw value is still what was captured before the
      // read started.
      const meta = doc.getMap(Y_MAP_DOCUMENT_META);
      meta.set(Y_MAP_SAVED_AT_VERSION, diskStat?.mtimeMs ?? Date.now());
      if (meta.get(Y_MAP_EXTERNAL_CONFLICT) === rawConflictBeforeReload) {
        meta.delete(Y_MAP_EXTERNAL_CONFLICT);
      }
      // Refresh the import-loss half of the fidelity report (#1145): this path
      // re-imports the doc but deliberately drops `reloadPrepared.issues` for
      // toast purposes (above), so without this the persistent banner would
      // show the PRE-reload losses — a stale, lying notice. docx-only; resets
      // exportDowngrades since the re-import invalidates a prior save's set.
      writeImportLossReport(doc, reloadPrepared);
    });

    // 3. Refresh all annotation ranges in a batch transaction (sanitize legacy shapes)
    const annotationMap = doc.getMap(Y_MAP_ANNOTATIONS);
    const annotations: Annotation[] = [];
    const reloadDocHash = docHash(filePath);
    annotationMap.forEach((val) =>
      annotations.push(
        sanitizeAnnotation(val as Annotation, (event) =>
          relaySanitizationEvent(reloadDocHash, event),
        ),
      ),
    );

    if (annotations.length > 0) {
      // Merge refresh + textSnapshot relocation into a single `withReload`
      // transact so durable-sync persists the re-anchored ranges in one step.
      // Closes the two-write crash window (GH #622): a process kill between
      // the refresh and relocation passes previously left annotations stored
      // at partially refreshed ranges.
      withReload(doc, () => {
        const refreshed = refreshAllRanges(annotations, doc, annotationMap, {
          skipTransact: true,
        }).map((r) => r.annotation);

        // 4. Second pass: textSnapshot-based relocation for annotations with stale relRanges.
        for (const ann of refreshed) {
          if (!ann.textSnapshot) continue;

          // A capped snapshot is a PREFIX of the annotated text, not all of it
          // (#1486), so it can locate the range's START but says nothing about
          // its END. Both halves of that matter here:
          //
          //  - Searching with it and taking `match + snapshot.length` as the
          //    end — what this pass does for a whole snapshot — silently
          //    shrinks a long annotation to the cap on every reload, after
          //    which accept replaces only that much and the .docx apply guard,
          //    comparing the same slice, starts PASSING on the shrunken range.
          //  - Skipping the annotation entirely is no better and was this
          //    fix's first draft: `refreshAllRanges` above has already
          //    re-anchored a fresh `relRange` from the STALE flat offsets, so
          //    the record ends up durably pinned to the wrong text and every
          //    later reload resolves it cleanly and never revisits it.
          //
          // So: search on the prefix, and carry the span across unchanged. That
          // is exact whenever the annotated text moved without changing length,
          // which is the same assumption the whole-snapshot branch makes.
          const truncated = isSnapshotTruncated(ann);
          const probe = snapshotSearchPrefix(ann);
          if (probe.length === 0) continue;
          const span = ann.range.to - ann.range.from;

          // For a truncated snapshot the staleness question is "is the prefix
          // still at `from`?", so the range handed to `validateRange` is the
          // prefix's own, not the annotation's.
          const probeTo = truncated ? toFlatOffset(ann.range.from + probe.length) : ann.range.to;
          const vr = validateRange(doc, ann.range.from, probeTo, { textSnapshot: probe });

          if (vr.ok) continue; // Range is still valid

          if (vr.code === "RANGE_MOVED") {
            const resolvedTo = truncated ? toFlatOffset(vr.resolvedFrom + span) : vr.resolvedTo;
            // No snapshot argument on the truncated branch: `anchoredRange`
            // would re-validate the prefix against the FULL relocated range
            // and reject the very placement just computed.
            const relocated = truncated
              ? anchoredRange(doc, vr.resolvedFrom, resolvedTo)
              : anchoredRange(doc, vr.resolvedFrom, resolvedTo, ann.textSnapshot);
            if (relocated.ok) {
              const updated: Annotation = {
                ...ann,
                range: relocated.range,
                relRange: relocated.fullyAnchored ? relocated.relRange : undefined,
              };
              annotationMap.set(ann.id, updated);
            }
          }
          // RANGE_GONE: annotation text was deleted entirely — leave as-is
        }
      });
    }

    // 5. Reattach event queue observers (idempotent)
    attachObservers(id, doc);

    // The body now mirrors the on-disk content we just read — clear the
    // autosave dirty flag so a file-watcher reload doesn't trigger a redundant
    // write-back (#851).
    markClean(id);

    console.error("[FileWatcher] reloadFromDisk: complete for %s", id);
    return true;
  } finally {
    releaseReloadGuard(id);
  }
}

/**
 * Wire up the file watcher for a document. Calls reloadFromDisk on
 * external changes and pushes a browser notification.
 *
 * A CLEAN doc reloads from disk in every format (the binary branch in
 * reloadFromDisk reads a Buffer; comment injection is idempotent). A doc with
 * UNSAVED edits is NEVER auto-reloaded, in ANY format (#1069 for `.docx`,
 * widened in #1238): `reloadFromDisk` clears and repopulates the XmlFragment,
 * and the Y.Doc is the only copy of an unsaved edit whether that edit is bytes
 * in a ZIP or characters in Markdown. It gets an external-conflict flag the
 * client surfaces as a keep-vs-reload banner instead. Read-only docs are
 * excluded from the DIRTY check because they can never be saved
 * (`saveDocumentToDisk` refuses every source), so a SYNTHESIZED keep-vs-reload
 * prompt on one would be a dead end — a merely-dirty read-only doc reloads.
 *
 * That exclusion does NOT extend to an ALREADY-pending conflict (review
 * finding): a document closed mid-conflict carries its `dirty` + `conflict`
 * flags into its session (closeDocumentById), and a carried conflict is
 * correctly re-raised even on a read-only reopen (maybeRestoreSession) — so a
 * doc can be simultaneously read-only, dirty, AND conflict-pending. Gating
 * only on `isDirty && !readOnly` would let a FURTHER external write on that
 * doc fall into the reload branch and silently destroy the still-unresolved
 * edits — exactly the class of bug #1238 exists to prevent. So the dispatch
 * checks for a pending conflict FIRST, independent of readOnly: once flagged,
 * a conflict only ever clears via an explicit keep/reload resolution, never by
 * a readOnly reopen or a subsequent watcher tick.
 *
 * Tandem's own saves are filtered
 * out before this callback by the file-watcher's two-layer self-write defense:
 * the arrival-time `suppressNextChange` counter swallows the rename events, and
 * a delivery-time content fingerprint (`recordSelfWrite`) catches any event
 * that leaks past it (NTFS fires ~2 events per atomic rename but the counter is
 * armed once). A genuinely-changed file still reaches here — the fingerprint
 * skips only bytes identical to what Tandem just wrote. See file-watcher.ts.
 */
export function wireFileWatcher(id: string, filePath: string, format: string): void {
  try {
    watchFile(filePath, async () => {
      try {
        const doc = getDocument(id);
        if (!doc) return; // closed between arrival and delivery (or already evicted)
        const alreadyConflicted = readPendingConflict(doc) !== undefined;
        if (alreadyConflicted || (isDirty(id) && !getOpenDocs().get(id)?.readOnly)) {
          flagExternalConflict(id, doc, filePath, {
            kind: "external-edit",
            diskChanged: true,
            detectedAt: Date.now(),
          });
          return;
        }
        await reloadFromDisk(id, filePath, format);
        pushNotification({
          id: generateNotificationId(),
          type: "file-reloaded",
          severity: "info",
          message: `File changed on disk — reloaded: ${path.basename(filePath)}`,
          documentId: id,
          dedupKey: `reload:${id}`,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error("[FileWatcher] reloadFromDisk failed for %s:", filePath, err);
        pushNotification({
          id: generateNotificationId(),
          type: "general-error",
          severity: "warning",
          message: `Failed to reload ${path.basename(filePath)} from disk`,
          documentId: id,
          dedupKey: `reload-error:${id}`,
          timestamp: Date.now(),
        });
      }
    });
  } catch (err) {
    console.error("[FileWatcher] wireFileWatcher failed for %s:", filePath, err);
  }
}
