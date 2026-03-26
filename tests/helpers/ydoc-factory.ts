import * as Y from "yjs";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { anchoredRange } from "../../src/server/positions.js";

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
  return doc.getXmlFragment("default");
}

/** Create a Y.Doc populated via markdown parser (remark) */
export function makeMarkdownDoc(md: string): Y.Doc {
  const doc = new Y.Doc();
  loadMarkdown(doc, md);
  return doc;
}

/** Shortcut to get the 'annotations' Y.Map */
export function getAnnotationsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("annotations");
}

/** Create an anchored range (flat + CRDT) for annotation creation in tests. */
export function rangeOf(from: number, to: number, ydoc?: Y.Doc) {
  if (ydoc) {
    const result = anchoredRange(ydoc, from, to);
    if (!result.ok) throw new Error("anchoredRange failed in test helper");
    return result;
  }
  return { range: { from, to } };
}
