/** Observer for CTRL_ROOM's Y.Map('documentMeta'). */

import * as Y from "yjs";
import {
  Y_MAP_ACTIVE_DOCUMENT_ID,
  Y_MAP_DOCUMENT_META,
  Y_MAP_OPEN_DOCUMENTS,
} from "../../../shared/constants.js";
import { shouldSkipChannel } from "../../../shared/origins.js";
import { isUploadPath } from "../../../shared/paths.js";
import { getOpenDocs } from "../../mcp/document-service.js";
import type { DocumentOpenedPayload, TandemEvent } from "../types.js";
import { generateEventId } from "../types.js";

/**
 * Module-level hook the active observer registers so non-observer code (e.g.
 * scratchpad save-as promotion in document-service.ts) can tell the observer
 * "this upload doc is now a real file." `null` when no observer is attached.
 *
 * A scratchpad/upload doc was added to the observer's private `uploadDocIds`
 * set on open, so its lifecycle events are normally suppressed (Claude never
 * sees ephemeral scratch notes). When such a doc is promoted to a real on-disk
 * path it SHOULD become Claude-visible — this hook clears it from the set and
 * emits a synthetic `document:opened` so the channel surfaces the now-real file.
 */
let promoteHook: ((docId: string, payload: DocumentOpenedPayload) => void) | null = null;

/**
 * Notify the active ctrl-meta observer that an upload/scratchpad doc has been
 * promoted to a real file. No-op if no observer is attached. Safe to call from
 * outside the observer module.
 */
export function notifyDocumentPromoted(docId: string, payload: DocumentOpenedPayload): void {
  promoteHook?.(docId, payload);
}

export function makeCtrlMetaObserver(deps: {
  ctrlDoc: Y.Doc;
  pushEvent: (e: TandemEvent) => void;
}): () => void {
  const { ctrlDoc, pushEvent } = deps;
  const metaMap = ctrlDoc.getMap(Y_MAP_DOCUMENT_META);
  let lastActiveDocId: string | null = null;
  let lastOpenDocIds = new Set<string>();
  // Track upload/scratchpad doc IDs so we can suppress their close events
  // (the doc is already removed from getOpenDocs() by the time the observer fires).
  const uploadDocIds = new Set<string>();

  // Register the promote hook so document-service can flip a promoted upload
  // doc to Claude-visible. Clearing the ID from `uploadDocIds` ensures the
  // doc's later close event also fires (it's a real file now), and the
  // synthetic `document:opened` makes the now-real file readable by Claude.
  promoteHook = (docId, payload) => {
    if (!uploadDocIds.has(docId)) return; // not tracked as upload, or already promoted
    uploadDocIds.delete(docId);
    pushEvent({
      id: generateEventId(),
      type: "document:opened",
      timestamp: Date.now(),
      documentId: docId,
      payload,
    });
  };

  const metaObs = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (shouldSkipChannel(txn.origin)) return;

    // Check for activeDocumentId change (tab switch)
    if (event.keysChanged.has(Y_MAP_ACTIVE_DOCUMENT_ID)) {
      const activeId = metaMap.get(Y_MAP_ACTIVE_DOCUMENT_ID) as string | undefined;
      if (activeId && activeId !== lastActiveDocId) {
        const openDoc = getOpenDocs().get(activeId);
        // Scratchpad/upload docs are not surfaced to Claude via channel events.
        // Update lastActiveDocId regardless so the next non-upload switch still fires,
        // but don't `return` — the openDocuments branch below must still run in case
        // the same transaction mutated both keys (e.g. open-and-activate atomically).
        const isUploadSwitch = openDoc?.filePath ? isUploadPath(openDoc.filePath) : false;
        if (!isUploadSwitch) {
          pushEvent({
            id: generateEventId(),
            type: "document:switched",
            timestamp: Date.now(),
            documentId: activeId,
            payload: {
              fileName: openDoc?.filePath?.split(/[/\\]/).pop() ?? activeId,
            },
          });
        }
        lastActiveDocId = activeId;
      }
    }

    // Check for openDocuments change (doc open/close)
    if (event.keysChanged.has(Y_MAP_OPEN_DOCUMENTS)) {
      const docList =
        (metaMap.get(Y_MAP_OPEN_DOCUMENTS) as Array<{ id: string; fileName?: string }>) ?? [];
      const currentIds = new Set(docList.map((d) => d.id));

      // Newly opened
      for (const doc of docList) {
        if (!lastOpenDocIds.has(doc.id)) {
          const openDoc = getOpenDocs().get(doc.id);
          // Scratchpad/upload docs are not surfaced to Claude via channel events.
          // Track the ID so we can suppress the corresponding close event too.
          if (openDoc?.filePath && isUploadPath(openDoc.filePath)) {
            uploadDocIds.add(doc.id);
            continue;
          }
          pushEvent({
            id: generateEventId(),
            type: "document:opened",
            timestamp: Date.now(),
            documentId: doc.id,
            payload: {
              fileName: doc.fileName ?? openDoc?.filePath?.split(/[/\\]/).pop() ?? doc.id,
              format: openDoc?.format ?? "unknown",
            },
          });
        }
      }

      // Closed
      for (const oldId of lastOpenDocIds) {
        if (!currentIds.has(oldId)) {
          if (uploadDocIds.has(oldId)) {
            // Scratchpad/upload docs are not surfaced to Claude via channel events.
            uploadDocIds.delete(oldId);
            continue;
          }
          pushEvent({
            id: generateEventId(),
            type: "document:closed",
            timestamp: Date.now(),
            documentId: oldId,
            payload: {
              fileName: oldId,
            },
          });
        }
      }

      lastOpenDocIds = currentIds;
    }
  };

  metaMap.observe(metaObs);
  return () => {
    metaMap.unobserve(metaObs);
    promoteHook = null;
  };
}
