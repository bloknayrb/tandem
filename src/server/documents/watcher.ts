/**
 * Reloading a document from disk, and the watcher that triggers it.
 *
 * Split out of `mcp/file-opener.ts` for ADR-034 Unit 7a. The reload lifecycle
 * is a self-contained loop -- watch, decide conflict-vs-reload, repopulate and
 * remap the annotations (`reload-remap.ts`, #2269) -- that shared nothing with
 * the open entries beyond living in the same file.
 *
 * `reloadInProgress` travels with `reloadFromDisk` deliberately. It is the
 * per-document concurrent-reload guard, and it has two callers outside this
 * module (`restoreDocumentFromBackup` and `resolveExternalConflict`, both of
 * which turn a skip into a coded failure rather than reporting a success the
 * Y.Doc does not reflect). Duplicating the Set would leave both halves green
 * while silently no longer suppressing anything.
 *
 * Those two callers were in `mcp/` when this was written, so the original
 * reason given here was that leaving the guard behind would make this module
 * import back into `mcp/`. Unit 7c moved them to `documents/reload-family.ts`,
 * which retires that argument but NOT the decision: the guard is a published
 * acquire/release contract with named callers outside this file, and that is
 * what makes it an interface rather than an internal detail. Do not read the
 * retired argument as licence to un-export it.
 */

import fs from "fs/promises";
import path from "path";
import {
  mayHoldUnsavedWork,
  Y_MAP_AWARENESS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_SAVED_AT_VERSION,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import { withReload } from "../../shared/origins.js";
import { generateNotificationId } from "../../shared/utils.js";
import { attachObservers } from "../events/queue.js";
import { getAdapter } from "../file-io/index.js";
import { watchFile } from "../file-watcher.js";
import { pushNotification } from "../notifications.js";
import { getDocument, getOrCreateDocument } from "../yjs/provider.js";
import { flagExternalConflict, readPendingConflict } from "./conflict.js";
import { bumpContentGeneration } from "./content-generation.js";
import { isDirty, markClean } from "./dirty.js";
import { writeImportLossReport } from "./populate.js";
import { revokeOverwriteApproval } from "./read-only-file.js";
import { getOpenDocs } from "./registry.js";
import { applyRemap, captureRemapInput } from "./reload-remap.js";

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
 * 2. Single `withReload` transaction: capture every annotation's range against
 *    the old content, clear awareness maps, repopulate content (NOT
 *    annotations), then remap every annotation onto the new content
 *    (`reload-remap.ts`, #2269). Content and annotation writes land together,
 *    so durable-sync persists them in one step and no read sees a record
 *    anchored into the destroyed fragment.
 * 3. Reattach event queue observers
 *
 * Returns `true` when the reload ran, `false` when it was skipped because a
 * concurrent reload holds the per-doc guard. **Every caller reads it** (#1641):
 * the file-watcher and external-conflict callers suppress their success toast
 * on a skip (the external-conflict caller, a user's button, reports the skip
 * instead — #1663; the watcher stays silent), and the backup-restore caller
 * turns a skip into RELOAD_IN_PROGRESS so it never reports success while the
 * Y.Doc still holds pre-restore content.
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

    // 2. Single transaction: capture annotation ranges, clear awareness,
    //    repopulate content, remap annotations. `withReload`: channel skips,
    //    durable-sync persists, the tombstone observer records — file-watcher
    //    reload semantics.
    withReload(doc, () => {
      // While the OLD fragment is still live — after the swap its relRanges
      // resolve to nothing.
      const remapInput = captureRemapInput(doc, filePath);
      // #2070: a parked local-model turn that captured the old generation sees
      // the replacement through this, since the Y.Doc instance is unchanged.
      bumpContentGeneration(doc);

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

      // Its own catch: the content has landed, so a remap failure must not fail
      // the reload. The records then keep dead relRanges, which `refreshRange`
      // strips and reports `degraded`.
      try {
        applyRemap(doc, remapInput);
      } catch (err) {
        console.error("[FileWatcher] reloadFromDisk: annotation remap failed for %s:", id, err);
      }
    });

    // 3. Reattach event queue observers (idempotent)
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
 * client surfaces as a keep-vs-reload banner instead. EXPLICITLY read-only docs
 * are excluded from the DIRTY check — the user asked not to touch them, so a
 * merely-dirty one reloads.
 *
 * Since #1798 the check is `mayHoldUnsavedWork`, not `!readOnly`. "Can never be
 * saved" used to be the stated reason for the exclusion and is now the reason
 * AGAINST it for one tier: an `.html` opens read-only precisely because no save
 * path exists, which makes its dirty Y.Doc the only copy of those edits. That
 * tier gets the banner. Reloading over it would destroy the edits silently,
 * which is the class of bug #1238 exists to prevent.
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
 * the arrival-time `suppressNextChange` counter swallows the first N events,
 * and a delivery-time content fingerprint (`recordSelfWrite`) catches any that
 * leak past it. Two corrections to what this comment used to claim (#1749).
 * The counter does not swallow "the rename events" on the POSIX path at all:
 * `rearmWatch` CLEARS it after every self-write, because the write replaced the
 * inode and the old handle never saw its own events — so on POSIX the
 * fingerprint is the only layer between a self-write echo and a reload. And
 * NTFS does not fire "~2 change events per atomic rename": measured on Node 24,
 * a `fs.promises` self-write delivers `rename, rename, change` and a
 * synchronous temp write `rename, rename` — never a lone `change`. A
 * genuinely-changed file still reaches here — the fingerprint skips only bytes
 * identical to what Tandem just wrote. See file-watcher.ts.
 *
 * A failed INITIAL arm is no longer swallowed by the catch below: `watchFile`
 * does not throw, and notifies the user itself when `fs.watch` refuses the
 * path. That matters most for save-as, whose target is deliberately unconfined
 * (network shares, external drives) — exactly where `fs.watch` is unsupported
 * or returns EPERM/ENOSPC/EMFILE — and nothing re-arms after an open, so a
 * silent failure there is permanent for the document's lifetime. The catch
 * below covers the rest of this body.
 */
export function wireFileWatcher(id: string, filePath: string, format: string): void {
  try {
    watchFile(filePath, async () => {
      try {
        const doc = getDocument(id);
        if (!doc) return; // closed between arrival and delivery (or already evicted)
        // Self-writes are filtered before this callback, so this is another
        // program's change: an Overwrite approval no longer covers the file.
        revokeOverwriteApproval(id);
        const alreadyConflicted = readPendingConflict(doc) !== undefined;
        // An unregistered id keeps the old `!undefined` answer: flag rather than
        // reload, the non-destructive direction when we cannot tell the tier.
        const openDoc = getOpenDocs().get(id);
        if (
          alreadyConflicted ||
          (isDirty(id) && (openDoc === undefined || mayHoldUnsavedWork(openDoc)))
        ) {
          flagExternalConflict(id, doc, filePath, {
            kind: "external-edit",
            diskChanged: true,
            detectedAt: Date.now(),
          });
          return;
        }
        // #1641: the return value is the claim's warrant. `reloadFromDisk`
        // yields false when a concurrent reload holds the guard, and this
        // callback used to discard that and toast anyway — telling the user a
        // reload happened for a pass that did nothing, sometimes while the
        // in-flight reload was still mid-transaction. Both callers of
        // `reloadFromDisk` in `documents/reload-family.ts` already gated on this value;
        // this was the only one that did not.
        //
        // What suppression costs, stated precisely rather than as "nothing",
        // because the guard has FOUR holders and they do not all toast:
        // a sibling watcher pass and `resolveExternalConflict` push their own
        // reload toast, so the user still hears about it; `restoreDocumentFromBackup`
        // pushes a restore toast that never mentions the external edit; and
        // `reloadDocumentFromMarkdown` (which takes the guard directly, across
        // a clear+repopulate and a disk save) pushes no reload toast at all.
        // In that last window a genuine third-party write is dropped with no
        // signal. The staleness itself is pre-existing — master skipped the
        // reload too and merely lied about it — and the save guard still
        // catches the consequence, since the reload records the PRE-write
        // mtime as the baseline. Only the false claim is gone.
        if (!(await reloadFromDisk(id, filePath, format))) return;
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
