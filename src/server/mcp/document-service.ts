import { randomUUID } from "node:crypto";
import fs from "fs/promises";
import path from "path";
import type * as Y from "yjs";
import {
  AUTO_SAVE_FORMATS,
  BINARY_SAVE_FORMATS,
  CTRL_ROOM,
  Y_MAP_ACTIVE_DOCUMENT_EPOCH,
  Y_MAP_ACTIVE_DOCUMENT_ID,
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_FIDELITY_REPORT,
  Y_MAP_OPEN_DOCUMENTS,
  Y_MAP_SAVED_AT_VERSION,
  Y_MAP_STORE_READ_ONLY,
} from "../../shared/constants.js";
import { withFileSync, withInternal, withMcp } from "../../shared/origins.js";
import { isPlaintextFormat } from "../../shared/plaintext-format.js";
import type { FidelityReport } from "../../shared/types.js";
import { generateNotificationId } from "../../shared/utils.js";
import { rejectUnsafeWindowsPrefix } from "../../shared/windows-path-safety.js";
import { docHash } from "../annotations/doc-hash.js";
import { closeStore, createStore } from "../annotations/store.js";
import {
  mergeEnvelopeForward,
  migrateTombstoneLedger,
  persistSnapshot,
} from "../annotations/sync.js";
import { wireAnnotationStore } from "../documents/annotation-wiring.js";
import { readPendingConflict } from "../documents/conflict.js";
import {
  clearDirtyState,
  isDirty,
  markClean,
  markCleanIfUnchanged,
  snapshotDirtyVersion,
} from "../documents/dirty.js";
import { openFromRestore } from "../documents/open.js";
import { wireFileWatcher } from "../documents/watcher.js";
import { notifyDocumentPromoted } from "../events/observers/ctrl-meta.js";
import { attachObservers, clearFileSyncContext } from "../events/queue.js";
import { snapshotBeforeFirstWrite } from "../file-io/doc-backup.js";
import { commentExportDowngrades, prepareExportComments } from "../file-io/docx-comment-export.js";
import { detectExportFidelityIssues } from "../file-io/docx-export.js";
import {
  type BlockReason,
  blockReasonMessage,
  integrityWarningLines,
  verifyDocxRoundtrips,
} from "../file-io/docx-verify.js";
import { validateRenameFilename } from "../file-io/filename-safety.js";
import { atomicWrite, atomicWriteBuffer, getAdapter } from "../file-io/index.js";
import { flattenPlaintextBreaks } from "../file-io/plaintext-flatten.js";
import { rearmWatch, recordSelfWrite, suppressNextChange, unwatchFile } from "../file-watcher.js";
import { assertPathSafe } from "../integrations/apply.js";
import { pushNotification } from "../notifications.js";
import { resolveAppDataDir } from "../platform.js";
import {
  deleteSession,
  listSessionFilePaths,
  loadCtrlSession,
  narrowConflict,
  restoreCtrlDoc,
  saveCtrlSession,
  saveSession,
  stopAutoSave,
} from "../session/manager.js";
import { getOrCreateDocument } from "../yjs/provider.js";

// --- Multi-document state (ADR-033: moved to src/server/documents/registry.ts) ---
//
// The openDocs map, activeDocId state, and keep-alive predicate registration
// now live in the registry module. This file re-exports them so existing
// consumers (29 callsites at time of split) keep working without changes.
// Save / auto-save / broadcast / session-restore concerns stay here for now.

import {
  activateDocument,
  closeDocument,
  docCount,
  getActiveDocId,
  getOpenDocs,
  updateDocumentWhenReady,
} from "../documents/registry.js";

export {
  activateDocument,
  broadcastOpenDocs,
  closeDocument,
  docCount,
  getActiveDocEpoch,
  getActiveDocId,
  getCurrentDoc,
  getOpenDocs,
  hasDoc,
  type OpenDoc,
  openDocument,
  openDocumentWhenReady,
  requireDocument,
  toDocListEntry,
  updateDocumentWhenReady,
} from "../documents/registry.js";

/** Internal alias for the registry's view of open docs — used by closures below. */
const openDocs = getOpenDocs();

/**
 * Non-throwing existence probe (fs.access has no boolean variant).
 *
 * Safe FS sink (CodeQL js/path-injection): the sole caller is renameDocument,
 * which passes `newPath` only AFTER it has cleared validateRenameFilename, the
 * inline separator/null-byte guard, rejectUnsafeWindowsPrefix, and the
 * assertPathSafe realpath/symlink walk. CodeQL cannot trace those barriers
 * across the function boundary, so a path-injection alert here is a false
 * positive — see issue #1042 for the Security-tab dismissal rationale.
 */
const pathExists = (p: string): Promise<boolean> =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);

// --- Disk save ---

/** Per-document save lock to prevent concurrent auto-save + manual save races. */
const savingDocs = new Set<string>();

/**
 * True when the format has ANY path back to disk — auto-save or explicit.
 *
 * `.html` has neither (`saveDocumentToDisk` rejects it outright), which makes
 * it the one format where "keep my edits" is not a promise the app can keep.
 * Callers use this to avoid offering, or reporting, a save that cannot happen
 * (#1238).
 */
export function canSaveToDisk(format: string): boolean {
  return AUTO_SAVE_FORMATS.has(format) || BINARY_SAVE_FORMATS.has(format);
}

/**
 * `SaveResult.reason` for a save blocked by an unresolved external conflict
 * (#1238). `errorCode` is only meaningful for `status: "error"`, so on the
 * skipped path the reason string is the only handle callers have to tell this
 * skip from the half-dozen others — a shared constant rather than a literal
 * matched in two places.
 */
export const EXTERNAL_CONFLICT_SKIP_REASON = "External conflict pending";

/** The persisted fidelity report, defensively typed: it is server-written but
 * survives session restore un-revalidated, so every read tolerates a legacy or
 * malformed value rather than throwing inside a save. */
function fidelityReportOf(doc: Y.Doc): FidelityReport | undefined {
  return doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_FIDELITY_REPORT) as FidelityReport | undefined;
}

/**
 * How many STRUCTURAL import losses a report carries (#1142 G3) — content or
 * page furniture that is gone, not mammoth's style-level tail. This is what the
 * save-time overwrite warning gates on; see the field's note in
 * `shared/types.ts` for why the broader count would make it ambient. Takes the
 * report rather than the doc so a caller can read it ONCE and use the same
 * snapshot for what it returns and what it persists.
 */
function structuralLossesOf(report: FidelityReport | undefined): number {
  const value = report?.structuralLosses;
  return typeof value === "number" && value > 0 ? value : 0;
}

export interface SaveResult {
  status: "saved" | "skipped" | "error";
  reason?: string;
  /**
   * Machine-readable discriminator for a `skipped` result (#1238). `reason` is
   * human-facing prose and must stay free to change, so a caller that needs to
   * present an honest result without branching on mutable prose. Every skipped
   * path sets a code; `reason` remains useful for logs and older clients.
   */
  skipCode?:
    | "NOT_OPEN"
    | "PROMOTION_REQUIRED"
    | "READ_ONLY"
    | "EXPLICIT_ONLY"
    | "UNSUPPORTED_FORMAT"
    | "ADAPTER_UNAVAILABLE"
    | "SAVE_IN_PROGRESS"
    | "EXTERNAL_CONFLICT"
    | "FILE_MODIFIED"
    | "SOURCE_MISSING"
    | "FILE_STATE_UNAVAILABLE";
  errorCode?: string;
  /**
   * Body-export fidelity warnings (#576, `.docx` only) — content the export
   * downgraded (unsupported blocks, non-embedded images). Present on a
   * successful binary save so the caller can surface a post-save notice. The
   * lossy-mammoth-import ceiling is surfaced separately at open time.
   */
  fidelityWarnings?: string[];
  /**
   * Post-write verification advisories (#1123 Phase 0e, `.docx` only) — content
   * the save may have lost UNEXPECTEDLY (a comment/footnote that didn't survive
   * a verify reimport, a soft text-retention shortfall). Distinct from
   * `fidelityWarnings`: a louder, warning-level signal with a restore prompt,
   * never folded into the "N features simplified" count. Content-free strings.
   * A `blocked` verdict instead aborts the save (status:"error").
   */
  integrityWarnings?: string[];
  /**
   * How many KINDS of Word feature the import couldn't bring in (#1142 G3,
   * `.docx` only) — `FidelityReport.structuralLosses`, i.e. the count of report
   * lines describing content or page furniture that is GONE. `undefined` when
   * there are none.
   *
   * Deliberately NOT `importLosses.length`: that includes mammoth's style-level
   * tail, which nearly every real `.docx` trips, so gating on it would make the
   * overwrite warning ambient. It also excludes the "couldn't check" line —
   * that is not an existence claim.
   *
   * A CATEGORY count, and the user-facing copy must not present it as a feature
   * count: each line carries its own number, so a document losing 40 tracked
   * deletions and 3 headers reports 2, not 43. It answers "is there anything to
   * tell the user at the moment of overwrite?", not "how much". The persistent
   * notice carries the real numbers.
   */
  unpreservedImports?: number;
}

/**
 * Thrown by the binary save branch when post-write verification (#1123 0e)
 * BLOCKS — the regenerated .docx didn't round-trip the live content. Carries a
 * `code` so the catch surfaces it as a save-error with a stable error code
 * (never an FS errno). The message is content-free (`blockReasonMessage`).
 */
class SaveVerificationError extends Error {
  readonly code = "VERIFY_BLOCKED";
  constructor(
    message: string,
    readonly reason: BlockReason,
  ) {
    super(message);
    this.name = "SaveVerificationError";
  }
}

/**
 * Save a document to disk. Shared by tandem_save, POST /api/save, and auto-save.
 *
 * Guards:
 * - Text formats (.md/.txt) via `adapter.save` + `atomicWrite` (auto-saveable).
 * - Binary formats (.docx) via `adapter.saveBinary` + `atomicWriteBuffer` —
 *   EXPLICIT save only (`source !== "auto-save"`); see `BINARY_SAVE_FORMATS`.
 * - Not upload://
 * - An unresolved external conflict blocks the save outright (#1238)
 * - Checks source file mtime to skip if externally modified
 * - Per-document lock prevents concurrent writes
 */
export async function saveDocumentToDisk(
  docId: string,
  source: "auto-save" | "manual" | "mcp" = "auto-save",
): Promise<SaveResult> {
  // path.basename eliminates directory components so CodeQL does not trace
  // user input through Map.get(id) to docState.filePath FS sinks
  // (js/path-injection). Valid IDs are 64-char hex / upload_* — no separators,
  // so this is a no-op at runtime.
  const safeDocId = path.basename(docId);
  const docState = openDocs.get(safeDocId);
  if (!docState) {
    return { status: "skipped", reason: "Document not open", skipCode: "NOT_OPEN" };
  }

  // Exclude non-saveable documents
  if (docState.source === "upload") {
    return {
      status: "skipped",
      reason: "Upload-only document",
      skipCode: "PROMOTION_REQUIRED",
    };
  }

  const isBinary = BINARY_SAVE_FORMATS.has(docState.format);

  // Read-only blocks every save path. The read-only signal is the user's
  // intent and dominates the format/source distinction: a read-only .docx is
  // never overwritten, whether the trigger is auto-save or an explicit save.
  // A writable .docx falls through to the binary branch below.
  if (docState.readOnly) {
    return { status: "skipped", reason: "Read-only document", skipCode: "READ_ONLY" };
  }

  // Binary formats (.docx) write back only on an EXPLICIT user/agent save. The
  // auto-save timer must never overwrite the original with a re-export of a
  // lossy mammoth import.
  if (isBinary && source === "auto-save") {
    return {
      status: "skipped",
      reason: "Binary formats save only on explicit save",
      skipCode: "EXPLICIT_ONLY",
    };
  }

  if (!isBinary && !AUTO_SAVE_FORMATS.has(docState.format)) {
    return {
      status: "skipped",
      reason: `Format '${docState.format}' not eligible for disk save`,
      skipCode: "UNSUPPORTED_FORMAT",
    };
  }

  const adapter = getAdapter(docState.format);
  if (isBinary ? !adapter.saveBinary : !adapter.save) {
    return {
      status: "skipped",
      reason: "Adapter cannot save",
      skipCode: "ADAPTER_UNAVAILABLE",
    };
  }

  // Per-document lock
  if (savingDocs.has(docId)) {
    return {
      status: "skipped",
      reason: "Save already in progress",
      skipCode: "SAVE_IN_PROGRESS",
    };
  }

  savingDocs.add(docId);
  try {
    // An unresolved external conflict blocks every writer whose disk copy has
    // actually diverged, whatever the mtime heuristic below concludes (#1238).
    // That heuristic compares against a Date.now() stamp with a 1-second
    // tolerance, is re-baselined by rename, and — after a restart — is
    // re-baselined by initSavedBaseline to the EXTERNAL write's own mtime, so
    // it can silently pass while a keep-vs-reload banner is still up.
    //
    // `diskChanged` is the discriminator, not `source` alone: an
    // "external-edit" conflict is always diskChanged, so this blocks Ctrl+S and
    // tandem_save too. Neither is a resolution when the disk holds changes the
    // user has not chosen to discard, and Claude has no surface that would even
    // tell it a conflict is pending. An "unsaved-restore" over an UNCHANGED
    // disk is the one case where an explicit save is unambiguous intent, and it
    // stays permitted — which is exactly the pre-#1238 `.docx` behaviour.
    //
    // Skipping here also leaves `snapshotBeforeFirstWrite`'s once-per-run gate
    // unconsumed, so when the user later picks "keep" and saves, the
    // pre-overwrite snapshot captures the EXTERNAL version — the copy actually
    // at risk.
    // Captured RAW (not narrowed) so the post-write clear below can do an
    // identity comparison — see the comment at the delete site. Deliberately
    // NOT `readPendingConflict()`'s narrowed return: `narrowConflict` builds a
    // fresh object on every call (even for an unchanged raw value, via its
    // Date.now() fallback for a malformed `detectedAt`), so comparing two
    // narrowed reads would spuriously look like a change on every call.
    const conflictMetaBeforeSave = getOrCreateDocument(docId).getMap(Y_MAP_DOCUMENT_META);
    const rawConflictBeforeSave = conflictMetaBeforeSave.get(Y_MAP_EXTERNAL_CONFLICT);
    const pendingConflict = narrowConflict(rawConflictBeforeSave);
    if (pendingConflict && (source === "auto-save" || pendingConflict.diskChanged)) {
      return {
        status: "skipped",
        reason: EXTERNAL_CONFLICT_SKIP_REASON,
        skipCode: "EXTERNAL_CONFLICT",
      };
    }

    // Guard against overwriting external modifications.
    // Safe FS sink (CodeQL js/path-injection): `docState.filePath` is the
    // registry's server-managed path (only ever set by openFromDisk /
    // resolveAndValidatePath / a validated rename or save-as / an upload) —
    // never raw user input. `openFromUpload` is the fourth
    // setter and the one this enumeration used to omit: it registers a
    // synthetic `upload://<uuid>/<name>` whose only caller-controlled
    // segment is reduced by `crossBasename` before it is joined, and
    // `isUploadPath` diverts that path from every fs sink anyway.
    // An alert here is a false positive; dismiss per issue #1042.
    try {
      const stat = await fs.stat(docState.filePath);
      // Compare to the session's mtime — if the file changed externally, skip
      // We use a 1-second tolerance because fs.watch debounce + atomic rename
      // can cause minor mtime drift
      const meta = getOrCreateDocument(docId).getMap(Y_MAP_DOCUMENT_META);
      const lastSavedAt = meta.get(Y_MAP_SAVED_AT_VERSION) as number | undefined;
      // If the file is newer than our last save, someone else modified it
      if (lastSavedAt && stat.mtimeMs > lastSavedAt + 1000) {
        return {
          status: "skipped",
          reason: "File modified externally",
          skipCode: "FILE_MODIFIED",
        };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          status: "skipped",
          reason: "Source file no longer exists",
          skipCode: "SOURCE_MISSING",
        };
      }
      console.error("[AutoSave] Unexpected stat error for %s:", docState.filePath, err);
      return {
        status: "skipped",
        reason: `Cannot verify file state: ${code}`,
        skipCode: "FILE_STATE_UNAVAILABLE",
      };
    }

    const doc = getOrCreateDocument(docId);
    // Snapshot the dirty version BEFORE the async write so a content edit that
    // lands DURING the write isn't lost — markCleanIfUnchanged only clears the
    // flag if no newer edit arrived (#851).
    const dirtySnapshot = snapshotDirtyVersion(docId);

    let fidelityWarnings: string[] | undefined;
    let integrityWarnings: string[] | undefined;
    let exportDowngrades: string[] = [];
    let unpreservedImports: number | undefined;
    let importSnapshot: FidelityReport | undefined;
    if (isBinary) {
      // Binary branch (#576, .docx). Capture fidelity warnings against the same
      // Y.Doc snapshot we serialize, then write the ZIP via atomicWriteBuffer
      // (atomicWrite's UTF-8 encoding would corrupt the binary).
      const warnings = detectExportFidelityIssues(doc);
      // Comment-side fidelity (#1142 G3): flattened reply threads and comments
      // whose ranges no longer resolve. Computed from ONE `prepareExportComments`
      // pass, and this pass must stay immediately adjacent to the `saveBinary`
      // below — `exportYDocToDocx` re-derives the identical set from the same
      // unmutated doc as its first statement, so with no `await` between these
      // two lines the counts describe exactly the bytes written. DO NOT insert
      // an awaited call here: a Hocuspocus update landing in the gap would make
      // the report describe a document that was never saved. Pinned by a test
      // that compares the reported reply count against the produced buffer.
      const skipped = { unresolved: 0, malformed: 0 };
      const exportComments = prepareExportComments(doc, (reason) => {
        if (reason === "malformed") skipped.malformed++;
        else skipped.unresolved++;
      });
      const commentFidelity = commentExportDowngrades(exportComments, skipped);
      // Snapshot the WHOLE import half HERE, before the write, and use this one
      // snapshot for both the returned count and the persisted report. The
      // `withMcp` block runs after five awaits, and Y_MAP_FIDELITY_REPORT has a
      // second writer (`writeImportLossReport`, on the force-reload and
      // file-watcher-reload paths). Re-reading it down there could pair a NEWER
      // import's loss list with this save's downgrades, and would let the
      // persisted `structuralLosses` disagree with the count already delivered
      // to the toast and to Claude.
      importSnapshot = fidelityReportOf(doc);
      unpreservedImports = structuralLossesOf(importSnapshot) || undefined;
      const buffer = await adapter.saveBinary!(doc);
      // Pre-overwrite snapshot of the on-disk original (first write per path per
      // run), mirroring the text branch below. .docx is the highest-stakes case:
      // a regenerated export can drop features mammoth never imported (footnotes,
      // headers/footers, custom styles), so the verbatim on-disk bytes are the
      // user's only recovery. snapshotBeforeFirstWrite is format-agnostic (raw
      // byte copy) and never throws — a snapshot failure must not block the save.
      await snapshotBeforeFirstWrite(docState.filePath, {
        appDataDir: resolveAppDataDir(),
        documentId: docId,
      });
      // Post-write verification (#1123 Phase 0e): re-import the produced bytes
      // and confirm they round-trip the live doc's CONTENT before overwriting.
      // Runs AFTER the snapshot (so the original is recoverable) and BEFORE the
      // write/suppressor (so a blocking verdict aborts with the file untouched
      // and the watcher suppressor un-armed). Never throws — a `blocked` verdict
      // is a returned value we escalate to a save-error here.
      const verdict = await verifyDocxRoundtrips(buffer, doc, { docId: safeDocId }, exportComments);
      if (verdict.kind === "blocked") {
        throw new SaveVerificationError(blockReasonMessage(verdict.reason), verdict.reason);
      }
      // The inner try/finally is what makes the re-arm unconditional (#1749).
      // Without it a throw from `atomicWriteBuffer` skips both
      // `recordSelfWrite` and `rearmWatch`, leaving the arrival counter armed
      // for 2 s on a live POSIX watcher — and the next EXTERNAL atomic save,
      // which on POSIX arrives as `rename`, is swallowed at arrival. It is
      // deliberately NOT the function-level `finally` that releases
      // `savingDocs`: that one runs after `saveSession` and also covers the
      // conflict skip-return and the mtime guard, paths with no write at all.
      try {
        suppressNextChange(docState.filePath);
        await atomicWriteBuffer(docState.filePath, buffer);
        recordSelfWrite(docState.filePath, buffer);
      } finally {
        rearmWatch(docState.filePath);
      }
      // `fidelityWarnings` drives the save toast; `exportDowngrades` is the
      // persistent notice. They differ by exactly the flattened-reply line,
      // which is deliberately persistent-only: imported Word reply threads
      // round-trip by design (#1000), so nearly every reviewed .docx has them,
      // and the reply TEXT is still written — a per-save toast for a non-loss
      // would be the same fatigue we refuse to add a third toast for.
      fidelityWarnings = warnings.length > 0 ? warnings : undefined;
      exportDowngrades = [...warnings, ...commentFidelity.downgrades];
      const advisories = [...integrityWarningLines(verdict), ...commentFidelity.integrity];
      integrityWarnings = advisories.length > 0 ? advisories : undefined;
    } else {
      const output = adapter.save!(doc);
      // Pre-overwrite snapshot of the on-disk original (first write per path
      // per run). Never throws; a snapshot failure must not block the save.
      await snapshotBeforeFirstWrite(docState.filePath, {
        appDataDir: resolveAppDataDir(),
        documentId: docId,
      });
      // Inner try/finally per branch — see the binary arm above for why. One
      // `try` around the whole `if` would not do: the re-arm has to sit
      // immediately after the write it belongs to.
      try {
        suppressNextChange(docState.filePath);
        await atomicWrite(docState.filePath, output);
        recordSelfWrite(docState.filePath, output);
      } finally {
        rearmWatch(docState.filePath);
      }
    }
    // Mark document clean
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    withMcp(doc, () => {
      meta.set(Y_MAP_SAVED_AT_VERSION, Date.now());
      // A successful save wrote the in-memory edits to disk — any pending
      // external-conflict flag (#1069) is resolved. No-op when absent.
      //
      // Guarded, not unconditional (review finding): the write above was async
      // (fs.stat + atomicWrite), so a NEW external edit could have been flagged
      // by the file watcher while it was in flight. Deleting unconditionally
      // would silently wipe that newer, real conflict. Reference-compare the
      // CURRENT raw map value against what was captured before the write
      // started; only clear if nothing wrote a different value in between.
      if (meta.get(Y_MAP_EXTERNAL_CONFLICT) === rawConflictBeforeSave) {
        meta.delete(Y_MAP_EXTERNAL_CONFLICT);
      }
      // Refresh the export-downgrade half of the fidelity report (#1145, 0c),
      // preserving the import-loss half set at open. docx-only — only the
      // binary branch computes fidelityWarnings; `?? []` clears a prior save's
      // downgrades on a now-clean save. Whole-object replacement is safe: the
      // value is opaque (no field-level CRDT merge) and all writers are
      // server-side + serialized, so this read-modify-write can't interleave.
      if (isBinary) {
        meta.set(Y_MAP_FIDELITY_REPORT, {
          importLosses: importSnapshot?.importLosses ?? [],
          structuralLosses: structuralLossesOf(importSnapshot),
          exportDowngrades,
          // Post-write verify advisories (#1123 0e) — louder than downgrades;
          // `?? []` clears a prior save's advisory on a now-clean save.
          integrityWarnings: integrityWarnings ?? [],
          updatedAt: Date.now(),
        } satisfies FidelityReport);
      }
    });
    markCleanIfUnchanged(docId, dirtySnapshot);

    // Session write LAST, and in its own try/catch (#1750). The
    // `SAVED_AT_VERSION` stamp above is a claim about the disk, and the disk
    // write has already succeeded — so a `saveSession` throw (an
    // ENAMETOOLONG-length key was the reported instance) must not leave the
    // stamp unset and the document dirty, with the bytes on disk, the UI saying
    // unsaved, autosave retrying forever and the suppression counter already
    // consumed by a write whose stamp never landed.
    //
    // `dirty` is unchanged by the move: its argument is a snapshot comparison,
    // and `markCleanIfUnchanged` writes only `savedVersion`. `conflict` is
    // NEWLY passed, and the reorder is exactly what makes it correct — this now
    // runs AFTER the guarded flag delete above, so it can no longer persist a
    // conflict the save just resolved. What it DOES persist is a conflict that
    // landed mid-write (the guarded delete did not fire), which was previously
    // dropped across a restart.
    const carriedConflict = readPendingConflict(doc);
    try {
      await saveSession(docState.filePath, docState.format, doc, {
        dirty: snapshotDirtyVersion(docId) !== dirtySnapshot,
        conflict: carriedConflict,
      });
    } catch (err) {
      console.error("[Save] saveSession failed for", docState.filePath, err);
      // Delete the stale record, then SAY SO. Both halves are load-bearing and
      // neither is optional; this used to be the delete alone, which returned
      // `{status:"saved"}` and told nobody.
      //
      // Delete, because the record on disk is the PREVIOUS tick's. It can be
      // `dirty: true`, and `maybeRestoreSession` restores a dirty session
      // regardless of `sourceFileChanged` — so keeping it would restore stale
      // content over the bytes this save just wrote correctly, and raise a
      // keep-vs-reload banner on a file already in sync.
      //
      // Keeping it would not rescue the conflict either, which is the thing
      // worth rescuing: the conflict we failed to persist is the LIVE one in
      // this Y.Doc, and the older record carries whatever was true a tick ago.
      // So NO choice available here recovers the conflict record across a
      // restart — and that is exactly why the notification is not a nicety.
      // The banner is still up in this process; what is gone is its durability.
      await deleteSession(docState.filePath).catch((delErr) => {
        // Reachable, narrowly: `deleteSession` catches per unlink and cannot
        // reject on an unlink, but it derives both names first, and
        // `legacySessionKey`'s `encodeURIComponent` throws `URIError` on a lone
        // surrogate — one of the shapes that makes `saveSession` throw in the
        // first place, so this is precisely the path that reaches it.
        console.error("[Save] deleteSession after failed saveSession:", delErr);
      });
      pushNotification({
        id: generateNotificationId(),
        type: "general-error",
        severity: carriedConflict ? "error" : "warning",
        message: carriedConflict
          ? `Saved ${path.basename(docState.filePath)}, but Tandem could not record its recovery state. An unresolved external-edit conflict on this file will be lost if Tandem restarts before you resolve it.`
          : `Saved ${path.basename(docState.filePath)}, but Tandem could not record its recovery state; unsaved-work tracking for this file will not survive a restart.`,
        errorCode: (err as NodeJS.ErrnoException).code ?? "UNKNOWN",
        documentId: docId,
        dedupKey: `session-save-failed:${docId}`,
        timestamp: Date.now(),
      });
    }

    return { status: "saved", fidelityWarnings, integrityWarnings, unpreservedImports };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errCode = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    pushNotification({
      id: generateNotificationId(),
      type: "save-error",
      severity: "error",
      message: `Save failed for ${path.basename(docState.filePath)}: ${msg}`,
      toolName: source,
      errorCode: errCode,
      documentId: docId,
      dedupKey: `${source}:${docId}`,
      timestamp: Date.now(),
    });
    return { status: "error", reason: msg, errorCode: (err as NodeJS.ErrnoException).code };
  } finally {
    savingDocs.delete(docId);
  }
}

/**
 * Persist the dirty/conflict session carry after a `saveDocumentToDisk` call
 * returns `status: "skipped"` (#1238). The disk save did NOT happen, so
 * without this a skipped save would write (or leave) a clean-looking session
 * that a restart then discards — losing the only copy of unsaved edits, or
 * silently laundering away a pending keep-vs-reload conflict the user still
 * has to decide. Shared by `tandem_save` (document.ts) and `POST /api/save`
 * (routes/save.ts) so both skip paths carry the same state; previously only
 * the MCP tool did this, leaving the browser save route's skip path unguarded.
 *
 * A no-op if `docId` isn't open — callers that already validated the doc
 * exists (both current call sites do) never hit that branch, but a stale ID
 * slipping through must not throw.
 */
export async function persistSkippedSaveSession(docId: string): Promise<void> {
  const docState = openDocs.get(docId);
  if (!docState) return;
  const doc = getOrCreateDocument(docId);
  await saveSession(docState.filePath, docState.format, doc, {
    dirty: isDirty(docId),
    conflict: readPendingConflict(doc),
  });
}

/** Allowed formats for save-as. Mirrors AUTO_SAVE_FORMATS. */
const SAVE_AS_FORMATS = new Set(["md", "txt"]);

export interface SaveAsResult {
  status: "saved" | "error";
  /** When status === "saved", the on-disk path that was written + promoted. */
  targetPath?: string;
  /** When status === "saved", the new fileName the tab will display. */
  fileName?: string;
  /** When status === "saved", the format the doc was promoted to. */
  format?: string;
  reason?: string;
  errorCode?: string;
}

/**
 * Save the in-memory document content of `docId` to `targetPath` and PROMOTE
 * the document in place: switch `OpenDoc.source` from `"upload"` to `"file"`,
 * point `filePath` at the new path, and update Y_MAP_DOCUMENT_META so clients
 * see the new tab title.
 *
 * Critically, we keep the same `documentId` (Hocuspocus room name). Changing
 * it would orphan every connected client (see CLAUDE.md "Stale browser tabs
 * merge old CRDT state back" / Y.js gotchas). The room keeps its
 * `upload://scratchpad/<uuid>/...` ID; from auto-save's point of view the
 * doc now looks like a `source === "file"` doc with a real `filePath`, so
 * the 60s timer will round-trip it through `atomicWrite` going forward.
 *
 * Path safety: Save-As is a USER-DRIVEN flow — the path comes from the
 * native Save dialog, so the user explicitly chose where to write
 * (external drives, network mounts, project dirs outside $HOME are all
 * legitimate). We therefore do NOT confine the target to the home/tmp
 * roots. We DO still reject:
 *  - symlinked path components (a planted symlink could redirect the write
 *    to a protected file). `assertPathSafe()` runs its full realpath/
 *    symlink walk; we widen only its allowed-roots confinement by passing
 *    the resolved path's own filesystem root, so any absolute path passes
 *    the root check while the symlink rejection stays intact.
 *  - UNC paths on Windows (NTLM-relay attack surface — see the explicit
 *    guard below).
 *
 * Bypasses two guards that normal `saveDocumentToDisk` enforces:
 *  - upload-only short-circuit (the whole point is to write an upload doc out)
 *  - external-mtime check (the target file does not exist yet)
 *
 * Wires a file watcher for the new path AFTER the write (#1749). It used to
 * skip that as "an intentional v1 limitation", which meant an external edit to
 * a just-saved-as document was invisible until the next reopen. It has to come
 * after the write because `fs.watch` on a path that does not exist yet throws
 * ENOENT — and both `watchFile` and `wireFileWatcher` swallow it, so getting
 * the order wrong fails silently.
 */
export async function saveDocumentAsToDisk(
  docId: string,
  targetPath: string,
  format: "md" | "txt",
): Promise<SaveAsResult> {
  const docState = openDocs.get(docId);
  if (!docState) return { status: "error", reason: "Document not open", errorCode: "NOT_FOUND" };
  if (docState.readOnly) {
    return { status: "error", reason: "Read-only document", errorCode: "READ_ONLY" };
  }
  // Save-As is a PROMOTION path: it only makes sense for ephemeral upload/
  // scratchpad docs (no durable annotation store, no real session, no
  // file-watch). Running it on an already-on-disk doc (`source: "file"`)
  // would silently destroy data: re-keying the durable annotation store to
  // the new path's docHash WITHOUT migrating the original's annotations
  // (they vanish), `deleteSession(oldPath)` deleting the REAL file's session,
  // and `notifyDocumentPromoted` being a no-op (Claude's channel stays stale).
  // Gate it to uploads so a misdirected client call (or future affordance
  // regression) can't trash a real file. See #827 review (Medium).
  if (docState.source !== "upload") {
    return {
      status: "error",
      reason:
        "Save As is only available for scratchpads/uploads; this document is already on disk.",
      errorCode: "NOT_PROMOTABLE",
    };
  }
  if (!SAVE_AS_FORMATS.has(format)) {
    return {
      status: "error",
      reason: `Unsupported save-as format: '${format}'. Supported: md, txt.`,
      errorCode: "UNSUPPORTED_FORMAT",
    };
  }

  // Resolve once so the path we validate, the path we write, and the path we
  // record in `OpenDoc.filePath` are identical. Otherwise the auto-save
  // mtime-check would compare stat(promoted-path) against a session baseline
  // keyed on a slightly different string and never converge.
  const resolved = path.resolve(targetPath);

  // Reject UNC + `\\?\` extended-length prefixes pre- and post-resolve.
  // Cross-platform (string check) since a Windows client can supply a
  // crafted path to a Linux/macOS server. See `windows-path-safety.ts`.
  const rawReason = rejectUnsafeWindowsPrefix(targetPath);
  if (rawReason) {
    return { status: "error", reason: rawReason, errorCode: "INVALID_PATH" };
  }
  const resolvedReason = rejectUnsafeWindowsPrefix(resolved);
  if (resolvedReason) {
    return { status: "error", reason: resolvedReason, errorCode: "INVALID_PATH" };
  }

  // The extension on disk must match the chosen format — otherwise auto-save
  // and the format-detection round-trip would diverge from what the user sees.
  const ext = path.extname(resolved).toLowerCase();
  const expectedExt = `.${format}`;
  if (ext !== expectedExt) {
    return {
      status: "error",
      reason: `Target path extension '${ext || "(none)"}' does not match format '${format}'.`,
      errorCode: "EXTENSION_MISMATCH",
    };
  }

  // Save-As is user-driven: the path came from the native Save dialog, so
  // the user is allowed to write anywhere they point it (external drives,
  // network shares, project dirs outside $HOME). We keep assertPathSafe's
  // symlink-rejection walk — a planted symlink redirecting the write is a
  // genuine attack — but widen its allowed-roots confinement so no
  // home/tmp restriction applies. Passing the resolved path's own
  // filesystem root means the root check always passes (a path is always
  // under its own root) while the realpath/symlink walk still rejects any
  // symlinked component. UNC is rejected separately above.
  try {
    assertPathSafe(resolved, { allowedRoots: [path.parse(resolved).root] });
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
      errorCode: "PATH_REJECTED",
    };
  }

  const adapter = getAdapter(format);
  if (!adapter.save) {
    return {
      status: "error",
      reason: `Adapter for '${format}' cannot save`,
      errorCode: "NO_ADAPTER",
    };
  }

  // Per-document lock — shares the same set used by saveDocumentToDisk so a
  // concurrent auto-save and save-as on the same doc cannot race.
  if (savingDocs.has(docId)) {
    return { status: "error", reason: "Save already in progress", errorCode: "SAVE_IN_PROGRESS" };
  }
  savingDocs.add(docId);
  try {
    const doc = getOrCreateDocument(docId);

    const output = adapter.save(doc);

    // The file shouldn't exist yet (we're saving as new), but if it does,
    // this save OVERWRITES content Tandem never produced — snapshot the
    // victim's bytes first (no-op when the target doesn't exist). Then
    // pre-arm the watcher suppress so the write's first change event doesn't
    // bounce back as an external-edit reload. Safe no-op if the path isn't
    // being watched.
    await snapshotBeforeFirstWrite(resolved, {
      appDataDir: resolveAppDataDir(),
      documentId: docId,
    });
    // Inner try/finally, same shape and same reason as `saveDocumentToDisk`
    // (#1749) — never the function-level `savingDocs` release below.
    // `rearmWatch(resolved)` is DEFINITIONALLY a no-op today: nothing watches
    // the new path when the write runs. It is here for symmetry with the site
    // pin, and because `wireFileWatcher` below is what actually fixes save-as.
    try {
      suppressNextChange(resolved);
      await atomicWrite(resolved, output);
      recordSelfWrite(resolved, output);
    } finally {
      rearmWatch(resolved);
    }

    // Save-As has never wired a watcher for the new path (#1749): an external
    // edit to a just-saved-as document was invisible until the next reopen.
    // Placed AFTER the write — `fs.watch` on a not-yet-existing path throws
    // ENOENT — and still inside the outer try, so the `finally` above keeps its
    // no-op property. Misplacing it before the write no longer fails silently:
    // `watchFile` notifies the user on a refused arm. That is the safety net,
    // not the design; the position is what makes the arm succeed.
    //
    // The arm can still legitimately fail here, and this is where it matters
    // most: the target above is deliberately unconfined (external drives,
    // network shares), and `fs.watch` is unsupported on SMB and returns
    // EPERM/ENOSPC/EMFILE elsewhere. Nothing re-arms after an open, so the
    // notification is the user's only signal that this document is deaf.
    wireFileWatcher(docId, resolved, format);

    // #1460: this promotion can hand a document a format it cannot represent.
    //
    // The promotion below is IN PLACE — same docId, same Y.Doc, same provider —
    // so a `.md` scratchpad or an uploaded `.docx` holding a hard break becomes a
    // live plaintext document still holding one. Plaintext saves by joining
    // blocks with `\n`, so from here on the bytes say two lines while the model
    // says one block, every autosave writes that disagreement, and the next open
    // believes the bytes. Neither client guard covers it: nothing was typed or
    // pasted, and the content was legitimate until the destination changed.
    //
    // **Placed AFTER the write, not before it, and byte-neutrality is what makes
    // the position free.** A hard break and a block boundary both render as `"\n"`,
    // so `output` is identical either way — while a Y.js transaction does not roll
    // back. Flattening first meant a failed `atomicWrite` (permissions, ENOSPC,
    // vanished path) returned an error having already split the user's scratchpad
    // and re-anchored its annotations, with the document still `.md` and still
    // unsaved. Found in review. It must still precede `saveSession` below, so the
    // persisted snapshot matches the bytes on disk.
    //
    // `withInternal`, not `withFileSync`. The two have identical skip profiles, so
    // this is a labelling choice — and per ADR-031 the helper choice IS the
    // contract, which is why it is worth getting right. `FILE_SYNC_ORIGIN` means
    // "an echo from the durable-annotation file-writer or the watcher reload path";
    // this is a server-internal content restructure, which is what
    // `INTERNAL_ORIGIN` enumerates. Neither generates channel events.
    if (isPlaintextFormat(format)) {
      withInternal(doc, () => flattenPlaintextBreaks(doc));
    }

    // Persist a session for the promoted path so a restart restores the
    // newly-saved doc rather than dropping content on the floor.
    try {
      await saveSession(resolved, format, doc);
    } catch (err) {
      // Session persistence is best-effort; the disk write is the contract.
      console.error("[SaveAs] saveSession failed for", resolved, err);
    }

    // Capture the pre-promote upload:// path BEFORE `addDoc` overwrites it.
    // Used to delete the stale upload session below so a restart doesn't try
    // to restore a now-promoted doc under its old synthetic key.
    const oldUploadPath = docState.filePath;

    // Delete the pre-promote upload session. Best-effort — a leftover session
    // for an upload:// path is skipped by listSessionFilePaths on restart, but
    // leaving it behind is dead state. Do it after the new session write so a
    // crash between the two leaves the durable copy, not nothing.
    try {
      await deleteSession(oldUploadPath);
    } catch (err) {
      console.error("[SaveAs] deleteSession failed for", oldUploadPath, err);
    }

    // Promote in place — keep the Hocuspocus room ID, swap source/filePath/format.
    const fileName = path.basename(resolved);
    // The registry write cannot be deferred to where the broadcast used to sit:
    // `markClean` below reads this entry's `source` via `isDirtyMirrorEligible`,
    // and a stale "upload" would silently suppress the dirty mirror for a
    // now-real file. So the write stays here and the PUBLISH moves to the end of
    // the prepare block — otherwise clients would see the promoted identity
    // (`source: "file"` is what gates the rename affordance) while the annotation
    // store and channel observers are still wired for an upload doc.
    //
    // "After the store is wired" means after the ATTEMPT: `wireAnnotationStore`
    // catches its own failures and returns `{wired:false}` rather than throwing,
    // which is what keeps a promote non-fatal. On that path the file is real and
    // its annotations are session-only, and the user learns it from the
    // notification the helper pushes — not from anything published here.
    await updateDocumentWhenReady(
      { id: docId, filePath: resolved, format, readOnly: false, source: "file" },
      async () => {
        // Refresh meta + dirty-tracking baseline. `withFileSync` is the right
        // origin per ADR-031 — this is post-save bookkeeping (the file-writer
        // echo), not user-intent (`withMcp`) and not setup (`withInternal`).
        const meta = doc.getMap(Y_MAP_DOCUMENT_META);
        const now = Date.now();
        withFileSync(doc, () => {
          meta.set("format", format);
          meta.set("fileName", fileName);
          meta.set(Y_MAP_SAVED_AT_VERSION, now);
        });

        // Re-key the durable annotation store to the promoted path. Scratchpads
        // open WITHOUT a file-sync context (openScratchpad skips wireAnnotationStore
        // — ephemeral docs shouldn't orphan JSON on close). Once promoted to a real
        // file, annotations SHOULD persist under `docHash(resolved)`, so wire the
        // store now. wireAnnotationStore runs loadAndMerge (no prior on-disk state
        // for a fresh path) and registers the file-sync context keyed to the new
        // docHash, so annotations created post-promote serialize under the real
        // path's key and reload on reopen-by-path. Best-effort: a wiring failure
        // must not fail the save (the disk write is the contract), and the helper
        // itself swallows + surfaces its own errors via the notification bus.
        //
        // Note (#827 review, flush Low): wireAnnotationStore → setFileSyncContext
        // disposes any prior file-sync context with phase "close" WITHOUT flushing
        // its debounced writes. For a SECOND Save-As on the same doc that would
        // drop unflushed annotations — but the `source === "upload"` gate above
        // closes that window: the first promote flips `source` to "file", so a
        // second Save-As is rejected with NOT_PROMOTABLE before reaching here. The
        // first promote is safe because a scratchpad/upload doc has no prior
        // file-sync context to dispose (openScratchpad skips wireAnnotationStore).
        await wireAnnotationStore(docId, doc, resolved);

        // The doc is now a real file — its channel observers were attached as an
        // upload doc (uploadDoc: true → annotation/reply events suppressed). Re-
        // attach as a non-upload doc so post-promote annotations reach Claude.
        attachObservers(docId, doc);

        // The promoted doc's body was just written to disk, so its dirty baseline
        // is the current content — clear the flag so the next autosave pass doesn't
        // immediately re-write it (#851). attachObservers re-registered the body
        // observer above (preserving the version counter), so mark clean here.
        markClean(docId);
      },
    );

    // Emit a synthetic `document:opened` so Claude can read/edit the now-real
    // file by path. Because promote keeps the same documentId, the ctrl-meta
    // observer sees no openDocuments ID change and would otherwise leave the
    // doc in its `uploadDocIds` suppression set (invisible to Claude). This
    // clears that suppression and surfaces the file on the channel.
    notifyDocumentPromoted(docId, { fileName, format });

    return { status: "saved", targetPath: resolved, fileName, format };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errCode = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    pushNotification({
      id: generateNotificationId(),
      type: "save-error",
      severity: "error",
      message: `Save As failed for ${path.basename(resolved)}: ${msg}`,
      toolName: "manual",
      errorCode: errCode,
      documentId: docId,
      dedupKey: `save-as:${docId}`,
      timestamp: Date.now(),
    });
    return { status: "error", reason: msg, errorCode: errCode };
  } finally {
    savingDocs.delete(docId);
  }
}

/**
 * Serialize a document to a string in the requested format WITHOUT writing
 * to disk. Used by the browser save-as fallback so the client can wrap the
 * result in a Blob + anchor download (the browser distribution has no native
 * file save dialog).
 */
export function serializeDocument(
  docId: string,
  format: "md" | "txt",
): { ok: true; content: string; fileName: string } | { ok: false; reason: string } {
  const docState = openDocs.get(docId);
  if (!docState) return { ok: false, reason: "Document not open" };
  if (!SAVE_AS_FORMATS.has(format)) {
    return { ok: false, reason: `Unsupported serialize format: '${format}'. Supported: md, txt.` };
  }
  const adapter = getAdapter(format);
  if (!adapter.save) {
    return { ok: false, reason: `Adapter for '${format}' cannot save` };
  }
  const doc = getOrCreateDocument(docId);
  const content = adapter.save(doc);
  // For upload:// docs the basename is the synthetic name (e.g. "Scratchpad.md").
  // The caller wraps in a Blob and lets the browser propose the filename, so
  // we re-stem to match the requested format here (Scratchpad.md → Scratchpad.txt).
  const baseStem = path.basename(docState.filePath, path.extname(docState.filePath)) || "document";
  return { ok: true, content, fileName: `${baseStem}.${format}` };
}

/**
 * Auto-save all eligible open documents to disk.
 * Called by the 60-second auto-save timer.
 */
export async function autoSaveAllToDisk(): Promise<void> {
  for (const [docId, state] of openDocs) {
    if (state.source === "upload" || state.readOnly) continue;
    if (!AUTO_SAVE_FORMATS.has(state.format)) continue;
    // #851: skip docs with no unsaved body edits. Merely opening a file to view
    // it must not round-trip it through the serializer + rewrite it on disk.
    if (!isDirty(docId)) continue;
    try {
      const result = await saveDocumentToDisk(docId);
      if (result.status === "saved") {
        console.error("[AutoSave] Saved %s to disk", path.basename(state.filePath));
      }
    } catch (err) {
      console.error("[AutoSave] Unexpected error saving %s:", state.filePath, err);
    }
  }
}

export interface RenameResult {
  status: "renamed" | "error";
  /** When renamed: the previous on-disk path. */
  oldPath?: string;
  /** When renamed: the new on-disk path. */
  newPath?: string;
  /** When renamed: the new basename the tab displays. */
  fileName?: string;
  reason?: string;
  errorCode?: string;
}

/**
 * Rename an open on-disk document's file, keeping its documentId / Hocuspocus
 * room STABLE (mirrors Save-As's promote-in-place, see `saveDocumentAsToDisk`).
 * Only the path migrates — disk file, durable annotation envelope, session,
 * file-watch target, registry entry, and the tab's fileName metadata. Connected
 * clients keep their Y.Doc/room and just see a new tab label. See #1017.
 *
 * NOT for scratchpads/uploads (`source !== "file"` → use Save-As) or read-only
 * docs (incl. .docx). Renaming preserves bytes + extension — no format change.
 *
 * The ordering here is reviewed and load-bearing; see the inline notes
 * (flush-before-teardown, envelope move + meta heal-write) before changing it.
 */
export async function renameDocument(docId: string, newName: string): Promise<RenameResult> {
  // --- Phase 0: validate (every rejection BEFORE any mutation) ---
  const docState = openDocs.get(docId);
  if (!docState) {
    return { status: "error", reason: "Document not open", errorCode: "NOT_FOUND" };
  }
  if (docState.readOnly) {
    return {
      status: "error",
      reason: "Read-only documents cannot be renamed.",
      errorCode: "READ_ONLY",
    };
  }
  if (docState.source !== "file") {
    return {
      status: "error",
      reason: "Only on-disk files can be renamed; scratchpads and uploads use Save As.",
      errorCode: "NOT_RENAMABLE",
    };
  }

  const nameCheck = validateRenameFilename(newName);
  if (!nameCheck.ok) {
    return { status: "error", reason: nameCheck.reason, errorCode: nameCheck.code };
  }

  const oldPath = docState.filePath;
  const oldExt = path.extname(oldPath).toLowerCase();
  const newExt = path.extname(newName).toLowerCase();
  if (newExt !== oldExt) {
    return {
      status: "error",
      reason: `File extension must stay '${oldExt}' (renaming does not convert formats).`,
      errorCode: "EXTENSION_MISMATCH",
    };
  }

  // Explicit separator guard so CodeQL's js/path-injection taint-tracker sees a
  // recognized barrier before newName reaches path.join. validateRenameFilename
  // already enforces this via path.basename equivalence, but CodeQL requires an
  // inline string check to terminate the taint chain.
  if (newName.includes("/") || newName.includes("\\") || newName.includes("\0")) {
    return {
      status: "error",
      reason: "Filename must not contain directory separators or null bytes.",
      errorCode: "INVALID_PATH",
    };
  }

  const newPath = path.resolve(path.join(path.dirname(oldPath), path.basename(newName)));

  // Reject UNC + `\\?\` extended-length prefixes (cross-platform string check).
  const prefixReason = rejectUnsafeWindowsPrefix(newName) ?? rejectUnsafeWindowsPrefix(newPath);
  if (prefixReason) {
    return { status: "error", reason: prefixReason, errorCode: "INVALID_PATH" };
  }

  // Reject a symlinked path component (a planted symlink could redirect the
  // rename onto a protected file). Widen allowed-roots to the path's own fs
  // root — same as Save-As — since the user renames within their existing dir.
  try {
    assertPathSafe(newPath, { allowedRoots: [path.parse(newPath).root] });
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
      errorCode: "PATH_REJECTED",
    };
  }

  // No-op rename (same resolved path) — nothing to migrate. Checked BEFORE the
  // exists-guard below, which would otherwise reject renaming a file to itself.
  // (A case-only rename on a case-insensitive filesystem is a known v1 gap: the
  // exists-guard sees the same inode and rejects it as ALREADY_EXISTS.)
  if (path.resolve(oldPath) === newPath) {
    return { status: "renamed", oldPath, newPath, fileName: path.basename(newPath) };
  }

  // Refuse to clobber an existing file. TOCTOU window is acceptable (matches
  // Save-As); fs.rename on Windows also throws EEXIST as a backstop.
  const targetExists = await pathExists(newPath);
  if (targetExists) {
    return {
      status: "error",
      reason: `A file already exists at ${path.basename(newPath)}.`,
      errorCode: "ALREADY_EXISTS",
    };
  }

  // Share the per-doc save lock so auto-save / tandem_save can't race the rename.
  if (savingDocs.has(docId)) {
    return {
      status: "error",
      reason: "A save is in progress; try again.",
      errorCode: "RENAME_IN_PROGRESS",
    };
  }
  const oldHash = docHash(oldPath);
  const newHash = docHash(newPath);
  const format = docState.format;

  // Acquire the lock INSIDE the try so the finally always releases it — taking it
  // outside and then throwing would leak it and permanently block this doc's future
  // saves/renames with RENAME_IN_PROGRESS.
  try {
    savingDocs.add(docId);
    const doc = getOrCreateDocument(docId);

    // --- Phase 1: reversible prep (flush, keep observer ATTACHED) ---
    // Flush the live store first so <oldHash>.json captures current annotations
    // + the still-intact tombstone ledger. closeStore MUST precede any teardown
    // of the old context (whose "close" cleanup deletes the ledger) or
    // tombstones are lost — a deleted annotation would resurrect after rename.
    //
    // #1040, window (a): we DELIBERATELY do NOT clearFileSyncContext here. The
    // old-hash annotation observer stays attached across the fs.rename + envelope
    // move so a concurrent DELETE arriving in that span still records a tombstone
    // (into the oldHash ledger). Phase 3 then migrates that ledger forward into
    // the newHash envelope before the old context is finally disposed by the
    // re-wire — so the just-deleted annotation can't resurrect.
    try {
      await closeStore(oldHash);
    } catch (err) {
      console.error("[Rename] closeStore(old) failed for %s:", docId, err);
    }

    // Stop watching the old path before the rename so the delete/create events
    // fs.rename emits don't fire a spurious reloadFromDisk.
    unwatchFile(oldPath);

    // --- Phase 2: commit (point of no return) ---
    // Safe FS sink (CodeQL js/path-injection): `oldPath` is the registry's
    // server-managed `docState.filePath` (only ever set by openFromDisk /
    // resolveAndValidatePath); `newPath` was built from path.dirname(oldPath) +
    // path.basename(newName) and then cleared validateRenameFilename, the inline
    // separator/null-byte guard, rejectUnsafeWindowsPrefix, and assertPathSafe
    // above. Both entry points (POST /api/rename, tandem_rename) additionally
    // path.basename() the raw input — CodeQL's recognized taint terminator —
    // before it reaches renameDocument. Any alert here is a false positive;
    // dismiss per issue #1042.
    //
    // The registry-path enumeration this comment leans on names four setters,
    // not three: openFromDisk, resolveAndValidatePath, a validated rename or
    // save-as, and openFromUpload, which registers a synthetic
    // `upload://<uuid>/<name>` with the caller-controlled segment reduced by
    // `crossBasename`. An enumeration missing a setter is a denylist, so it is
    // written out here rather than left implied.
    try {
      await fs.rename(oldPath, newPath);
    } catch (err) {
      // Log the ORIGINAL failure first — the rollback below can itself throw, and
      // we must not let a rollback error mask why the rename actually failed.
      console.error("[Rename] fs.rename failed for %s (%s -> %s):", docId, oldPath, newPath, err);
      // Roll back the reversible prep: re-wire the old context + re-watch.
      //
      // #1040 rollback fix: on rollback, oldHash === the still-registered
      // context's hash (nothing was renamed). We MUST drop that stale same-hash
      // context BEFORE re-wiring. Otherwise wireAnnotationStore → loadAndMerge
      // re-seeds the oldHash tombstone ledger (UNION + tombstonesByDoc.set), and
      // the trailing setFileSyncContext then finds the STILL-PRESENT old oldHash
      // context and disposes it with the "close" phase — whose cleanup runs
      // tombstonesByDoc.delete(oldHash) + forgetDoc(oldHash), deleting the ledger
      // loadAndMerge just repopulated. A later snapshot would then write an empty
      // tombstone list, resurrecting a deleted annotation. Restoring the master
      // ordering (clearFileSyncContext first) removes the stale context so there
      // is nothing for setFileSyncContext to "close"-dispose after the re-seed.
      // Safe because Phase 1's closeStore(oldHash) already flushed the ledger to
      // <oldHash>.json, so loadAndMerge re-seeds the tombstone from disk; nothing
      // was renamed, so there is no concurrent-delete window on rollback.
      // Best-effort — a rollback failure is logged but the returned error stays
      // the original fs.rename failure (the actionable root cause).
      try {
        clearFileSyncContext(docId);
        await wireAnnotationStore(docId, doc, oldPath, { allowRecovery: false });
        wireFileWatcher(docId, oldPath, format);
      } catch (rollbackErr) {
        console.error(
          "[Rename] rollback after failed rename also failed for %s:",
          docId,
          rollbackErr,
        );
      }
      const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
      return {
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
        errorCode: code,
      };
    }

    // --- Phase 3: best-effort, each wrapped (the disk rename is the contract) ---
    // The annotation envelope migration (#1040) collapses the old fs.rename +
    // heal-write split into a single read-modify-write that writes the NEW
    // envelope (with meta.filePath = newPath) BEFORE removing the old one. This
    // closes the two stale-envelope resurrection windows from #1017/#1038:
    //
    //   (b) The newHash envelope no longer transiently carries a stale
    //       meta.filePath (the vanished oldPath) — the RMW writes the corrected
    //       path atomically, so a concurrent byte-identical open can never match
    //       + steal it via recoverRenamedEnvelope.
    //   (c) The oldHash envelope is removed only AFTER newHash is durably
    //       written, so there's no point where BOTH the renamed disk file and
    //       the oldHash envelope (with its vanished oldPath) coexist for a
    //       byte-identical open to re-key.
    //
    // Window (a) — a concurrent DELETE while the old-hash observer is still
    // attached — is closed by folding the oldHash tombstone ledger forward into
    // newHash. The old observer stays attached across the fs.rename + envelope
    // move + the re-wire's `loadAndMerge` IO (Phase 1 deferred its teardown), so
    // an in-span DELETE records a tombstone into the oldHash ledger. TWO folds:
    //
    //   1. Before the RMW snapshot (the explicit fold immediately below): so the
    //      freshly-written newHash envelope already carries any tombstone recorded
    //      during the fs.rename itself. Redundant-but-cheap given fold 2.
    //   2. The LOAD-BEARING fold (#1040, windows a2 + a3): `migrateTombstonesFrom`
    //      threaded into the re-wire's wireAnnotationStore → loadAndMerge, which
    //      folds oldHash→newHash AFTER its `store.load()` read but BEFORE the
    //      merge. That single, precisely-placed fold catches a DELETE recorded
    //      either before the re-wire OR during the load read, so loadAndMerge's
    //      UNION-not-clobber seed carries it and the merge APPLIES the tombstone
    //      instead of re-inserting the just-deleted record from the RMW envelope.

    // Fold 1: captures any DELETE recorded during the fs.rename so the RMW
    // envelope written next is tombstone-complete.
    migrateTombstoneLedger(oldHash, newHash);

    // Fold 0 (#1040 × #1041 regression): the RMW snapshot below reads ONLY the
    // live Y.Doc. A durable annotation that is NEWER in the OLD file envelope than
    // in the live map (e.g. a note flushed at rev 2 then diverged to rev 1 via a
    // `withInternal` write the durable-sync observer skipped) would be DROPPED by
    // that pure-live snapshot, and the subsequent re-wire's `loadAndMerge` — now
    // reading the clobbered new-hash envelope — finds nothing newer than live, so
    // the file-newer record is lost on rename. Fold the OLD envelope's alive
    // records forward into the live doc FIRST (file-wins by rev) so the winning
    // record lands in the RMW snapshot. The old envelope still exists here (RMW
    // step 2 removes it last). Best-effort: a read/merge failure must not flip the
    // committed rename to "error" — at worst we degrade to the prior live-only
    // snapshot. In the common case (live == file) this is an idempotent no-op.
    // Safe FS sink (CodeQL js/path-injection): `oldPath` is the registry's
    // server-managed `docState.filePath`, and the envelope is read/written under
    // `docHash(oldPath)` — a fixed-length hash with no path component. No
    // user-controlled string reaches this store's filesystem path; an alert here
    // is a false positive (dismiss per issue #1042).
    try {
      const oldFile = await createStore(oldHash, { filePath: oldPath }).load();
      mergeEnvelopeForward(doc, oldFile, newHash);
    } catch (err) {
      console.error("[Rename] old-envelope fold-forward failed for %s:", docId, err);
    }

    // RMW step 1: write the NEW envelope from the live Y.Maps + migrated ledger,
    // with meta.filePath already = newPath. This is the move (annotations +
    // tombstones land under newHash) AND the heal-write (correct path), in one
    // atomic write — before the old envelope is removed. Best-effort: the disk
    // rename already committed, so a failure here must not flip the result to
    // "error"; a crash is healed on next open by the passive recoverRenamedEnvelope.
    try {
      const newStore = createStore(newHash, { filePath: newPath });
      await persistSnapshot(newStore, doc, newHash, newPath);
    } catch (err) {
      console.error("[Rename] envelope RMW (write new) failed for %s:", docId, err);
    }

    // Re-wire at the new path. `migrateTombstonesFrom: oldHash` drives fold 2
    // inside loadAndMerge (after the load read, before the merge) so any DELETE
    // recorded into the oldHash ledger before or during that read is applied
    // rather than resurrected. allowRecovery:false — an active rename must never
    // let recovery steal a DIFFERENT file's envelope. Best-effort: a re-wire
    // failure must not flip the committed rename to "error".
    let rewired = false;
    try {
      // `wired` is true only when loadAndMerge AND setFileSyncContext both ran
      // to completion (#1057). wireAnnotationStore SWALLOWS internal failures
      // (so the rename stays committed) but now reports them via `wired:false`,
      // so an internal loadAndMerge throw — where setFileSyncContext never ran
      // and the oldHash observer is still live — leaves `rewired` false and the
      // !rewired guard below fires, exactly like a boundary rejection.
      const result = await wireAnnotationStore(docId, doc, newPath, {
        allowRecovery: false,
        migrateTombstonesFrom: oldHash,
      });
      rewired = result.wired;
    } catch (err) {
      console.error("[Rename] re-wire annotation store at new path failed for %s:", docId, err);
    }

    // RMW step 1b: flush the newHash envelope ONE more time, AFTER the re-wire.
    // loadAndMerge's fold (fold 2) carries a late DELETE — one recorded into the
    // oldHash ledger during the re-wire's load read — forward into the newHash
    // ledger and queues a (debounced) write. This synchronous queueWrite + flush
    // GUARANTEES that migrated-forward tombstone reaches disk before this call
    // returns; without it the debounced write could still be pending, leaving the
    // envelope tombstone-incomplete for an immediate reopen. Best-effort: the
    // disk rename already committed.
    try {
      const newStore = createStore(newHash, { filePath: newPath });
      await persistSnapshot(newStore, doc, newHash, newPath);
    } catch (err) {
      console.error("[Rename] envelope RMW (flush after re-wire) failed for %s:", docId, err);
    }

    // RMW step 2: remove the old envelope LAST. The stale-envelope steal vector
    // (a concurrent DELETE queuing a debounced write that re-creates
    // <oldHash>.json with the vanished oldPath) is closed on BOTH paths:
    //   - success path: the re-wire's setFileSyncContext already disposed the
    //     oldHash observer (docId now points at newHash), so nothing is left to
    //     re-create the envelope.
    //   - re-wire-FAILURE path: when the re-wire does not complete,
    //     setFileSyncContext never ran, so the oldHash context is still
    //     registered and LIVE, now pointing at the vanished oldPath. The
    //     !rewired guard below disposes it before the clear() so no concurrent
    //     DELETE can queue a debounced write that re-creates <oldHash>.json
    //     after the clear. This MUST be gated on !rewired: on the success path
    //     docId already points at newHash, so an unconditional
    //     clearFileSyncContext(docId) would tear down the freshly-wired newHash
    //     observer.
    //     This covers BOTH failure modes (#1057): a boundary rejection (caught
    //     above) AND an internal loadAndMerge throw (wireAnnotationStore now
    //     reports `wired:false` instead of swallowing silently). In both, the
    //     oldHash observer is still live and `rewired` is false, so the guard
    //     fires and the internal-throw steal vector is closed.
    // clear() also drops any pending write the old store may still hold, so
    // nothing re-creates it afterward.
    if (!rewired) {
      clearFileSyncContext(docId);
    }
    try {
      await createStore(oldHash, { filePath: oldPath }).clear();
    } catch (err) {
      console.error("[Rename] envelope RMW (remove old) failed for %s:", docId, err);
    }

    // Move the session: write the new one BEFORE deleting the old so a crash
    // leaves the durable copy. saveSession stats newPath for its mtime baseline.
    try {
      // Carry any pending conflict (#1238): rename re-baselines
      // SAVED_AT_VERSION to the renamed file's mtime below, so without this a
      // rename-then-restart would launder an unresolved conflict away and let
      // the next autosave overwrite the external change.
      await saveSession(newPath, format, doc, {
        dirty: isDirty(docId),
        conflict: readPendingConflict(doc),
      });
      await deleteSession(oldPath);
    } catch (err) {
      console.error("[Rename] session move failed for %s:", docId, err);
    }

    // Registry / watcher / tab-metadata bookkeeping. All best-effort: fs.rename
    // already committed (the contract is met), so a throw here must NOT report
    // "Rename failed" — that would tell the user the opposite of the truth (disk
    // bears the new name) and revert the tab label against on-disk reality.
    const fileName = path.basename(newPath);
    try {
      // Re-target the file watcher (.docx included since #1069 — clean docs
      // reload, dirty docs get the external-conflict flag). No
      // suppressNextChange here: fs.rename already happened before the new watch
      // started (so it emits no change event to suppress), and nothing writes
      // newPath afterward — an armed latch would only swallow a genuine external
      // edit arriving within the TTL.
      wireFileWatcher(docId, newPath, format);

      // Read the post-rename mtime BEFORE touching the registry, so the block
      // below holds no `await` at all. Two things depend on that: the publish
      // then cannot land between the registry write and the document's own
      // `fileName` (a broadcast arriving in that gap reverts an optimistically
      // renamed tab label, because the client treats the server entry as
      // authoritative), and this filesystem call stays a plain statement of the
      // enclosing function rather than a sink inside a nested closure.
      //
      // Safe FS sink (CodeQL js/path-injection): `newPath` is the validated
      // rename target (see the Phase-0 barriers above) — not raw user input.
      // An alert here is a false positive; dismiss per issue #1042.
      const stat = await fs.stat(newPath).catch(() => null);

      // Update the registry entry, then publish the new basename once the
      // document's own meta agrees with it: same id/room, new path, overwritten
      // by id. Activation is untouched — a rename must not steal focus. Before
      // ADR-033 the broadcast was this function's last statement.
      await updateDocumentWhenReady(
        { id: docId, filePath: newPath, format, readOnly: false, source: "file" },
        () => {
          // Update the tab's fileName + savedAt baseline. withFileSync is the right
          // origin per ADR-031 (post-rename bookkeeping — a file-writer echo, not user
          // intent or setup). fs.rename preserves bytes + mtime, so set savedAt to the
          // real mtime and DO NOT markClean: unsaved edits must stay dirty so the next
          // autosave writes them to newPath.
          //
          // Caught rather than thrown, deliberately: `updateDocumentWhenReady`
          // skips its broadcast on a throw, and rename is the caller that must
          // NOT skip. `fs.rename` has already committed, so the registry's new
          // path is the truth — clients left showing the old label would be
          // permanently wrong, with no later broadcast to correct them.
          try {
            const meta = doc.getMap(Y_MAP_DOCUMENT_META);
            withFileSync(doc, () => {
              meta.set("fileName", fileName);
              if (stat) meta.set(Y_MAP_SAVED_AT_VERSION, stat.mtimeMs);
            });
          } catch (err) {
            console.error("[Rename] tab metadata update failed for %s:", docId, err);
          }
        },
      );
    } catch (err) {
      console.error("[Rename] post-commit bookkeeping failed for %s:", docId, err);
    }

    return { status: "renamed", oldPath, newPath, fileName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errCode = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    pushNotification({
      id: generateNotificationId(),
      type: "save-error",
      severity: "error",
      message: `Rename failed for ${path.basename(oldPath)}: ${msg}`,
      toolName: "manual",
      errorCode: errCode,
      documentId: docId,
      dedupKey: `rename:${docId}`,
      timestamp: Date.now(),
    });
    return { status: "error", reason: msg, errorCode: errCode };
  } finally {
    savingDocs.delete(docId);
  }
}

/**
 * Close a document by ID. Saves the session, removes from tracking,
 * picks a new active doc if needed, stops auto-save if no docs remain,
 * and broadcasts the updated document list.
 */
export async function closeDocumentById(
  id: string,
): Promise<
  | { success: true; closedPath: string; activeDocumentId: string | null }
  | { success: false; error: string }
> {
  // path.basename eliminates directory components so CodeQL does not trace
  // user input through Map.get(id) to docState.filePath FS sinks
  // (js/path-injection). Valid IDs are 64-char hex — no separators, so this
  // is a no-op at runtime.
  const safeId = path.basename(id);
  const docState = openDocs.get(safeId);
  if (!docState) {
    return { success: false, error: `Document ${id} not found.` };
  }

  const closedPath = docState.filePath;

  // Stop watching for external changes BEFORE reading the pending-conflict
  // flag below (review finding). A file-watcher debounce timer can still be
  // mid-flight at close time; if `readPendingConflict` ran first and the
  // debounce delivered a NEW conflict in the gap before `unwatchFile`, that
  // flag would be written to the just-evicted Y.Doc and immediately orphaned
  // — `closeDocument` drops the doc from the registry right after, so nothing
  // would ever read or carry it into the session. Unwatching first closes
  // that window: any debounce callback still in flight finds `getDocument(id)`
  // returns the doc (harmless — `readPendingConflict` below already captured
  // the pre-close state), and no NEW watcher callback can fire after this
  // point.
  unwatchFile(docState.filePath);

  // An unresolved external conflict makes the session file load-bearing
  // (#1238): every save path is blocked while one is pending, so the edits may
  // never have reached disk, and the teardown below would otherwise delete the
  // only copy of them. Write the session NOW — before `clearDirtyState` and
  // `closeDocument` take away the state it needs — so the preserved file actually
  // contains the edits rather than whatever the last periodic write held.
  //
  // Normally closing really does discard: a dirty .md/.txt autosaves within
  // 60s, so the session is redundant and deleting it is what makes a closed tab
  // stay closed. That path is unchanged.
  const closingDoc = getOrCreateDocument(safeId);
  const conflictAtClose = readPendingConflict(closingDoc);
  if (conflictAtClose) {
    try {
      await saveSession(docState.filePath, docState.format, closingDoc, {
        dirty: isDirty(safeId),
        conflict: conflictAtClose,
      });
    } catch (err) {
      console.error(
        "[Tandem] closeDocumentById: conflict session write failed for %s:",
        safeId,
        err,
      );
    }
  }

  // Flush the durable annotation store FIRST (while the in-memory tombstone
  // ledger is still intact), THEN drop the per-doc file-sync observer.
  //
  // Order is load-bearing (#1017 review, Finding C): `clearFileSyncContext`'s
  // "close" cleanup DELETES `tombstonesByDoc[hash]`. If we cleared before
  // flushing, a pending debounced snapshot would serialize an emptied ledger —
  // so a delete-then-close within the 100ms debounce window would drop the
  // tombstone, and the deleted annotation could resurrect on a later stale-tab
  // CRDT merge. `docHash(filePath)` is exactly the hash wireAnnotationStore
  // registered the context under, so flushing it first is correct; it is a
  // harmless no-op for ephemeral docs that have no store.
  try {
    await closeStore(docHash(docState.filePath));
  } catch (err) {
    console.error("[Tandem] closeDocumentById: closeStore failed for %s:", safeId, err);
  }
  clearFileSyncContext(id);

  // Clear save lock to prevent a close-reopen race where the old lock blocks new saves
  savingDocs.delete(id);

  // Drop dirty-tracking state + detach its body observer (#851).
  clearDirtyState(id);

  // The registry's slice of the close: untrack, reassign the active id when the
  // closed doc held it, publish once. The store flush, file-sync context and
  // dirty teardown above stay here — their ordering is load-bearing.
  closeDocument(id);

  // Delete the session file so this document doesn't reopen on restart —
  // unless the block above just wrote it as the surviving copy of unpersisted
  // edits. Keeping it means the document reopens still carrying its unanswered
  // keep-vs-reload choice, which is the conservative outcome.
  if (conflictAtClose) {
    console.warn(
      "[Tandem] Keeping the session for %s: closed with an unresolved external conflict, so the session holds the only copy of its unsaved edits.",
      path.basename(closedPath),
    );
  } else {
    try {
      await deleteSession(docState.filePath);
    } catch (err) {
      console.error("[Tandem] Failed to delete session for %s:", safeId, err);
    }
  }

  if (docCount() === 0) {
    stopAutoSave();
  }

  return { success: true, closedPath, activeDocumentId: getActiveDocId() };
}

/** Save all open sessions (for shutdown handler). */
export async function saveCurrentSession(): Promise<void> {
  // Per-document try/catch (#1750), the shape `autoSaveAllToDisk` already uses.
  // Without it one failing document aborted the loop, every document after it
  // in iteration order silently never got a session write, AND
  // `saveCtrlSession` below — the shutdown write of the CTRL_ROOM chat history
  // — never ran at all.
  let failures = 0;
  for (const [id, state] of openDocs) {
    const doc = getOrCreateDocument(id);
    // `dirty` matters most here (#1069): shutdown's autoSaveAllToDisk flush
    // skips binary formats — and, since #1238, any format with a pending
    // conflict — so a dirty session at shutdown can be the only copy of its
    // unsaved edits. The flag drives the reopen prompt; `conflict` carries an
    // unresolved keep-vs-reload choice across the restart, which cannot be
    // re-derived on reopen (saveSession's mtime baseline already reflects the
    // external write, so the file reads as unchanged).
    try {
      await saveSession(state.filePath, state.format, doc, {
        dirty: isDirty(id),
        conflict: readPendingConflict(doc),
      });
    } catch (err) {
      failures++;
      console.error("[Shutdown] saveSession failed for %s:", state.filePath, err);
    }
  }
  if (failures > 0) {
    // This reaches nobody: `saveCurrentSession` runs inside the shutdown
    // sequence that ends in `process.exit(0)`, so the `console.error` above is
    // the only surviving signal. Pushed anyway so the two loops keep one shape.
    pushNotification({
      id: generateNotificationId(),
      type: "general-error",
      severity: "warning",
      message: `Could not save ${failures} document session${failures === 1 ? "" : "s"} at shutdown.`,
      dedupKey: "session-save-failed",
      timestamp: Date.now(),
    });
  }
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  await saveCtrlSession(ctrlDoc);
}

/** Restore CTRL_ROOM chat history from session file if available.
 *  Returns the previously active documentId (if any) so startup can restore it. */
export async function restoreCtrlSession(): Promise<string | null> {
  const saved = await loadCtrlSession();
  if (!saved) return null;

  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  restoreCtrlDoc(ctrlDoc, saved);

  // Read the previous active doc before clearing stale tracking
  const meta = ctrlDoc.getMap(Y_MAP_DOCUMENT_META);
  const previousActiveDocId = (meta.get(Y_MAP_ACTIVE_DOCUMENT_ID) as string) ?? null;

  // Clear stale document tracking — no docs are actually open after a restart.
  // Chat history is preserved; only the document list is wiped.
  withInternal(ctrlDoc, () => {
    meta.delete(Y_MAP_OPEN_DOCUMENTS);
    meta.delete(Y_MAP_ACTIVE_DOCUMENT_ID);
    meta.delete(Y_MAP_ACTIVE_DOCUMENT_EPOCH);
  });

  console.error("[Tandem] Restored chat history from session (cleared stale doc list)");
  return previousActiveDocId;
}

/**
 * This process's generation id — the source of truth the Hocuspocus
 * `onAuthenticate` gate compares client tokens against. Deliberately module
 * state distributed over HTTP (GET /api/info), never broadcast via the ctrl
 * Y.Map: a CRDT-carried value can be clobbered by a stale reconnecting client
 * (concurrent YMap set resolves by clientID — a coin flip), which is exactly
 * the corruption the gate exists to prevent.
 */
let currentGenerationId: string | null = null;

/** The generation id for this server run, or null before writeGenerationId(). */
export function getGenerationId(): string | null {
  return currentGenerationId;
}

/**
 * Mint a unique generationId for this server run. Clients receive it via
 * GET /api/info and present it as their Hocuspocus auth token.
 */
export function writeGenerationId(): void {
  currentGenerationId = randomUUID();
  // The Hocuspocus onAuthenticate gate reads this through the installed
  // lifecycle's `expectedGenerationToken()` method, so it needs no arming call
  // here and no longer depends on minting happening before installation.
  console.error(`[Tandem] Server generationId: ${currentGenerationId}`);
}

/**
 * Broadcast the annotation store read-only state to connected browser clients
 * via CTRL_ROOM's Y_MAP_DOCUMENT_META. Clients observe Y_MAP_STORE_READ_ONLY
 * on the bootstrap Y.Doc to surface a persistent warning banner.
 *
 * The transaction uses `withInternal` (ADR-031): this is server-initiated
 * metadata, not user-intent. Channel skips internal; durable-sync skips
 * internal; ctrl-meta observer skips internal. Browser clients observe the
 * value via the bootstrap observer (which doesn't filter by origin).
 */
export function broadcastStoreReadOnly(readOnly: boolean): void {
  try {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const meta = ctrlDoc.getMap(Y_MAP_DOCUMENT_META);
    if (meta.get(Y_MAP_STORE_READ_ONLY) !== readOnly) {
      withInternal(ctrlDoc, () => meta.set(Y_MAP_STORE_READ_ONLY, readOnly));
    }
  } catch (err) {
    console.error("[Tandem] broadcastStoreReadOnly: failed to write to CTRL_ROOM:", err);
  }
}

/**
 * Scan sessions and re-open previously open documents.
 * Called during startup to restore the working set.
 */
export async function restoreOpenDocuments(previousActiveDocId: string | null): Promise<number> {
  const sessions = await listSessionFilePaths();
  if (sessions.length === 0) return 0;

  let restoredCount = 0;
  for (const { filePath, readOnly } of sessions) {
    try {
      // Carry the persisted read-only flag back through: without it every
      // restored document takes `resolveAndValidatePath`'s hardcoded `false`,
      // and a read-only tab (View Changelog) comes back writable.
      await openFromRestore({ filePath, readOnly });
      restoredCount++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        console.error("[Tandem] Skipping deleted file (removing stale session): %s", filePath);
        deleteSession(filePath).catch((err) => {
          console.error("[Tandem] Failed to delete stale session for %s:", filePath, err);
        });
      } else {
        console.error("[Tandem] Failed to restore %s:", filePath, err);
      }
    }
  }

  // Restore the previously active document if it was successfully reopened
  if (previousActiveDocId && openDocs.has(previousActiveDocId)) {
    activateDocument(previousActiveDocId);
  }

  if (restoredCount > 0) {
    console.error(`[Tandem] Restored ${restoredCount} document(s) from session`);
  }

  return restoredCount;
}
