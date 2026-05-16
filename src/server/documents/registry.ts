/**
 * Document registry (ADR-033).
 *
 * Owns the multi-document state previously spread across
 * `src/server/mcp/document-service.ts`:
 *   - `openDocs` — the per-tab metadata map (filePath, format, readOnly, source)
 *   - `activeDocId` — which document MCP tools default to
 *   - The keep-alive predicate registered with `provider.ts` (Hocuspocus
 *     won't evict a Y.Doc the registry still tracks)
 *
 * The registry layers ABOVE `provider.ts`'s `documents: Map<string, Y.Doc>`.
 * It does NOT absorb Y.Doc instance storage — `provider.ts` legitimately
 * keeps two classes of entries (tracked-open tabs + Hocuspocus-internal
 * rooms like CTRL_ROOM) that the registry's `OpenDoc` shape cannot model
 * uniformly. See ADR-033 § "Options considered" (a) vs (b).
 *
 * Save/auto-save, broadcast, and session-restore concerns stay in
 * `document-service.ts` for now — this PR is a minimal seam extraction.
 * A follow-up PR (#4 in the plan) moves the file-open pipeline; another
 * follow-up moves save/auto-save into a dedicated module.
 */

import type * as Y from "yjs";
import { CTRL_ROOM } from "../../shared/constants.js";
import { getOrCreateDocument, setShouldKeepDocument } from "../yjs/provider.js";

export interface OpenDoc {
  id: string;
  filePath: string;
  format: string;
  readOnly: boolean;
  source: "file" | "upload";
}

/** All open documents, keyed by document ID (which is also the Hocuspocus room name). */
const openDocs = new Map<string, OpenDoc>();

/** The active document ID — tools default to this when no documentId is specified. */
let activeDocId: string | null = null;

// Prevent Hocuspocus from evicting Y.Docs that MCP still tracks as open,
// or the bootstrap channel (CTRL_ROOM) which holds persistent chat history.
setShouldKeepDocument((name) => openDocs.has(name) || name === CTRL_ROOM);

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
export function getCurrentDoc(documentId?: string): (OpenDoc & { docName: string }) | null {
  const id = documentId ?? activeDocId;
  if (!id) return null;
  const doc = openDocs.get(id);
  if (!doc) return null;
  return { ...doc, docName: id };
}

/** Returns the shared Y.Doc or null if the target doc isn't open. */
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
