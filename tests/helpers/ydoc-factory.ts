import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import * as Y from "yjs";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { anchoredRange } from "../../src/server/positions.js";
import type { Annotation } from "../../src/shared/types.js";

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
  return doc.getMap(Y_MAP_ANNOTATIONS);
}

/** Create a test annotation with sensible defaults and optional overrides. */
export function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann_test_001",
    author: "claude",
    type: "comment",
    range: { from: 0, to: 5 },
    content: "test",
    status: "pending",
    timestamp: Date.now(),
    ...overrides,
  };
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
