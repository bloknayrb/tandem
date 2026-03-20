import * as Y from 'yjs';
import { populateYDoc } from '../../src/server/mcp/document.js';

/** Create a Y.Doc populated with text content */
export function makeDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  populateYDoc(doc, text);
  return doc;
}

/** Create an empty Y.Doc (XmlFragment exists but has no elements) */
export function makeEmptyDoc(): Y.Doc {
  return new Y.Doc();
}

/** Shortcut to get the 'default' XmlFragment */
export function getFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment('default');
}

/** Shortcut to get the 'annotations' Y.Map */
export function getAnnotationsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('annotations');
}
