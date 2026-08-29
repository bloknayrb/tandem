/**
 * The reload family: replacing the content of an ALREADY-open document.
 *
 * Everything that OPENS a document moved to `documents/open.ts` in ADR-034
 * Unit 7a. What is left here are the three entries that take a document which
 * is already in the registry and swap its content out from under itself:
 *
 *   - `reloadDocumentFromMarkdown` — from a user-supplied markdown string
 *     (raw-source view/edit), via `routes/document-reload.ts`.
 *   - `restoreDocumentFromBackup` — from a pre-overwrite snapshot, via
 *     `routes/backups.ts` and `mcp/docx-apply.ts`.
 *   - `resolveExternalConflict` — keep-or-reload after an external write, via
 *     `routes/external-conflict.ts`.
 *
 * They are grouped by what they do, not by where they were written: each one
 * decides what the on-disk truth is and makes the Y.Doc match it. Unit 7c
 * decides where they finally live; until then this module exists to hold them
 * and nothing else, which is why it no longer imports the open pipeline it used
 * to contain.
 */

import fs from "fs/promises";
import path from "path";
import {
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_SAVED_AT_VERSION,
} from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import { generateNotificationId } from "../../shared/utils.js";
import { docBackupSnapshotPath, snapshotBeforeFirstWrite } from "../file-io/doc-backup.js";
import { assertDocxWithinSizeLimits } from "../file-io/docx-size-gate.js";
import { atomicWrite, atomicWriteBuffer } from "../file-io/index.js";
import { recordSelfWrite, suppressNextChange } from "../file-watcher.js";
import { canSaveToDisk, saveDocumentToDisk } from "../mcp/document-service.js";
import { pushNotification } from "../notifications.js";
import { resolveAppDataDir } from "../platform.js";
import { getDocument, getOrCreateDocument } from "../yjs/provider.js";
import { wireAnnotationStore } from "./annotation-wiring.js";
import { ensureAutoSave } from "./autosave.js";
import { readPendingConflict } from "./conflict.js";
import { clearAndReload } from "./populate.js";
import { broadcastOpenDocs, getOpenDocs } from "./registry.js";
import {
  acquireReloadGuard,
  isReloadInProgress,
  releaseReloadGuard,
  reloadFromDisk,
} from "./watcher.js";

/**
 * Replace an open document's content from a user-supplied markdown string
 * (raw-markdown source view/edit, #1021).
 *
 * Mirrors the force-reload lifecycle (`clearAndReload`) but sources content from
 * the passed string instead of disk, and leaves the doc DIRTY so the new content
 * is persisted to disk. Annotations are cleared (the source edit re-anchors the
 * whole document — same trade-off as `tandem_open force:true`).
 *
 * Throws coded errors the routes map to HTTP status:
 *  - NO_DOCUMENT        — not currently open
 *  - UNSUPPORTED_FORMAT — only .md documents have an editable markdown source
 *  - READ_ONLY          — a read-only .md (e.g. CHANGELOG) must not be replaced
 *  - RELOAD_IN_PROGRESS — a concurrent reload (file-watcher or source edit) holds the guard
 */
export async function reloadDocumentFromMarkdown(id: string, markdown: string): Promise<void> {
  const existing = getOpenDocs().get(id);
  if (!existing) {
    throw Object.assign(new Error("Document is not open."), { code: "NO_DOCUMENT" });
  }
  if (existing.format !== "md") {
    throw Object.assign(new Error("Only .md documents support source editing."), {
      code: "UNSUPPORTED_FORMAT",
    });
  }
  if (existing.readOnly) {
    throw Object.assign(new Error("Document is read-only."), { code: "READ_ONLY" });
  }

  // Refuse while an external conflict is unresolved (#1238). `clearAndReload`
  // below deletes the flag and re-baselines SAVED_AT_VERSION, so committing
  // would resolve the conflict silently — in the "keep" direction — and the
  // save that follows would overwrite the external change with no notice at
  // all. The source-view textarea is also stale by then: its content came from
  // a `documentId`-keyed fetch that never re-runs when the server replaces the
  // Y.Doc, so a user who had already chosen "Reload from file" would have that
  // choice reversed by their own commit. SourceView renders this inline and
  // keeps the draft, so exiting source view to answer the banner is a working
  // exit.
  const doc = getDocument(id) ?? getOrCreateDocument(id);
  if (readPendingConflict(doc)) {
    throw Object.assign(
      new Error(
        "This file changed on disk while you had unsaved edits. Leave source view and choose Keep or Reload before applying markdown changes.",
      ),
      { code: "EXTERNAL_CONFLICT" },
    );
  }
  // Captured RAW (not narrowed), immediately after the check above with no
  // await between — so this is the map's exact value at the moment we
  // confirmed no conflict was pending (undefined, given the throw above).
  // Passed through to clearAndReload as a guard (#1238 review finding):
  // `prepareContent` inside clearAndReload does real async work (markdown
  // parse), and a genuine external write can land during that gap and flag a
  // NEW conflict via the file watcher. clearAndReload's delete of
  // Y_MAP_EXTERNAL_CONFLICT must only fire if the map still holds this exact
  // value by the time the transact runs — otherwise it would silently wipe a
  // conflict this reload never saw. Same identity-comparison pattern as
  // reloadFromDisk's rawConflictBeforeReload guard.
  const rawConflictBeforeCommit = doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_EXTERNAL_CONFLICT);

  // Serialize against the file-watcher reload path (which guards on the same
  // Set) so two clear+repopulate transactions never interleave on one Y.Doc.
  if (!acquireReloadGuard(id)) {
    throw Object.assign(new Error("A reload is already in progress for this document."), {
      code: "RELOAD_IN_PROGRESS",
    });
  }
  try {
    // markCleanAfter:false keeps the doc dirty — the repopulation bumps the
    // dirty version past savedVersion, so any concurrent autosave's
    // markCleanIfUnchanged(snapshot) sees a newer version and won't clear-to-
    // clean against stale content (#851 mechanism).
    await clearAndReload(id, doc, existing.filePath, "md", existing, markdown, {
      markCleanAfter: false,
      conflictGuard: { raw: rawConflictBeforeCommit },
    });
    // File-source docs re-wire the durable annotation store (clearAndReload
    // wiped it) and persist the new markdown to disk immediately. Scratchpads
    // (source: "upload") have no durable store and no disk file — skip both.
    if (existing.source === "file") {
      await wireAnnotationStore(id, doc, existing.filePath);
      // Persist the new content to disk now. The only transient skip reachable
      // here is the per-doc autosave lock (`savingDocs`) being held by a
      // concurrent 60s autosave at this instant — every other skip reason is
      // excluded (source is "file", not read-only, .md is save-eligible, the
      // doc is open, the just-set savedAt baseline rules out the external-
      // modification guard, and the guard at the top of this function plus
      // clearAndReload's flag delete rule out the #1238 conflict gate). So
      // retry briefly to close the window where this route would report
      // success while disk still holds the pre-edit bytes (#1021 review
      // SHOULD-FIX). If still skipped after the retries, the doc is left dirty
      // (markCleanAfter:false) and the next autosave persists it — which is
      // sound precisely BECAUSE no conflict can be pending here; with one
      // pending, #1238 blocks autosave and that fallback would not fire.
      let saved = await saveDocumentToDisk(id, "manual");
      for (let attempt = 0; attempt < 5 && saved.status === "skipped"; attempt++) {
        await new Promise((r) => setTimeout(r, 50));
        saved = await saveDocumentToDisk(id, "manual");
      }
      if (saved.status === "error") {
        // The disk write failed (saveDocumentToDisk already pushed a save-error
        // notification). The Y.Doc reload succeeded and the doc is left dirty,
        // so autosave will keep retrying — don't fail the in-memory reload.
        console.error(
          "[Tandem] reloadDocumentFromMarkdown: disk save failed for %s: %s",
          id,
          saved.reason,
        );
      }
    }
    broadcastOpenDocs();
    ensureAutoSave();
  } finally {
    releaseReloadGuard(id);
  }
}

/** Formats restorable from pre-overwrite doc-backups. .docx joined .md/.txt once
 *  the binary save path also snapshots before overwriting; the snapshot module
 *  is format-agnostic (raw bytes), so a .docx snapshot restores byte-identical. */
const RESTORE_FORMATS = new Set(["md", "txt", "docx"]);

export interface RestoreBackupResult {
  message: string;
  /** Absolute path of the snapshot file the content was restored from. */
  restoredFrom: string;
  /** Absolute path of the document that was restored. */
  filePath: string;
}

/**
 * Restore an open text document (.md/.txt) from a pre-overwrite snapshot
 * (#1086 — snapshots written by `snapshotBeforeFirstWrite`, see
 * `file-io/doc-backup.ts`).
 *
 * Routes through the file-watcher reload lifecycle (`reloadFromDisk`) rather
 * than writing bytes under an open document: annotations survive and re-anchor
 * (withReload-tagged clear+repopulate + range refresh + textSnapshot
 * relocation), event-queue observers reattach, and the doc is marked clean.
 * The disk write itself is wrapped in `suppressNextChange` so the watcher
 * doesn't misread Tandem's own restore write as an external edit (which would
 * double-reload and toast "File changed on disk").
 *
 * Throws coded errors the callers map to MCP / HTTP responses:
 *  - NO_DOCUMENT         — not currently open
 *  - INVALID_PATH        — upload:// / scratchpad source (no on-disk backups)
 *  - UNSUPPORTED_FORMAT  — not a .md/.txt document
 *  - READ_ONLY           — read-only docs must not be overwritten
 *  - RELOAD_IN_PROGRESS  — a concurrent reload holds the per-doc guard
 *  - FILE_NOT_FOUND      — `backupName` is not an existing snapshot for this doc
 */
export async function restoreDocumentFromBackup(
  id: string,
  backupName: string,
): Promise<RestoreBackupResult> {
  const existing = getOpenDocs().get(id);
  if (!existing) {
    throw Object.assign(new Error("Document is not open."), { code: "NO_DOCUMENT" });
  }
  if (existing.source !== "file") {
    throw Object.assign(new Error("Uploaded documents and scratchpads have no on-disk backups."), {
      code: "INVALID_PATH",
    });
  }
  if (!RESTORE_FORMATS.has(existing.format)) {
    throw Object.assign(
      new Error(
        `Backup snapshots exist only for .md/.txt/.docx documents (this is ${existing.format}).`,
      ),
      { code: "UNSUPPORTED_FORMAT" },
    );
  }
  if (existing.readOnly) {
    throw Object.assign(new Error("Document is read-only."), { code: "READ_ONLY" });
  }
  // Check the guard BEFORE writing to disk — if a file-watcher reload is
  // mid-flight, reloadFromDisk below would silently skip and leave the Y.Doc
  // holding pre-restore content while disk holds the snapshot bytes.
  if (isReloadInProgress(id)) {
    throw Object.assign(new Error("A reload is already in progress for this document."), {
      code: "RELOAD_IN_PROGRESS",
    });
  }

  const appDataDir = resolveAppDataDir();
  const snapshotPath = docBackupSnapshotPath(existing.filePath, appDataDir, backupName);
  if (!snapshotPath) {
    throw Object.assign(new Error(`"${backupName}" is not a valid backup snapshot name.`), {
      code: "FILE_NOT_FOUND",
    });
  }
  // .docx snapshots are raw ZIP bytes — a utf-8 round-trip would corrupt them,
  // so read/write them as a Buffer (mirrors the binary branch in reloadFromDisk).
  const isDocx = existing.format === "docx";
  let content: string | Buffer;
  try {
    content = isDocx ? await fs.readFile(snapshotPath) : await fs.readFile(snapshotPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(
        new Error(
          `Backup "${backupName}" not found for ${path.basename(existing.filePath)}. ` +
            "Call tandem_restoreBackup without `backup` to list available snapshots.",
        ),
        { code: "FILE_NOT_FOUND" },
      );
    }
    throw err;
  }

  // Preserve the CURRENT on-disk bytes before overwriting them, so a restore
  // is itself reversible (first overwrite per path per run; never throws — a
  // skip or snapshot failure must not block the restore).
  await snapshotBeforeFirstWrite(existing.filePath, { appDataDir, documentId: id });

  // #1310: validate BEFORE the write, not during the reload below.
  //
  // The ordering is the whole point. `reloadFromDisk` is where `adapter.parse` — and therefore the
  // size gate — would otherwise run, and that is AFTER `atomicWriteBuffer` has already committed
  // these bytes to disk. A refusal at that point would leave the rejected archive on disk, the
  // Y.Doc still holding pre-restore content, and the `savedAtVersion` baseline below never updated
  // — the exact split this function's own comments describe as making the autosave
  // external-modification guard misfire. Snapshots can predate this gate, so restoring an old
  // hostile file reaches that ordering by an ordinary route, not a contrived one.
  if (isDocx) {
    await assertDocxWithinSizeLimits(content as Buffer);
  }

  suppressNextChange(existing.filePath);
  if (isDocx) {
    // atomicWriteBuffer preserves the ZIP byte-for-byte; reloadFromDisk below
    // re-parses it and re-injects Word comments idempotently via adapter.apply.
    await atomicWriteBuffer(existing.filePath, content as Buffer);
  } else {
    await atomicWrite(existing.filePath, content as string);
  }
  // Content backstop for the watcher: the restore write's own `change`-event
  // echo can leak past the single suppressNextChange (NTFS fires ~2 events).
  // The direct reloadFromDisk below does the intended re-anchor; this stops the
  // leaked echo from triggering a SECOND, spurious reload + "file changed" toast.
  recordSelfWrite(existing.filePath, content);
  // The early reloadInProgress check above closes the common case, but a
  // watcher reload can still start during the awaits since that check. A
  // silent skip here would report success while the Y.Doc still holds
  // pre-restore content — surface it as the same coded error instead.
  const reloaded = await reloadFromDisk(id, existing.filePath, existing.format);
  if (!reloaded) {
    throw Object.assign(
      new Error(
        "A concurrent reload interrupted the restore. The backup bytes are on disk — retry to reload the document.",
      ),
      { code: "RELOAD_IN_PROGRESS" },
    );
  }

  // The restored bytes are the new saved baseline. Without this, the autosave
  // external-modification guard (file mtime > savedAtVersion) would treat the
  // restore write as a foreign edit and skip every subsequent autosave. Same
  // withInternal-tagged metadata write as initSavedBaseline.
  const doc = getOrCreateDocument(id);
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  withInternal(doc, () => meta.set(Y_MAP_SAVED_AT_VERSION, Date.now()));

  pushNotification({
    id: generateNotificationId(),
    type: "file-reloaded",
    severity: "info",
    message: `Restored ${path.basename(existing.filePath)} from backup.`,
    documentId: id,
    dedupKey: `restore-backup:${id}`,
    timestamp: Date.now(),
  });

  return {
    message: `Restored ${path.basename(existing.filePath)} from backup ${backupName}.`,
    restoredFrom: snapshotPath,
    filePath: existing.filePath,
  };
}

/**
 * Resolve a pending external-conflict (#1069). Invoked by
 * POST /api/external-conflict/resolve from the client banner.
 *
 * - "keep": keep the in-memory unsaved edits. Clears the flag and re-baselines
 *   Y_MAP_SAVED_AT_VERSION to the CURRENT disk mtime so the explicit-save
 *   external-modification guard unblocks — the user has explicitly accepted
 *   that their next save overwrites the external/disk version.
 * - "reload": discard the unsaved edits and reload from disk through the
 *   existing file-watcher reload lifecycle (annotations preserved +
 *   re-anchored; reloadFromDisk clears the flag and refreshes the baseline).
 *
 * No-op success when no conflict is pending (double-click / stale banner race).
 *
 * `expectedDetectedAt` (optional, #1238 review finding — episode-identity
 * race): the `detectedAt` of the conflict episode the CLIENT saw when the
 * user clicked. Between the click and this call landing, a second external
 * write can have replaced the pending conflict with a DIFFERENT episode (a
 * new `detectedAt`) — the user saw conflict A, clicked "Keep"; before the
 * request lands, a write for conflict B arrives and replaces the flag.
 * Resolving whatever is CURRENTLY pending under A's semantics would silently
 * accept B's disk state as the new baseline, with the user never having seen
 * a banner for B. When supplied and it does not match the currently-pending
 * conflict, this is a no-op — same as the "no conflict pending" case above —
 * rather than resolving the wrong episode. Only checked when the caller
 * supplies it; omitting it (older/internal callers) keeps resolving whatever
 * is pending, same as before this check existed.
 *
 * Throws coded errors the route maps to HTTP status (NO_DOCUMENT).
 */
export async function resolveExternalConflict(
  id: string,
  choice: "keep" | "reload",
  expectedDetectedAt?: number,
): Promise<void> {
  // path.basename eliminates directory components so CodeQL does not trace
  // user input (the request body's documentId, per handleResolveExternalConflict's
  // own comment) through Map.get(id) to existing.filePath FS sinks
  // (js/path-injection) — same technique as closeDocumentById. The actual FS
  // path used below (`existing.filePath`) always comes from the server-owned
  // OpenDoc registry, never from request input, regardless of `id`'s shape.
  const safeId = path.basename(id);
  const existing = getOpenDocs().get(safeId);
  if (!existing) {
    throw Object.assign(new Error("Document is not open."), { code: "NO_DOCUMENT" });
  }
  const doc = getDocument(safeId) ?? getOrCreateDocument(safeId);
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  // Captured RAW (not narrowed) for the "keep" branch's post-await identity
  // check below — see the comment there.
  const rawConflictBeforeResolve = meta.get(Y_MAP_EXTERNAL_CONFLICT);
  if (rawConflictBeforeResolve === undefined) return;

  // Episode-identity check — see the doc comment above. `readPendingConflict`
  // is a second, synchronous read of the same map (no await between here and
  // the raw read above), so it observes the identical value.
  if (expectedDetectedAt !== undefined) {
    const pending = readPendingConflict(doc);
    if (pending?.detectedAt !== expectedDetectedAt) return;
  }

  const resolvedFilePath = path.resolve(existing.filePath);

  if (choice === "keep") {
    // Only re-baseline for a format that HAS a save path. The baseline exists
    // to unblock the external-modification guard on the next save; `.html` has
    // no next save (`saveDocumentToDisk` refuses it outright), so the write
    // would buy nothing and cost something: TabItem reads any
    // SAVED_AT_VERSION change as "saved", clearing the unsaved dot and
    // flashing a check on a document whose edits still exist only in memory
    // (#1238).
    const canSave = canSaveToDisk(existing.format);
    // Safe FS sink (CodeQL js/path-injection): `resolvedFilePath` is derived
    // from `existing.filePath`, the OpenDoc registry's server-managed path
    // (only ever set by openFromDisk / resolveAndValidatePath / a validated
    // rename or save-as / an upload) — never raw request input.
    // `openFromUpload` is the fourth setter and the one this enumeration used
    // to omit: it registers a synthetic `upload://<uuid>/<name>` whose only
    // caller-controlled segment is reduced by `crossBasename` before it is
    // joined, and `isUploadPath` diverts that path from every fs sink anyway.
    // Same established false-positive class as document-service.ts's FS
    // sinks; dismiss per issue #1042.
    const stat = canSave ? await fs.stat(resolvedFilePath).catch(() => null) : null;
    withInternal(doc, () => {
      // Guarded, not unconditional (review finding): the fs.stat above was
      // async, so the file watcher could have flagged a NEWER conflict while
      // it was in flight. "Keep" only means "keep the edits I saw when I
      // clicked" — it must not also silently dismiss a conflict that arrived
      // after the click.
      if (meta.get(Y_MAP_EXTERNAL_CONFLICT) === rawConflictBeforeResolve) {
        meta.delete(Y_MAP_EXTERNAL_CONFLICT);
        // Date.now() fallback when the file is transiently unreadable (e.g. a
        // Word read-lock): clearing the flag without re-baselining would hide
        // the banner while the external-modification guard kept blocking every
        // subsequent save until the document was closed and reopened.
        if (canSave) {
          meta.set(Y_MAP_SAVED_AT_VERSION, stat ? stat.mtimeMs : Date.now());
        }
      }
    });
    return;
  }

  // reloadFromDisk returns false (and leaves the flag untouched) when a
  // concurrent reload already holds `reloadInProgress` — in that case this
  // click didn't perform a reload, so don't claim it did.
  const reloaded = await reloadFromDisk(safeId, resolvedFilePath, existing.format);
  if (reloaded) {
    pushNotification({
      id: generateNotificationId(),
      type: "file-reloaded",
      severity: "info",
      message: `Reloaded from disk: ${path.basename(existing.filePath)}`,
      documentId: safeId,
      dedupKey: `reload:${safeId}`,
      timestamp: Date.now(),
    });
  }
}
