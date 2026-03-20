import { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';

let hocuspocusInstance: Hocuspocus | null = null;
const documents = new Map<string, Y.Doc>();

export function getDocument(name: string): Y.Doc | undefined {
  return documents.get(name);
}

export function getOrCreateDocument(name: string): Y.Doc {
  let doc = documents.get(name);
  if (!doc) {
    doc = new Y.Doc();
    documents.set(name, doc);
  }
  return doc;
}

export async function startHocuspocus(port: number): Promise<Hocuspocus> {
  hocuspocusInstance = new Hocuspocus({
    port,
    address: '127.0.0.1',
    onConnect({ documentName }) {
      console.error(`[Hocuspocus] Client connected to: ${documentName}`);
    },
    onDisconnect({ documentName }) {
      console.error(`[Hocuspocus] Client disconnected from: ${documentName}`);
    },
    async onLoadDocument({ document, documentName }) {
      console.error(`[Hocuspocus] Loading document: ${documentName}`);
      documents.set(documentName, document);
      return document;
    },
  });

  await hocuspocusInstance.listen();
  return hocuspocusInstance;
}

export function getHocuspocus(): Hocuspocus | null {
  return hocuspocusInstance;
}
