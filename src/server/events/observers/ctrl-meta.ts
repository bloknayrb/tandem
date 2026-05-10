/** Observer for CTRL_ROOM's Y.Map('documentMeta'). */

import * as Y from "yjs";
import {
  Y_MAP_ACTIVE_DOCUMENT_ID,
  Y_MAP_DOCUMENT_META,
  Y_MAP_OPEN_DOCUMENTS,
} from "../../../shared/constants.js";
import { isUploadPath } from "../../../shared/paths.js";
import { getOpenDocs } from "../../mcp/document-service.js";
import { MCP_ORIGIN } from "../origins.js";
import type { TandemEvent } from "../types.js";
import { generateEventId } from "../types.js";

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

  const metaObs = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (txn.origin === MCP_ORIGIN) return;

    // Check for activeDocumentId change (tab switch)
    if (event.keysChanged.has(Y_MAP_ACTIVE_DOCUMENT_ID)) {
      const activeId = metaMap.get(Y_MAP_ACTIVE_DOCUMENT_ID) as string | undefined;
      if (activeId && activeId !== lastActiveDocId) {
        const openDoc = getOpenDocs().get(activeId);
        // Scratchpad/upload docs are not surfaced to Claude via channel events.
        if (openDoc?.filePath && isUploadPath(openDoc.filePath)) {
          lastActiveDocId = activeId;
          return;
        }
        pushEvent({
          id: generateEventId(),
          type: "document:switched",
          timestamp: Date.now(),
          documentId: activeId,
          payload: {
            fileName: openDoc?.filePath?.split(/[/\\]/).pop() ?? activeId,
          },
        });
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
  return () => metaMap.unobserve(metaObs);
}
