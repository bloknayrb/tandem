import path from "path";
import * as Y from "yjs";
import { getOrCreateDocument, setShouldKeepDocument } from "../yjs/provider.js";
import {
  saveSession,
  deleteSession,
  saveCtrlSession,
  loadCtrlSession,
  restoreCtrlDoc,
  listSessionFilePaths,
  stopAutoSave,
} from "../session/manager.js";
import { CTRL_ROOM, Y_MAP_DOCUMENT_META } from "../../shared/constants.js";
import { MCP_ORIGIN } from "../events/queue.js";
import { randomUUID } from "node:crypto";
import { unwatchFile } from "../file-watcher.js";

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

  // Best-effort persist before removing — save failure should not prevent close
  try {
    const doc = getOrCreateDocument(id);
    await saveSession(docState.filePath, docState.format, doc);
  } catch (err) {
    console.error(`[Tandem] Failed to save session before closing ${id}:`, err);
  }

  removeDoc(id);

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
