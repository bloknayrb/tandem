import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import * as Y from "yjs";
import { mdastToYDoc, yDocToMdast } from "./mdast-ydoc.js";

/**
 * Normalize a reference label to mdast's canonical form (whitespace collapsed,
 * trimmed, lowercased). Matches what `mdast-util-from-markdown` stores in
 * `definition.identifier`. We don't use `micromark-util-normalize-identifier`
 * because that utility ends in `.toUpperCase()` while mdast's stored
 * `identifier` is lowercase.
 */
function normalizeLabel(s: string): string {
  return s
    .replace(/[\t\n\r ]+/g, " ")
    .trim()
    .toLowerCase();
}

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
  // Collect ref-def identifiers (already lowercase + whitespace-collapsed by
  // mdast/from-markdown). We re-normalize the labels we pull from text nodes
  // below before comparison.
  const refDefs = new Set<string>();
  visit(tree, "definition", (node) => {
    refDefs.add(node.identifier);
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
        // GFM extensions (autolink-literal `@`/`.`/`:`, strikethrough `~~`,
        // table `|`) register no `text` handler and contribute `unsafe` entries
        // that flow through safe(). Of those, only `~` is un-escaped below
        // (single `~` is harmless because GFM strikethrough requires `~~`).
        text(node, _parent, state, info) {
          let s = state.safe(node.value, info);

          // Will the next sibling's serialized output start with `[`? If yes,
          // a `\[label]` at the end of our text node must stay escaped — the
          // un-escaped `[label][...]` would be parsed as a full reference link.
          const nextStartsBracket = typeof info.after === "string" && info.after.startsWith("[");

          // 1. `\[label]`: un-escape only when `label` does NOT match any
          //    `definition` identifier in this tree (otherwise the un-escaped
          //    form would re-parse as a collapsed/full reference link).
          //    `label` is normalized per CommonMark before comparison.
          //    Negative lookahead also rejects an immediately following `[`
          //    inside this text node.
          //    The label character class excludes `\` to keep matching linear
          //    on adversarial input like `\[\[\[\[\[…`.
          s = s.replace(/\\\[([^\\\]\n`]+)\](?!\s*[:([])/g, (match, label, offset) => {
            const atEnd = offset + match.length === s.length;
            if (atEnd && nextStartsBracket) return match;
            return refDefs.has(normalizeLabel(label)) ? match : `[${label}]`;
          });

          // 2. `\_` strictly between word chars: intra-word underscores never
          //    open emphasis in CommonMark/GFM. Punctuation-flanked `_` (e.g.
          //    `(\_foo\_)`) stays escaped — those flanks CAN form emphasis.
          s = s.replace(/(?<=\w)\\_(?=\w)/g, "_");

          // 3. `` \` `` standalone, not adjacent to another backtick. Real code
          //    spans round-trip through the `inlineCode` handler, never `text`.
          s = s.replace(/(?<![`\\])\\`(?!`)/g, "`");

          // 4. `\~` not followed by another `~`. GFM strikethrough needs `~~`
          //    so a lone `~` is unambiguous prose (e.g. `~4500 tokens`).
          s = s.replace(/\\~(?!~)/g, "~");

          return s;
        },
      },
    })
    .stringify(tree);
}
