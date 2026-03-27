import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

let hocuspocusInstance: Hocuspocus | null = null;
const documents = new Map<string, Y.Doc>();

// Callback predicate: returns true if Hocuspocus should keep a document in the
// map even after all WebSocket clients disconnect.  Registered by document-service
// to avoid a circular import (provider -> document-service -> provider).
let shouldKeepDocument: ((name: string) => boolean) | null = null;

// Callback for event queue observer lifecycle (registered by events/queue.ts to avoid circular import).
let onDocSwapped: ((docName: string, newDoc: Y.Doc) => void) | null = null;
let onDocUnloaded: ((docName: string) => void) | null = null;

export function setDocLifecycleCallbacks(
  swapped: (docName: string, newDoc: Y.Doc) => void,
  unloaded: (docName: string) => void,
): void {
  onDocSwapped = swapped;
  onDocUnloaded = unloaded;
}

/** Register a predicate that prevents afterUnloadDocument from evicting docs
 *  that MCP (or the bootstrap channel) still needs. */
export function setShouldKeepDocument(fn: (name: string) => boolean): void {
  shouldKeepDocument = fn;
}

/**
 * Get a document by room name. Returns undefined if it doesn't exist.
 */
export function getDocument(name: string): Y.Doc | undefined {
  return documents.get(name);
}

/**
 * Get or create a Y.Doc for the given room name.
 * If Hocuspocus has already created a doc for this room (browser connected first),
 * returns that doc. Otherwise creates a new one that will be merged into the
 * Hocuspocus doc when a browser connects.
 */
export function getOrCreateDocument(name: string): Y.Doc {
  let doc = documents.get(name);
  if (!doc) {
    doc = new Y.Doc();
    documents.set(name, doc);
  }
  return doc;
}

/**
 * Remove a document from the map. Called by afterUnloadDocument when
 * Hocuspocus destroys a room's doc after all clients disconnect.
 */
export function removeDocument(name: string): boolean {
  return documents.delete(name);
}

export async function startHocuspocus(port: number): Promise<Hocuspocus> {
  hocuspocusInstance = new Hocuspocus({
    port,
    address: "127.0.0.1",
    quiet: true, // stdout is the MCP wire — suppress the startup banner

    async onConnect({ request, documentName }) {
      // Origin validation: reject connections not from localhost (prevents DNS rebinding)
      const origin = request?.headers?.origin;
      if (origin) {
        const url = new URL(origin);
        if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
          console.error(`[Hocuspocus] Rejected connection from origin: ${origin}`);
          throw new Error("Connection rejected: invalid origin");
        }
      }
      console.error(`[Hocuspocus] Client connected to: ${documentName}`);
    },

    async onDisconnect({ documentName }) {
      console.error(`[Hocuspocus] Client disconnected from: ${documentName}`);
    },

    async onLoadDocument({ document, documentName }) {
      console.error(`[Hocuspocus] Loading document: ${documentName}`);

      // If MCP tools have already created and populated a doc for this room,
      // merge its state into the Hocuspocus-provided doc, then swap the map entry
      const existing = documents.get(documentName);
      if (existing && existing !== document) {
        const update = Y.encodeStateAsUpdate(existing);
        Y.applyUpdate(document, update);
        existing.destroy();
        console.error(`[Hocuspocus] Merged pre-existing content into document: ${documentName}`);
      }

      // The Hocuspocus-provided doc is now the authoritative instance
      documents.set(documentName, document);

      // Notify event queue to reattach observers to the new doc instance
      onDocSwapped?.(documentName, document);

      return document;
    },

    async afterUnloadDocument({ documentName }) {
      if (shouldKeepDocument?.(documentName)) {
        console.error(`[Hocuspocus] Kept document in map (MCP still tracking): ${documentName}`);
        return;
      }
      if (documents.has(documentName)) {
        onDocUnloaded?.(documentName);
        documents.delete(documentName);
        console.error(`[Hocuspocus] Unloaded document from map: ${documentName}`);
      }
    },
  });

  await hocuspocusInstance.listen();
  return hocuspocusInstance;
}

export function getHocuspocus(): Hocuspocus | null {
  return hocuspocusInstance;
}
