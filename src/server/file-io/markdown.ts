import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import * as Y from "yjs";
import { mdastToYDoc, yDocToMdast } from "./mdast-ydoc.js";

/** Markdown parser shared by production and tests. */
export const mdParser = unified().use(remarkParse).use(remarkGfm).freeze();

const stringifyOptions = {
  bullet: "-",
  emphasis: "*",
  strong: "*",
  listItemIndent: "one",
  rule: "-",
} as const;

/** Parse markdown string and populate a Y.Doc's XmlFragment */
export function loadMarkdown(doc: Y.Doc, markdown: string): void {
  const tree = mdParser.parse(markdown) as Root;
  mdastToYDoc(doc, tree);
}

/** Serialize a Y.Doc's XmlFragment back to markdown */
export function saveMarkdown(doc: Y.Doc): string {
  return serializeMdast(yDocToMdast(doc));
}

/**
 * Serialize an mdast Root tree to markdown using the project's configured
 * serializer. Exposed for tests and any future code path that has an mdast
 * tree but no Y.Doc.
 */
export function serializeMdast(tree: Root): string {
  const refDefs = new Set<string>();
  visit(tree, "definition", (node) => {
    refDefs.add(node.identifier.toLowerCase());
  });

  return unified()
    .use(remarkGfm)
    .use(remarkStringify, {
      ...stringifyOptions,
      handlers: {
        // Call state.safe() first (mirroring the default text handler) so
        // block-context escapes (line-leading `# `, `- `, `> `, fence runs,
        // table pipes, setext underlines) remain intact, then selectively
        // un-escape intra-text noise that the default `unsafe` table over-flags.
        //
        // GFM extensions (autolink-literal `@`/`.`/`:`, strikethrough `~`,
        // table `|`) register no `text` handler and contribute `unsafe` entries
        // that flow through safe() — NOT touched by the post-process regexes
        // below. Do not extend these regexes to those characters.
        text(node, _parent, state, info) {
          let s = state.safe(node.value, info);

          // 1. `\[label]`: un-escape only when `label` is NOT a `definition`
          //    identifier in this tree (otherwise the un-escaped form would
          //    re-parse as a collapsed/full reference link).
          s = s.replace(/\\\[([^\]\n]+)\](?!\s*[:(])/g, (match, label) =>
            refDefs.has(String(label).toLowerCase()) ? match : `[${label}]`,
          );

          // 2. `\_` strictly between word chars: intra-word underscores never
          //    open emphasis in CommonMark/GFM. Punctuation-flanked `_` (e.g.
          //    `(\_foo\_)`) stays escaped — those flanks CAN form emphasis.
          s = s.replace(/(?<=\w)\\_(?=\w)/g, "_");

          // 3. `` \` `` standalone, not adjacent to another backtick. Real code
          //    spans round-trip through the `inlineCode` handler, never `text`.
          s = s.replace(/(?<![`\\])\\`(?!`)/g, "`");

          return s;
        },
      },
    })
    .stringify(tree);
}
