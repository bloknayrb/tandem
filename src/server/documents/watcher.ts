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
// The two edges in this module pointing back at `mcp/` (ADR-034 residue, and
// recorded as such in the boundary inventory): annotation sanitization has not
// been split out of the MCP layer yet, and `extractText` — the flat projection
// `positions.ts` itself reads from the same module — is hoisted here so the
// per-annotation relocation loop below builds the string once (#1752).
import { sanitizeAnnotation } from "../mcp/annotations.js";
import { extractText } from "../mcp/document-model.js";
import { pushNotification } from "../notifications.js";
import {
  anchoredRange,
  describeRangeFailure,
  refreshAllRanges,
  validateRange,
} from "../positions.js";
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
 * concurrent reload holds the per-doc guard. **Every caller reads it** (#1641):
 * the file-watcher and external-conflict callers suppress their success toast
 * on a skip, and the backup-restore caller turns a skip into
 * RELOAD_IN_PROGRESS so it never reports success while the Y.Doc still holds
 * pre-restore content.
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
        // Hoisted: this loop runs per annotation over a document that does not
        // change across it, so one materialization serves every `validateRange`
        // and `anchoredRange` call below (#1752).
        const text = extractText(doc);
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
          // This call is safe under #1752's new bounds ONLY because staleness
          // runs BEFORE the upper bound. An out-of-bounds or collapsed stale
          // range slices to "" — which never equals the non-empty probe — so it
          // comes back RANGE_MOVED / RANGE_GONE and gets relocated, rather than
          // INVALID_RANGE, which has no handler here. The guard that keeps a
          // point comment out of this loop is the `!ann.textSnapshot` check
          // above (its snapshot is ""), not `probe.length === 0`.
          //
          // `surrogates: "ignore"` for the same reason the relocation anchor
          // below carries it, and this call needs it MORE: `probeTo` is
          // `from + probe.length`, and `captureSnapshot` caps a snapshot at 200
          // code units (`annotations.ts`), so a cap landing between the halves
          // of a pair puts `probeTo` mid-pair. On a reload that does NOT move
          // the annotation, staleness then passes and the surrogate check fires
          // `INVALID_RANGE` — which is not `RANGE_MOVED`, so a perfectly healthy
          // annotation takes the `else` arm below and is reported as durably
          // mispinned, on every reload, forever. These are DERIVED offsets and
          // nothing here is written to a file.
          const surrogates = "ignore" as const;
          const vr = validateRange(doc, ann.range.from, probeTo, {
            textSnapshot: probe,
            surrogates,
            text,
            textTag: "watcher/relocation-probe",
          });

          if (vr.ok) continue; // Range is still valid

          if (vr.code === "RANGE_MOVED") {
            // CLAMP the carried span (#1752). `resolvedFrom + span` uses the
            // ORIGINAL span, so if the external edit deleted text INSIDE the
            // annotated region it now exceeds the new length. `resolveToElement`
            // used to clamp that away; with a real upper bound the call returns
            // INVALID_RANGE, and `refreshAllRanges` above has already minted a
            // fresh `relRange` from the STALE flat offsets — the durable mispin
            // the block comment above calls the first draft's bug.
            const resolvedTo = truncated
              ? toFlatOffset(Math.min(vr.resolvedFrom + span, text.length))
              : vr.resolvedTo;
            // No snapshot argument on the truncated branch: `anchoredRange`
            // would re-validate the prefix against the FULL relocated range
            // and reject the very placement just computed.
            //
            // `allowEmpty` because `span` can be 0: `refreshRange` may resolve a
            // relRange to newFrom === newTo (#1764) while the annotation keeps
            // its older non-empty snapshot, so it passes both guards above and
            // arrives here collapsed. `surrogates` is the SAME policy the probe
            // uses, shared from one binding rather than written twice — the
            // capped-probe rationale is identical at both ends and they went out
            // of sync once already.
            const relocOpts = {
              allowEmpty: true,
              surrogates,
              text,
              textTag: "watcher/relocation-anchor" as const,
            };
            const relocated = truncated
              ? anchoredRange(doc, vr.resolvedFrom, resolvedTo, undefined, relocOpts)
              : anchoredRange(doc, vr.resolvedFrom, resolvedTo, ann.textSnapshot, relocOpts);
            if (relocated.ok) {
              const updated: Annotation = {
                ...ann,
                range: relocated.range,
                relRange: relocated.fullyAnchored ? relocated.relRange : undefined,
              };
              annotationMap.set(ann.id, updated);
            } else {
              // Previously there was no `else` at all, so a rejected relocation
              // left the annotation durably pinned to stale offsets in silence.
              //
              // "Left at its previous offsets" would understate it: the
              // `refreshAllRanges` pass above has ALREADY minted a fresh
              // `relRange` from those stale flat offsets, so the record is now
              // durably pinned to coordinates that describe different text, every
              // later reload resolves that relRange cleanly, and nothing revisits
              // it. Same consequence as the RANGE_GONE arm below.
              console.error(
                `[watcher] Relocation rejected for annotation ${ann.id}: ` +
                  `[${vr.resolvedFrom}, ${resolvedTo}] — ${describeRangeFailure(relocated)}. ` +
                  "The annotation stays pinned to its stale coordinates and will not be revisited.",
              );
            }
          } else {
            // Everything that is not RANGE_MOVED — in practice RANGE_GONE, the
            // annotated text being nowhere in the new file. This arm was SILENT
            // while its RANGE_MOVED twin above logs, and the consequence is
            // identical: `refreshAllRanges` has already re-anchored a fresh
            // `relRange` onto the stale flat offsets, so the record is durably
            // mispinned rather than benignly "left as-is".
            console.error(
              `[watcher] Snapshot relocation failed for annotation ${ann.id}: ` +
                `[${ann.range.from}, ${probeTo}] — ${describeRangeFailure(vr)}. ` +
                "The annotation stays pinned to its stale coordinates and will not be revisited.",
            );
          }
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
