/** Each fixture's text as the product extracts it (what quotes are checked against). */
import * as Y from "yjs";

import { loadMarkdown } from "../../../src/server/file-io/markdown.js";
import { extractText } from "../../../src/server/mcp/document-model.js";
import { fixtures } from "./scenarios/index.js";

export function fixtureText(markdown: string): string {
  const doc = new Y.Doc();
  try {
    loadMarkdown(doc, markdown);
    return extractText(doc);
  } finally {
    doc.destroy();
  }
}

export function fixtureTexts(keys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const table = fixtures();
  for (const key of keys) {
    const f = table.get(key);
    if (f) out.set(key, fixtureText(f.markdown));
  }
  return out;
}
