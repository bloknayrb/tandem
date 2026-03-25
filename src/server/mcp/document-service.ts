import path from "path";
import * as Y from "yjs";
import { getOrCreateDocument, setShouldKeepDocument } from "../yjs/provider.js";
import {
  saveSession,
  saveCtrlSession,
  loadCtrlSession,
  restoreCtrlDoc,
} from "../session/manager.js";
import { CTRL_ROOM } from "../../shared/constants.js";

// --- Multi-document state ---

export interface OpenDoc {
  id: string;
  filePath: string;
  format: string;
  readOnly: boolean;
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
  try {
    const docList = Array.from(openDocs.values()).map(toDocListEntry);
    const id = activeDocId;

    const ctrl = getOrCreateDocument(CTRL_ROOM);
    const ctrlMeta = ctrl.getMap("documentMeta");
    ctrlMeta.set("openDocuments", docList);
    ctrlMeta.set("activeDocumentId", id);

    if (id) {
      const ydoc = getOrCreateDocument(id);
      const meta = ydoc.getMap("documentMeta");
      meta.set("openDocuments", docList);
      meta.set("activeDocumentId", id);
    }
  } catch (err) {
    console.error("[Tandem] broadcastOpenDocs error:", err);
  }
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

/** Restore CTRL_ROOM chat history from session file if available. */
export async function restoreCtrlSession(): Promise<void> {
  const saved = await loadCtrlSession();
  if (saved) {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    restoreCtrlDoc(ctrlDoc, saved);

    // Clear stale document tracking — no docs are actually open after a restart.
    // Chat history is preserved; only the document list is wiped.
    const meta = ctrlDoc.getMap("documentMeta");
    meta.delete("openDocuments");
    meta.delete("activeDocumentId");

    console.error("[Tandem] Restored chat history from session (cleared stale doc list)");
  }
}
