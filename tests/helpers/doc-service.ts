/**
 * Shared document-service setup helpers for Cluster B test files:
 * annotation-replies.test.ts and annotation-tools.test.ts.
 *
 * Both files duplicate `setupDoc()` and a `beforeEach` that clears open docs.
 * Centralising here ensures changes propagate everywhere and avoids drift.
 */

import * as Y from "yjs";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { withInternal } from "../../src/shared/origins.js";

/**
 * Creates (or reuses) a Y.Doc for `id`, populates it with `text`, registers
 * it in the document-service, and marks it as the active document.
 *
 * Returns the Y.Doc.
 */
export function setupDoc(
  id: string,
  text: string,
  load: (doc: Y.Doc, text: string) => void = populateYDoc,
) {
  const ydoc = getOrCreateDocument(id);
  load(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  setActiveDocId(id);
  return ydoc;
}

/** `setupDoc` with `text` parsed as markdown by the real loader. */
export function setupMarkdownDoc(id: string, md: string) {
  return setupDoc(id, md, (doc, text) => withInternal(doc, () => loadMarkdown(doc, text)));
}

/**
 * Removes every document from the open-docs registry and clears the active
 * document ID.
 *
 * Call in `beforeEach` to prevent cross-test contamination from the shared
 * document-service singleton.
 */
export function clearOpenDocs(): void {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
}
