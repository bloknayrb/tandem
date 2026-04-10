import * as Y from "yjs";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import type { Root } from "mdast";
import { mdastToYDoc, yDocToMdast } from "./mdast-ydoc.js";

// Cached processors — stateless and safe to reuse across calls
const parser = unified().use(remarkParse).use(remarkGfm).freeze();
const serializer = unified()
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: "-",
    emphasis: "*",
    strong: "*",
    listItemIndent: "one",
    rule: "-",
  })
  .freeze();

/** Parse markdown string and populate a Y.Doc's XmlFragment */
export function loadMarkdown(doc: Y.Doc, markdown: string): void {
  const tree = parser.parse(markdown) as Root;
  mdastToYDoc(doc, tree);
}

/** Serialize a Y.Doc's XmlFragment back to markdown */
export function saveMarkdown(doc: Y.Doc): string {
  const tree = yDocToMdast(doc);
  return serializer.stringify(tree);
}
