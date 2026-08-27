import { randomUUID } from "node:crypto";
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import type * as Y from "yjs";
import {
  AUTO_SAVE_FORMATS,
  CHARS_PER_PAGE,
  LARGE_FILE_PAGE_THRESHOLD,
  MAX_FILE_SIZE,
  SUPPORTED_EXTENSIONS,
  VERY_LARGE_FILE_PAGE_THRESHOLD,
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_READ_ONLY,
  Y_MAP_SAVED_AT_VERSION,
} from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import { SCRATCHPAD_PREFIX, UPLOAD_PREFIX } from "../../shared/paths.js";
import type { ExternalConflictState } from "../../shared/types.js";
import { generateNotificationId } from "../../shared/utils.js";
import { rejectUnsafeWindowsPrefix } from "../../shared/windows-path-safety.js";
import { wireAnnotationStore } from "../documents/annotation-wiring.js";
import { flagExternalConflict, readPendingConflict } from "../documents/conflict.js";
import { isDirty, markDirty, registerDirtyObserver } from "../documents/dirty.js";
import {
  clearAndReload,
  loadContentIntoDoc,
  populateDocFromContent,
} from "../documents/populate.js";
import {
  activateDocument,
  broadcastOpenDocs,
  getOpenDocs,
  type OpenDoc,
  openDocument,
  openDocumentWhenReady,
} from "../documents/registry.js";
import {
  acquireReloadGuard,
  isReloadInProgress,
  releaseReloadGuard,
  reloadFromDisk,
  wireFileWatcher,
} from "../documents/watcher.js";
import { docBackupSnapshotPath, snapshotBeforeFirstWrite } from "../file-io/doc-backup.js";
import { assertDocxWithinSizeLimits } from "../file-io/docx-size-gate.js";
import { atomicWrite, atomicWriteBuffer, getAdapter } from "../file-io/index.js";
import { recordSelfWrite, suppressNextChange } from "../file-watcher.js";
import { pushNotification } from "../notifications.js";
import { resolveAppDataDir } from "../platform.js";
import {
  isAutoSaveRunning,
  loadSession,
  narrowConflict,
  restoreYDoc,
  saveSession,
  sessionModelIsStale,
  sourceFileChanged,
  startAutoSave,
} from "../session/manager.js";
import { getDocument, getOrCreateDocument } from "../yjs/provider.js";
import { detectFormat, docIdFromPath, extractText } from "./document-model.js";
import { autoSaveAllToDisk, canSaveToDisk, saveDocumentToDisk } from "./document-service.js";
import { injectTutorialAnnotations } from "./tutorial-annotations.js";

export { SUPPORTED_EXTENSIONS };

export interface OpenFileResult {
  documentId: string;
  filePath: string;
  fileName: string;
  format: string;
  readOnly: boolean;
  source: "file" | "upload";
  tokenEstimate: number;
  pageEstimate: number;
  restoredFromSession: boolean;
  alreadyOpen: boolean;
  forceReloaded: boolean;
  warnings?: string[];
}

/** Resolved + validated path metadata for openFileByPath. stat is NOT included — only used for the size check. */
interface ResolvedPath {
  resolved: string;
  format: string;
  readOnly: boolean;
  id: string;
}

/**
 * Compare two filesystem paths for identity. Case-insensitive on Windows, to
 * match `docIdFromPath`'s lowercasing and the OS's case-insensitive semantics.
 */
function pathsEqual(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Open a file by its absolute path on disk.
 * Throws on errors (ENOENT, EACCES, EBUSY, etc.) — caller maps to MCP or HTTP responses.
 * Pass `force: true` to reload from disk even if already open (clears all document state).
 * Pass `readOnly: true` to force the document open in read-only mode (e.g. CHANGELOG.md).
 */
export async function openFileByPath(
  filePath: string,
  options?: { force?: boolean; readOnly?: boolean },
): Promise<OpenFileResult> {
  const {
    resolved,
    format,
    readOnly: derivedReadOnly,
    id,
  } = await resolveAndValidatePath(filePath);
  // Caller may override the derived readOnly (e.g. force changelog read-only).
  const readOnly = options?.readOnly === true ? true : derivedReadOnly;
  const fileName = path.basename(resolved);
  const openDocs = getOpenDocs();
  let existingId = id;
  let existing = openDocs.get(id);

  // Realpath fallback: after a rename, a doc stays registered under its ORIGINAL
  // path-hash id but now points at `resolved`. `docIdFromPath(resolved)` no
  // longer matches that id, so without this scan openFileByPath would open a
  // DUPLICATE tab of the same file. (Save-As has the same latent property —
  // promote keeps the upload-derived id; this cures both. See #1017.)
  if (!existing) {
    for (const [openId, d] of openDocs) {
      if (d.source === "file" && pathsEqual(d.filePath, resolved)) {
        existingId = openId;
        existing = d;
        break;
      }
    }
  }

  // Already open — force-reload or switch to existing
  if (existing) {
    const forceReload = options?.force === true;
    if (forceReload) {
      // Force-reload stays inline — distinct lifecycle from normal open.
      // Read the buffer here so the fs.readFile sink sits at the call site
      // where `resolved` was just produced by resolveAndValidatePath —
      // CodeQL traces the sanitizer cross-line within a function but not
      // across function boundaries.
      const doc = getDocument(existingId) ?? getOrCreateDocument(existingId);
      const reloadBuffer =
        format === "docx" ? await fs.readFile(resolved) : await fs.readFile(resolved, "utf-8");
      await clearAndReload(existingId, doc, resolved, format, existing, reloadBuffer, {
        readOnly,
      });
      await openDocumentWhenReady(
        { id: existingId, filePath: resolved, format, readOnly, source: "file" },
        async () => {
          await wireAnnotationStore(existingId, doc, resolved);
        },
      );
      ensureAutoSave();
      return {
        ...buildResult(doc, {
          documentId: existingId,
          filePath: resolved,
          fileName,
          format,
          readOnly,
          source: "file",
          restoredFromSession: false,
        }),
        forceReloaded: true,
      };
    }
    return handleAlreadyOpen(
      existingId,
      getOrCreateDocument(existingId),
      format,
      resolved,
      readOnly,
      existing,
      options?.readOnly === true,
    );
  }

  // Normal open
  const doc = getOrCreateDocument(id);
  const restore = await maybeRestoreSession(resolved, doc, fileName, format, readOnly);
  const restoredFromSession = restore.restored;
  if (!restoredFromSession) {
    await loadContentIntoDoc(doc, format, resolved, id);
  }
  await finalizeDocOpen(id, doc, resolved, fileName, format, readOnly);

  // A restored session that carried unsaved edits re-arms the module-state
  // dirty flag (#1069) — it was lost with the previous process. Must run AFTER
  // finalizeDocOpen's registerDirtyObserver. Without this, autosave would skip
  // the restored-but-unpersisted edits, and the watcher would treat the doc as
  // clean and auto-reload over the only copy of them.
  if (restore.sessionDirty) {
    markDirty(id);
  }

  // Restore-vs-reload prompt (#1069, every format since #1238): a restored
  // session carrying unsaved edits diverges from the on-disk file. Flag it
  // AFTER finalizeDocOpen so writeDocMeta's stale-flag tombstone runs first and
  // this fresh detection wins.
  if (restore.unsavedRestore) {
    const { diskChanged, sessionMtime, conflict } = restore.unsavedRestore;
    if (diskChanged && sessionMtime > 0) {
      // The disk file changed UNDER the restored unsaved edits. Hold the save
      // baseline at the SESSION's mtime (overriding initSavedBaseline's
      // current-mtime value) so the explicit-save external-modification guard
      // blocks until the user resolves the banner — "keep" re-baselines to the
      // current mtime, "reload" takes the disk content. Otherwise a habitual
      // Ctrl+S would silently overwrite the external changes.
      //
      // This is belt-and-braces now, and it does NOT reach the carried-conflict
      // case: there, sessionMtime already equals the current disk mtime, so
      // `diskChanged` is false and this never fires. What actually holds the
      // line for a carried conflict is saveDocumentToDisk's flag check.
      const meta = doc.getMap(Y_MAP_DOCUMENT_META);
      withInternal(doc, () => meta.set(Y_MAP_SAVED_AT_VERSION, sessionMtime));
    }
    // A carried flag is re-raised verbatim — relabelling a detected
    // "external-edit" as an "unsaved-restore" would show the user the wrong
    // question about a divergence Tandem had already identified precisely.
    flagExternalConflict(
      id,
      doc,
      resolved,
      conflict ?? {
        kind: "unsaved-restore",
        diskChanged,
        detectedAt: Date.now(),
      },
    );
  }

  // Inject tutorial annotations whenever the sample welcome document is opened,
  // regardless of whether TANDEM_NO_SAMPLE skipped the server startup auto-open.
  // injectTutorialAnnotations is idempotent — safe to call on session-restored docs.
  if (resolved.endsWith(path.join("sample", "welcome.md"))) {
    injectTutorialAnnotations(doc);
  }

  return {
    ...buildResult(doc, {
      documentId: id,
      filePath: resolved,
      fileName,
      format,
      readOnly,
      source: "file",
      restoredFromSession,
    }),
    forceReloaded: false,
  };
}

/**
 * Open a file from uploaded content (no disk path).
 * Used when the browser drag-and-drops or selects a file.
 */
export async function openFileFromContent(
  fileName: string,
  content: string | Buffer,
): Promise<OpenFileResult> {
  const ext = path.extname(fileName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw Object.assign(
      new Error(
        `Unsupported file format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
      ),
      { code: "UNSUPPORTED_FORMAT" },
    );
  }

  const contentSize =
    content instanceof Buffer ? content.length : Buffer.byteLength(content as string);
  if (contentSize > MAX_FILE_SIZE) {
    throw Object.assign(new Error("File exceeds 50MB limit."), { code: "FILE_TOO_LARGE" });
  }

  const format = detectFormat(fileName);
  const readOnly = true;
  const syntheticPath = `${UPLOAD_PREFIX}${randomUUID()}/${fileName}`;
  const id = docIdFromPath(syntheticPath);

  const doc = getOrCreateDocument(id);
  // Display name is the uploaded filename, not the synthetic upload path, so
  // notifications don't leak the internal path shape to the user.
  await populateDocFromContent(doc, format, content, id, {
    displayName: fileName,
    dedupSource: syntheticPath,
  });

  await openDocumentWhenReady(
    { id, filePath: syntheticPath, format, readOnly, source: "upload" },
    async () => {
      writeDocMeta(doc, id, fileName, format, readOnly);
      await initSavedBaseline(doc);
      await wireAnnotationStore(id, doc, syntheticPath);
    },
  );
  ensureAutoSave();

  return buildResult(doc, {
    documentId: id,
    filePath: syntheticPath,
    fileName,
    format,
    readOnly,
    source: "upload",
    restoredFromSession: false,
  });
}

/**
 * Open a new ephemeral scratchpad document.
 *
 * A scratchpad has no file on disk. It uses a synthetic `upload://scratchpad/<uuid>/Scratchpad.md`
 * path, which ensures:
 * - Session manager skips it (isUploadPath filter in listSessionFilePaths)
 * - Auto-save skips it (source === "upload" guard in saveDocumentToDisk / autoSaveAllToDisk)
 * - Recent-files list excludes it (isUploadPath guard in App.svelte)
 *
 * Each call mints a new UUID so closing a scratchpad tab and opening another
 * always yields a fresh empty document. Content is gone when the tab is closed.
 */
export async function openScratchpad(content?: string): Promise<OpenFileResult> {
  const uuid = randomUUID();
  const syntheticPath = `${SCRATCHPAD_PREFIX}${uuid}/Scratchpad.md`;
  const fileName = "Scratchpad.md";
  const format = "md";
  const readOnly = false;
  const id = docIdFromPath(syntheticPath);

  const doc = getOrCreateDocument(id);
  // Optional initial markdown content (#979). Empty (the default) clears the
  // fragment; Tiptap creates a default paragraph on first mount. Structured
  // content is parsed into real blocks via the same markdown adapter. Sync
  // apply inside a single transact preserves the populate path's atomicity
  // invariant (#609). Seeded content is not authorship-stamped — scratchpads are
  // ephemeral (no durable store), so the decorative overlay carries no value.
  const adapter = getAdapter(format);
  const prepared = await adapter.parse(content ?? "");
  withInternal(doc, () => adapter.apply(doc, prepared));

  await openDocumentWhenReady(
    { id, filePath: syntheticPath, format, readOnly, source: "upload" },
    async () => {
      writeDocMeta(doc, id, fileName, format, readOnly);
      await initSavedBaseline(doc);
      // Skip wireAnnotationStore — scratchpads are ephemeral; durable store
      // would leave orphaned JSON files in the annotations directory on close.
    },
  );
  ensureAutoSave();

  return {
    ...buildResult(doc, {
      documentId: id,
      filePath: syntheticPath,
      fileName,
      format,
      readOnly,
      source: "upload",
      restoredFromSession: false,
    }),
    forceReloaded: false,
  };
}

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

// --- Extracted helpers for openFileByPath ---

/** Throw INVALID_PATH if `p` carries a UNC / extended-length / device prefix. */
function assertSafePathPrefix(p: string): void {
  const reason = rejectUnsafeWindowsPrefix(p);
  if (reason) throw Object.assign(new Error(reason), { code: "INVALID_PATH" });
}

/**
 * Resolve a raw file path to its canonical form, validate it (UNC check,
 * extension check, size limit), derive format / readOnly / doc ID.
 * stat is used only for the size check and is not returned.
 */
async function resolveAndValidatePath(filePath: string): Promise<ResolvedPath> {
  // ORDER IS THE POINT. `realpathSync` on `\\evil.com\share\x.md` OPENS the SMB
  // connection — and leaks the NTLM hash — before any post-canonicalization
  // check could reject it, so the UNC gate has to run first, on the raw input
  // and on `path.resolve`'s output.
  //
  // These pre-checks are deliberately NOT gated on `process.platform ===
  // "win32"`, matching `windows-path-safety.ts`'s own header and the four
  // existing ungated call sites (convert.ts, document-service.ts,
  // rename-recovery.ts, node-binary.ts): the path string can reach code that
  // runs on Windows via shared state. The helper also covers `\\?\UNC\…`, which
  // the previous inline two-prefix check did not.
  assertSafePathPrefix(filePath);

  let resolved = path.resolve(filePath);
  assertSafePathPrefix(resolved);

  try {
    resolved = fsSync.realpathSync(resolved);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(
        `[Tandem] realpathSync failed for ${filePath} (${code}), using path.resolve fallback`,
      );
    }
    resolved = path.resolve(filePath);
  }

  // Defense-in-depth, kept deliberately: a Windows junction can canonicalize to
  // a UNC target that neither pre-check could see.
  assertSafePathPrefix(resolved);

  const ext = path.extname(resolved).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw Object.assign(
      new Error(
        `Unsupported file format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
      ),
      { code: "UNSUPPORTED_FORMAT" },
    );
  }

  const stat = await fs.stat(resolved);
  if (stat.size > MAX_FILE_SIZE) {
    throw Object.assign(new Error("File exceeds 50MB limit."), { code: "FILE_TOO_LARGE" });
  }

  const format = detectFormat(resolved);
  // .docx is now editable (#576): edits are held in the Y.Doc and written back
  // to the original on EXPLICIT save (`saveDocumentToDisk` binary branch). The
  // protective layer is "never overwrite without an explicit save", not
  // read-only — so .docx opens writable like .md / .txt. (Auto-save still skips
  // .docx via BINARY_SAVE_FORMATS being disjoint from AUTO_SAVE_FORMATS.)
  const readOnly = false;
  const id = docIdFromPath(resolved);

  return { resolved, format, readOnly, id };
}

/**
 * Handle the non-force already-open branch: activate the doc and broadcast.
 * This is the only place that sets alreadyOpen: true in the return value.
 *
 * If the caller explicitly requests readOnly: true and the existing record
 * is not already read-only, we upgrade the document to read-only in both the
 * open-docs registry and the Y.Doc metadata so clients see the correct flag.
 * We never downgrade an existing readOnly:true document — the explicit signal
 * only upgrades.
 */
function handleAlreadyOpen(
  id: string,
  doc: Y.Doc,
  format: string,
  resolved: string,
  readOnly: boolean,
  existing: OpenDoc,
  explicitReadOnly: boolean,
): OpenFileResult {
  // Upgrade to read-only when explicitly requested and not already read-only.
  // Both branches end in exactly one broadcast: `openDocument` carries the
  // metadata change and the activation together, so the upgrade never
  // publishes an intermediate state.
  if (explicitReadOnly && !existing.readOnly) {
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    withInternal(doc, () => {
      meta.delete(Y_MAP_READ_ONLY);
      meta.set(Y_MAP_READ_ONLY, true);
    });
    openDocument({ ...existing, readOnly: true });
  } else {
    activateDocument(id);
  }
  return {
    ...buildResult(doc, {
      documentId: id,
      filePath: resolved,
      fileName: path.basename(resolved),
      format,
      readOnly,
      source: "file",
      restoredFromSession: false,
    }),
    alreadyOpen: true,
  };
}

/** Result of maybeRestoreSession (#1069, widened in #1238).
 *  - `sessionDirty`: the restored session carried unsaved edits — the caller
 *    re-arms the module-state dirty flag (lost across restarts) so autosave
 *    and the watcher's dirty check see the truth.
 *  - `unsavedRestore`: set when the user must be prompted — the caller surfaces
 *    the restore-vs-reload banner. `sessionMtime` is the on-disk mtime recorded
 *    when the session was saved (0 if it couldn't be stat'd). `conflict` carries
 *    a flag that was already pending at session-save time, so the caller can
 *    re-raise it VERBATIM rather than relabelling an "external-edit" as an
 *    "unsaved-restore". */
interface RestoreResult {
  restored: boolean;
  sessionDirty?: boolean;
  unsavedRestore?: {
    diskChanged: boolean;
    sessionMtime: number;
    conflict?: ExternalConflictState;
  };
}

/**
 * Attempt to restore a Y.Doc from a saved session.
 * `restored` is true ONLY if the session was restored AND the fragment is
 * non-empty. Returns `restored: false` if no session exists, the source file
 * has changed, or the restored fragment is empty (falls back to loading from
 * source file).
 *
 * Exception (#1069, widened to all formats in #1238): a session flagged `dirty`
 * restores EVEN IF the source file changed on disk. That session is the only
 * copy of the user's unsaved edits — dropping it for the disk copy (the old
 * `.md` behaviour) is silent data loss. The caller flags the divergence so the
 * user can choose keep-vs-reload explicitly.
 */
async function maybeRestoreSession(
  resolved: string,
  doc: Y.Doc,
  fileName: string,
  format: string,
  readOnly: boolean,
): Promise<RestoreResult> {
  const session = await loadSession(resolved);
  if (session && sessionModelIsStale(session)) {
    // #1448 W3. Falling through to a fresh parse of the source file, which is
    // the same content read by a load path that no longer damages it. Only
    // clean, on-disk sessions reach here — see `sessionModelIsStale`.
    console.error(
      `[Tandem] Session for ${fileName} predates the current document model; re-reading from the file`,
    );
    return { restored: false };
  }
  if (session) {
    const changed = await sourceFileChanged(session);
    const dirtySession = session.dirty === true;
    if (!changed || dirtySession) {
      restoreYDoc(doc, session);
      const fragment = doc.getXmlFragment("default");
      if (fragment.length > 0) {
        // Two independent reasons to prompt:
        //
        // (a) A conflict was already pending when the session was written.
        //     Carry it across verbatim — it CANNOT be re-derived from
        //     `changed`, because saveSession stats the file at save time, so
        //     sourceFileMtime IS the external write's mtime and
        //     sourceFileChanged reads false on reopen. Without the carry a
        //     restart launders an unresolved conflict away and autosave
        //     overwrites the external file on the next tick.
        //
        // (b) The session holds unpersisted edits that autosave will never
        //     resolve on its own — either the disk also changed, or the format
        //     is not autosaveable (.docx, .html). For an autosaveable format
        //     over an unchanged disk there is nothing to choose: the next tick
        //     persists them. UNLESS the source was deleted or the mtime guard
        //     is already blocking, in which case autosave never runs and the
        //     edits sit unpersisted with no banner. That gap is ACCEPTED, not
        //     handled: both sub-cases are already unreconcilable.
        //
        // `readOnly` gates only (b), the SYNTHESIZED prompt: a read-only doc
        // refuses every save path, so raising a fresh keep-vs-reload choice
        // over restored-but-unpersistable edits is noise.
        //
        // It must NOT gate (a). Suppressing a CARRIED conflict does not defer
        // it, it DESTROYS it: `writeDocMeta` has already tombstoned the flag
        // out of the restored Y.Doc, and the next session write (60s tick or
        // shutdown, neither of which filters read-only docs) rewrites
        // `conflict` from that now-empty Y.Doc. Reopening the same file
        // writable afterwards then finds no flag and autosaves over the
        // external change — the exact laundering the carry exists to prevent,
        // reachable via View Changelog or any `POST /api/open {readOnly:true}`.
        // The banner is not a dead end here either: "Reload from file" is a
        // working branch on a read-only document.
        const carried = narrowConflict(session.conflict);
        const needsPrompt =
          carried !== undefined ||
          (!readOnly && dirtySession && (changed || !AUTO_SAVE_FORMATS.has(format)));
        return {
          restored: true,
          sessionDirty: dirtySession,
          ...(needsPrompt
            ? {
                unsavedRestore: {
                  diskChanged: changed,
                  sessionMtime: session.sourceFileMtime,
                  ...(carried ? { conflict: carried } : {}),
                },
              }
            : {}),
        };
      }
      console.error(
        `[Tandem] Session restore yielded empty doc for ${fileName}, falling back to source file`,
      );
    }
  }
  return { restored: false };
}

/**
 * Finalize a normal (non-force) document open: register in open-docs map,
 * set active, write metadata, init saved baseline, wire annotation store,
 * broadcast, start auto-save, and (for non-docx) set up the file watcher.
 *
 * NOTE: openFileFromContent follows a similar sequence but intentionally omits
 * wireFileWatcher and calls initSavedBaseline without a path argument (upload
 * path — no mtime tracking). These divergences are intentional, not drift.
 */
async function finalizeDocOpen(
  id: string,
  doc: Y.Doc,
  resolved: string,
  fileName: string,
  format: string,
  readOnly: boolean,
): Promise<void> {
  await openDocumentWhenReady(
    { id, filePath: resolved, format, readOnly, source: "file" },
    async () => {
      writeDocMeta(doc, id, fileName, format, readOnly);
      await initSavedBaseline(doc, resolved);
      // Normal first open of a real file — enable rename recovery (#313).
      await wireAnnotationStore(id, doc, resolved, { allowRecovery: true });

      // Register the autosave dirty-tracking observer NOW (#851), after content
      // has been loaded into the body — so the open-time baseline is "clean" and
      // a doc opened to view but never edited never autosaves. Registering here
      // (not only in the Hocuspocus swap path) ensures MCP-only edits
      // (tandem_edit) are tracked even when no browser has connected yet. The
      // observer is keyed by docId in module state and re-registered on swap, so
      // it survives the Y.Doc replacement in onLoadDocument.
      registerDirtyObserver(id, doc);
    },
  );
  ensureAutoSave();

  // Watch for external file changes. Clean docs reload from disk in every
  // format; docs with unsaved edits get a conflict flag instead of an
  // auto-reload (see wireFileWatcher's dirty branch).
  wireFileWatcher(id, resolved, format);
}

// --- Private helpers ---

/**
 * Set the initial savedAtVersion baseline so the client knows the file is clean on open.
 * Uses the file's mtime when available so the first auto-save can detect external modifications.
 */
async function initSavedBaseline(doc: Y.Doc, filePath?: string): Promise<void> {
  let baseline = Date.now();
  if (filePath) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat) baseline = stat.mtimeMs;
  }
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  withInternal(doc, () => meta.set(Y_MAP_SAVED_AT_VERSION, baseline));
}

function writeDocMeta(
  doc: Y.Doc,
  id: string,
  fileName: string,
  format: string,
  readOnly: boolean,
): void {
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  withInternal(doc, () => {
    // Tombstone any session-persisted value so a stale session's higher-clock
    // write can't override the authoritative readOnly passed by the caller.
    // The same delete-before-set pattern is required in handleAlreadyOpen.
    meta.delete(Y_MAP_READ_ONLY);
    meta.set(Y_MAP_READ_ONLY, readOnly);
    meta.set("format", format);
    meta.set("documentId", id);
    meta.set("fileName", fileName);
    // A conflict flag persisted inside a restored session is stale detection
    // state — clear it here; openFileByPath re-flags freshly when the current
    // open actually warrants it (#1069).
    meta.delete(Y_MAP_EXTERNAL_CONFLICT);
  });
}

function buildResult(
  doc: Y.Doc,
  base: Omit<
    OpenFileResult,
    "tokenEstimate" | "pageEstimate" | "alreadyOpen" | "forceReloaded" | "warnings"
  >,
): OpenFileResult {
  const textContent = extractText(doc);
  const textLen = textContent.length;
  const pageEstimate = Math.ceil(textLen / CHARS_PER_PAGE);

  const warnings: string[] = [];
  if (pageEstimate >= VERY_LARGE_FILE_PAGE_THRESHOLD) {
    warnings.push(
      `Very large document (~${pageEstimate} pages). Consider splitting into smaller files.`,
    );
  } else if (pageEstimate >= LARGE_FILE_PAGE_THRESHOLD) {
    warnings.push(`Large document (~${pageEstimate} pages). Operations may be slower than usual.`);
  }

  return {
    ...base,
    tokenEstimate: Math.ceil(textLen / 4),
    pageEstimate,
    alreadyOpen: false,
    forceReloaded: false,
    ...(warnings.length > 0 ? { warnings } : {}),
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
    // (only ever set by openFileByPath / resolveAndValidatePath / a validated
    // rename or save-as) — never raw request input. Same established
    // false-positive class as document-service.ts's FS sinks; dismiss per
    // issue #1042.
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

function ensureAutoSave(): void {
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
