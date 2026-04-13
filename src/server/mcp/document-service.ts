import { randomUUID } from "node:crypto";
import fs from "fs/promises";
import path from "path";
import * as Y from "yjs";
import { CTRL_ROOM, Y_MAP_DOCUMENT_META, Y_MAP_SAVED_AT_VERSION } from "../../shared/constants.js";
import { generateNotificationId } from "../../shared/utils.js";
import { MCP_ORIGIN } from "../events/queue.js";
import { atomicWrite, getAdapter } from "../file-io/index.js";
import { suppressNextChange, unwatchFile } from "../file-watcher.js";
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
import { getOrCreateDocument, setShouldKeepDocument } from "../yjs/provider.js";

// --- Multi-document state ---

export interface OpenDoc {
  id: string;
  filePath: string;
  format: string;
  readOnly: boolean;
  source: "file" | "upload";
}

/** All open documents, keyed by document ID (which is also the Hocuspocus room name) */
const openDocs = new Map<string, OpenDoc>();

// Prevent Hocuspocus from evicting Y.Docs that MCP still tracks as open,
// or the bootstrap channel (CTRL_ROOM) which holds persistent chat history.
setShouldKeepDocument((name) => openDocs.has(name) || name === CTRL_ROOM);

/** The active document ID — tools default to this when no documentId is specified */
let activeDocId: string | null = null;

export function getOpenDocs(): ReadonlyMap<string, OpenDoc> {
  return openDocs;
}

export function addDoc(id: string, entry: OpenDoc): void {
  openDocs.set(id, entry);
}

export function removeDoc(id: string): boolean {
  return openDocs.delete(id);
}

export function hasDoc(id: string): boolean {
  return openDocs.has(id);
}

export function docCount(): number {
  return openDocs.size;
}

export function getActiveDocId(): string | null {
  return activeDocId;
}

export function setActiveDocId(id: string | null): void {
  activeDocId = id;
}

/**
 * Resolve which document to operate on.
 * If documentId is provided, use that. Otherwise use the active doc.
 */
export function getCurrentDoc(documentId?: string) {
  const id = documentId ?? activeDocId;
  if (!id) return null;
  const doc = openDocs.get(id);
  if (!doc) return null;
  return { ...doc, docName: id };
}

/** Returns the shared Y.Doc or null if the target doc isn't open */
export function requireDocument(
  documentId?: string,
): { doc: Y.Doc; filePath: string; docId: string } | null {
  const current = getCurrentDoc(documentId);
  if (!current) return null;
  return {
    doc: getOrCreateDocument(current.docName),
    filePath: current.filePath,
    docId: current.id,
  };
}

// --- Disk save ---

/** Per-document save lock to prevent concurrent auto-save + manual save races. */
const savingDocs = new Set<string>();

/** Formats eligible for disk auto-save (adapter.canSave && not binary). */
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
 * - Only .md and .txt formats (adapter.canSave)
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
  if (!adapter.canSave) {
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
    const output = adapter.save(doc);
    if (output == null) {
      return { status: "skipped", reason: "Adapter returned null" };
    }

    suppressNextChange(docState.filePath);
    await atomicWrite(docState.filePath, output);
    await saveSession(docState.filePath, docState.format, doc);

    // Mark document clean
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    doc.transact(() => meta.set(Y_MAP_SAVED_AT_VERSION, Date.now()), MCP_ORIGIN);

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

/**
 * Auto-save all eligible open documents to disk.
 * Called by the 60-second auto-save timer.
 */
export async function autoSaveAllToDisk(): Promise<void> {
  for (const [docId, state] of openDocs) {
    if (state.source === "upload" || state.readOnly) continue;
    if (!AUTO_SAVE_FORMATS.has(state.format)) continue;
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
  const id = activeDocId;

  try {
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    const ctrlMeta = ctrl.getMap(Y_MAP_DOCUMENT_META);
    ctrl.transact(() => {
      ctrlMeta.set("openDocuments", docList);
      ctrlMeta.set("activeDocumentId", id);
    }, MCP_ORIGIN);
  } catch (err) {
    console.error("[Tandem] broadcastOpenDocs: failed to update CTRL_ROOM:", err);
  }

  // Update ALL open doc rooms so no per-doc Y.Doc ever has a stale list.
  for (const [docId] of openDocs) {
    try {
      const ydoc = getOrCreateDocument(docId);
      const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
      ydoc.transact(() => {
        meta.set("openDocuments", docList);
        meta.set("activeDocumentId", id);
      }, MCP_ORIGIN);
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

  // Clear save lock to prevent a close-reopen race where the old lock blocks new saves
  savingDocs.delete(id);

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
  const previousActiveDocId = (meta.get("activeDocumentId") as string) ?? null;

  // Clear stale document tracking — no docs are actually open after a restart.
  // Chat history is preserved; only the document list is wiped.
  ctrlDoc.transact(() => {
    meta.delete("openDocuments");
    meta.delete("activeDocumentId");
  }, MCP_ORIGIN);

  console.error("[Tandem] Restored chat history from session (cleared stale doc list)");
  return previousActiveDocId;
}

/** Write a unique generationId to the ctrl doc so clients can detect server restarts. */
export function writeGenerationId(): void {
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const meta = ctrlDoc.getMap(Y_MAP_DOCUMENT_META);
  const generationId = randomUUID();
  ctrlDoc.transact(() => meta.set("generationId", generationId), MCP_ORIGIN);
  console.error(`[Tandem] Server generationId: ${generationId}`);
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
