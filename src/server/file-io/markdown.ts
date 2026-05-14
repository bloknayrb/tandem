import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import * as Y from "yjs";
import { mdastToYDoc, yDocToMdast } from "./mdast-ydoc.js";

// Populated by saveMarkdown before each stringify call. Single-threaded JS +
// synchronous stringify makes module-level mutation safe; if streaming is ever
// added, this assumption breaks.
const currentRefDefs = new Set<string>();

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
    handlers: {
      // Default `text` handler is literally `state.safe(node.value, info)`
      // (mdast-util-to-markdown/lib/handle/text.js). We call safe() first so
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
          currentRefDefs.has(String(label).toLowerCase()) ? match : `[${label}]`,
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
  .freeze();

/** Parse markdown string and populate a Y.Doc's XmlFragment */
export function loadMarkdown(doc: Y.Doc, markdown: string): void {
  const tree = parser.parse(markdown) as Root;
  mdastToYDoc(doc, tree);
}

/** Serialize a Y.Doc's XmlFragment back to markdown */
export function saveMarkdown(doc: Y.Doc): string {
  const tree = yDocToMdast(doc);
  currentRefDefs.clear();
  visit(tree, "definition", (node) => {
    currentRefDefs.add(node.identifier.toLowerCase());
  });
  return serializer.stringify(tree);
}
