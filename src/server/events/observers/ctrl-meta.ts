/** Observer for CTRL_ROOM's Y.Map('documentMeta'). */

import * as Y from "yjs";
import { Y_MAP_DOCUMENT_META } from "../../../shared/constants.js";
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

  const metaObs = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (txn.origin === MCP_ORIGIN) return;

    // Check for activeDocumentId change (tab switch)
    if (event.keysChanged.has("activeDocumentId")) {
      const activeId = metaMap.get("activeDocumentId") as string | undefined;
      if (activeId && activeId !== lastActiveDocId) {
        const openDoc = getOpenDocs().get(activeId);
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
    if (event.keysChanged.has("openDocuments")) {
      const docList =
        (metaMap.get("openDocuments") as Array<{ id: string; fileName?: string }>) ?? [];
      const currentIds = new Set(docList.map((d) => d.id));

      // Newly opened
      for (const doc of docList) {
        if (!lastOpenDocIds.has(doc.id)) {
          const openDoc = getOpenDocs().get(doc.id);
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
