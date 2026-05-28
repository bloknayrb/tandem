import { randomUUID } from "node:crypto";
import fs from "fs/promises";
import path from "path";
import {
  CTRL_ROOM,
  Y_MAP_ACTIVE_DOCUMENT_EPOCH,
  Y_MAP_ACTIVE_DOCUMENT_ID,
  Y_MAP_DOCUMENT_META,
  Y_MAP_GENERATION_ID,
  Y_MAP_OPEN_DOCUMENTS,
  Y_MAP_SAVED_AT_VERSION,
  Y_MAP_STORE_READ_ONLY,
} from "../../shared/constants.js";
import { withFileSync, withInternal, withMcp } from "../../shared/origins.js";
import { generateNotificationId } from "../../shared/utils.js";
import { closeStore } from "../annotations/store.js";
import {
  clearDirtyState,
  isDirty,
  markClean,
  markCleanIfUnchanged,
  snapshotDirtyVersion,
} from "../documents/dirty.js";
import { notifyDocumentPromoted } from "../events/observers/ctrl-meta.js";
import { attachObservers, clearFileSyncContext } from "../events/queue.js";
import { atomicWrite, getAdapter } from "../file-io/index.js";
import { suppressNextChange, unwatchFile } from "../file-watcher.js";
import { assertPathSafe } from "../integrations/apply.js";
import { pushNotification } from "../notifications.js";
import {
  deleteSession,
  listSessionFilePaths,
  loadCtrlSession,
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
  addDoc,
  docCount,
  getActiveDocEpoch,
  getActiveDocId,
  getOpenDocs,
  type OpenDoc,
  removeDoc,
  setActiveDocId,
} from "../documents/registry.js";

export {
  addDoc,
  docCount,
  getActiveDocEpoch,
  getActiveDocId,
  getCurrentDoc,
  getOpenDocs,
  hasDoc,
  type OpenDoc,
  removeDoc,
  requireDocument,
  setActiveDocId,
} from "../documents/registry.js";

/** Internal alias for the registry's view of open docs — used by closures below. */
const openDocs = getOpenDocs();

// --- Disk save ---

/** Per-document save lock to prevent concurrent auto-save + manual save races. */
const savingDocs = new Set<string>();

/** Formats eligible for disk auto-save (adapter.save defined && not binary). */
const AUTO_SAVE_FORMATS = new Set(["md", "txt"]);

export interface SaveResult {
  status: "saved" | "skipped" | "error";
  reason?: string;
  errorCode?: string;
}

/**
 * Save a document to disk. Shared by tandem_save, POST /api/save, and auto-save.
 *
 * Guards:
 * - Only .md and .txt formats (adapter.save defined, see ADR-036)
 * - Not read-only, not upload://
 * - Checks source file mtime to skip if externally modified
 * - Per-document lock prevents concurrent writes
 */
export async function saveDocumentToDisk(
  docId: string,
  source: "auto-save" | "manual" | "mcp" = "auto-save",
): Promise<SaveResult> {
  const docState = openDocs.get(docId);
  if (!docState) return { status: "skipped", reason: "Document not open" };

  // Exclude non-saveable documents
  if (docState.source === "upload") {
    return { status: "skipped", reason: "Upload-only document" };
  }
  if (docState.readOnly) {
    return { status: "skipped", reason: "Read-only document" };
  }
  if (!AUTO_SAVE_FORMATS.has(docState.format)) {
    return { status: "skipped", reason: `Format '${docState.format}' not eligible for disk save` };
  }

  const adapter = getAdapter(docState.format);
  if (!adapter.save) {
    return { status: "skipped", reason: "Adapter cannot save" };
  }

  // Per-document lock
  if (savingDocs.has(docId)) {
    return { status: "skipped", reason: "Save already in progress" };
  }

  savingDocs.add(docId);
  try {
    // Guard against overwriting external modifications
    try {
      const stat = await fs.stat(docState.filePath);
      // Compare to the session's mtime — if the file changed externally, skip
      // We use a 1-second tolerance because fs.watch debounce + atomic rename
      // can cause minor mtime drift
      const meta = getOrCreateDocument(docId).getMap(Y_MAP_DOCUMENT_META);
      const lastSavedAt = meta.get(Y_MAP_SAVED_AT_VERSION) as number | undefined;
      // If the file is newer than our last save, someone else modified it
      if (lastSavedAt && stat.mtimeMs > lastSavedAt + 1000) {
        return { status: "skipped", reason: "File modified externally" };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { status: "skipped", reason: "Source file no longer exists" };
      }
      console.error(`[AutoSave] Unexpected stat error for ${docState.filePath}:`, err);
      return { status: "skipped", reason: `Cannot verify file state: ${code}` };
    }

    const doc = getOrCreateDocument(docId);
    // `adapter.save` was guard-checked above; assert it for the type narrow
    // here. Per ADR-036 a missing `save` means the format is read-only.
    // Snapshot the dirty version BEFORE the async write so a content edit that
    // lands DURING atomicWrite/saveSession isn't lost — markCleanIfUnchanged
    // only clears the flag if no newer edit arrived (#851).
    const dirtySnapshot = snapshotDirtyVersion(docId);
    const output = adapter.save(doc);

    suppressNextChange(docState.filePath);
    await atomicWrite(docState.filePath, output);
    await saveSession(docState.filePath, docState.format, doc);

    // Mark document clean
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    withMcp(doc, () => meta.set(Y_MAP_SAVED_AT_VERSION, Date.now()));
    markCleanIfUnchanged(docId, dirtySnapshot);

    return { status: "saved" };
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
 * Does NOT wire a file watcher for the new path; that's an intentional v1
 * limitation since scratchpads are typically saved to fresh locations and
 * the existing file-watch attach point (`finalizeDocOpen`) is in
 * file-opener.ts. Auto-save still picks the promoted doc up.
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

  // Reject UNC paths on Windows — mirrors openFileByPath's resolveAndValidatePath.
  if (process.platform === "win32" && (resolved.startsWith("\\\\") || resolved.startsWith("//"))) {
    return {
      status: "error",
      reason: "UNC paths are not supported for security reasons.",
      errorCode: "INVALID_PATH",
    };
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
    // pre-arm the watcher suppress so its first change event after we write
    // doesn't bounce back as an external-edit reload. Safe no-op if the path
    // isn't being watched.
    suppressNextChange(resolved);
    await atomicWrite(resolved, output);

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
    addDoc(docId, {
      id: docId,
      filePath: resolved,
      format,
      readOnly: false,
      source: "file",
    });

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
    const { wireAnnotationStore } = await import("./file-opener.js");
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

    // Broadcast the new openDocuments list so every connected tab bar reflects
    // the new basename + format.
    broadcastOpenDocs();

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
        console.error(`[AutoSave] Saved ${path.basename(state.filePath)} to disk`);
      }
    } catch (err) {
      console.error(`[AutoSave] Unexpected error saving ${state.filePath}:`, err);
    }
  }
}

/** Build the document list entry for a single OpenDoc */
export function toDocListEntry(d: OpenDoc) {
  return {
    id: d.id,
    filePath: d.filePath,
    fileName: path.basename(d.filePath),
    format: d.format,
    readOnly: d.readOnly,
  };
}

/** Broadcast the open documents list to connected clients.
 *  Writes to both the bootstrap room (CTRL_ROOM) so new clients discover
 *  docs, and to the active document's room so tab-switching clients stay in sync. */
export function broadcastOpenDocs(): void {
  const docList = Array.from(openDocs.values()).map(toDocListEntry);
  const id = getActiveDocId();
  const epoch = getActiveDocEpoch();

  try {
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    const ctrlMeta = ctrl.getMap(Y_MAP_DOCUMENT_META);
    withInternal(ctrl, () => {
      ctrlMeta.set(Y_MAP_OPEN_DOCUMENTS, docList);
      ctrlMeta.set(Y_MAP_ACTIVE_DOCUMENT_ID, id);
      ctrlMeta.set(Y_MAP_ACTIVE_DOCUMENT_EPOCH, epoch);
    });
  } catch (err) {
    console.error("[Tandem] broadcastOpenDocs: failed to update CTRL_ROOM:", err);
  }

  // Update ALL open doc rooms so no per-doc Y.Doc ever has a stale list.
  for (const [docId] of openDocs) {
    try {
      const ydoc = getOrCreateDocument(docId);
      const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
      withInternal(ydoc, () => {
        meta.set(Y_MAP_OPEN_DOCUMENTS, docList);
        meta.set(Y_MAP_ACTIVE_DOCUMENT_ID, id);
        meta.set(Y_MAP_ACTIVE_DOCUMENT_EPOCH, epoch);
      });
    } catch (err) {
      console.error(`[Tandem] broadcastOpenDocs: failed to update doc ${docId}:`, err);
    }
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
  const docState = openDocs.get(id);
  if (!docState) {
    return { success: false, error: `Document ${id} not found.` };
  }

  const closedPath = docState.filePath;

  // Stop watching for external changes before removing the document
  unwatchFile(docState.filePath);

  // Flush the durable annotation store + drop the per-doc file-sync observer
  // before removing the doc, so a pending debounced write doesn't race with
  // the doc being evicted from Hocuspocus (and the Y.Doc being destroyed).
  // The registry hands back the docHash we stashed at open time so we don't
  // need to recompute it from the file path.
  const dropped = clearFileSyncContext(id);
  if (dropped) {
    try {
      await closeStore(dropped.docHash);
    } catch (err) {
      console.error("[Tandem] closeDocumentById: closeStore failed for %s:", id, err);
    }
  }

  // Clear save lock to prevent a close-reopen race where the old lock blocks new saves
  savingDocs.delete(id);

  // Drop dirty-tracking state + detach its body observer (#851).
  clearDirtyState(id);

  removeDoc(id);

  // Delete the session file so this document doesn't reopen on restart
  try {
    await deleteSession(docState.filePath);
  } catch (err) {
    console.error(`[Tandem] Failed to delete session for ${id}:`, err);
  }

  if (getActiveDocId() === id) {
    const remaining = Array.from(openDocs.keys());
    setActiveDocId(remaining.length > 0 ? remaining[0] : null);
  }

  if (docCount() === 0) {
    stopAutoSave();
  }

  broadcastOpenDocs();

  return { success: true, closedPath, activeDocumentId: getActiveDocId() };
}

/** Save all open sessions (for shutdown handler). */
export async function saveCurrentSession(): Promise<void> {
  for (const [id, state] of openDocs) {
    const doc = getOrCreateDocument(id);
    await saveSession(state.filePath, state.format, doc);
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

/** Write a unique generationId to the ctrl doc so clients can detect server restarts. */
export function writeGenerationId(): void {
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const meta = ctrlDoc.getMap(Y_MAP_DOCUMENT_META);
  const generationId = randomUUID();
  withInternal(ctrlDoc, () => meta.set(Y_MAP_GENERATION_ID, generationId));
  console.error(`[Tandem] Server generationId: ${generationId}`);
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
  // Import dynamically to avoid circular dependency (file-opener imports document-service)
  const { openFileByPath } = await import("./file-opener.js");

  const sessions = await listSessionFilePaths();
  if (sessions.length === 0) return 0;

  let restoredCount = 0;
  for (const { filePath } of sessions) {
    try {
      await openFileByPath(filePath);
      restoredCount++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        console.error(`[Tandem] Skipping deleted file (removing stale session): ${filePath}`);
        deleteSession(filePath).catch((err) => {
          console.error(`[Tandem] Failed to delete stale session for ${filePath}:`, err);
        });
      } else {
        console.error(`[Tandem] Failed to restore ${filePath}:`, err);
      }
    }
  }

  // Restore the previously active document if it was successfully reopened
  if (previousActiveDocId && openDocs.has(previousActiveDocId)) {
    setActiveDocId(previousActiveDocId);
    broadcastOpenDocs();
  }

  if (restoredCount > 0) {
    console.error(`[Tandem] Restored ${restoredCount} document(s) from session`);
  }

  return restoredCount;
}
