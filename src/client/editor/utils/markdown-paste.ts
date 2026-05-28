// Convert pasted raw markdown text into formatted rich-text ProseMirror nodes.
//
// Tandem's editor uses Tiptap's StarterKit schema (node/mark names like
// `paragraph`, `heading`, `bulletList`, `bold`). The CommonMark schema shipped
// with `prosemirror-markdown` uses different names (`bullet_list`, `strong`,
// `em`, ...), so we cannot reuse `defaultMarkdownParser` directly. Instead we
// build a `MarkdownParser` over the editor's *live* schema with a token map
// keyed to Tiptap's node/mark names.
//
// Why this lives in a util (not the Editor component): it is pure, schema-in /
// node-out, and unit-testable without a DOM. The Editor wires it into
// `editorProps.clipboardTextParser` and dispatches a normal ProseMirror
// transaction so y-prosemirror's sync plugin captures the change — we never
// write to the Y.Doc directly (CLAUDE.md gotcha).

import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { Slice } from "@tiptap/pm/model";
import MarkdownIt from "markdown-it";
import type { ParseSpec } from "prosemirror-markdown";
import { MarkdownParser } from "prosemirror-markdown";
import { sanitizeHrefForPaste } from "./url-safety";

// Link-href sanitization uses the shared ALLOWLIST in ./url-safety.ts
// (http://, https://, mailto:, ftp://, //, plus fragments and relative
// paths). The Editor's click-time anchor intercept uses the same allowlist
// via isSafeExternalHref — one source of truth means a new XSS-relevant
// scheme rejected by the click-time check is automatically rejected at
// paste time too (no drift between the two defense layers).

/**
 * markdown-it token -> Tiptap schema entity map.
 *
 * Scope (per issue #788): paragraphs, headings, bold/italic/code/strike, links,
 * bullet/ordered lists, blockquotes, fenced code blocks. Images, tables, and
 * other unmapped block-level tokens are silently dropped via `ignore: true`
 * (#885 follow-up). Without an explicit `ignore`, the prosemirror-markdown
 * `MarkdownParser` throws `Token type 'image' not supported by parser` and the
 * caller falls back to plain text — losing ALL the user's surrounding
 * formatting just because the pasted snippet happens to mention an image.
 */
function buildTokenSpec(schema: Schema): { [name: string]: ParseSpec } {
  const tokens: { [name: string]: ParseSpec } = {
    blockquote: { block: "blockquote" },
    paragraph: { block: "paragraph" },
    list_item: { block: "listItem" },
    bullet_list: { block: "bulletList" },
    ordered_list: {
      block: "orderedList",
      getAttrs: (tok) => ({ start: +(tok.attrGet("start") ?? 1) || 1 }),
    },
    heading: {
      block: "heading",
      getAttrs: (tok) => ({ level: +tok.tag.slice(1) }),
    },
    code_block: {
      block: "codeBlock",
      noCloseToken: true,
      getAttrs: (tok) => ({ language: tok.info?.trim() || null }),
    },
    fence: {
      block: "codeBlock",
      noCloseToken: true,
      getAttrs: (tok) => ({ language: tok.info?.trim() || null }),
    },
    hr: { node: "horizontalRule" },
    hardbreak: { node: "hardBreak" },
    // markdown-it emits softbreak for an in-paragraph line break in the
    // source. There's no Tiptap equivalent (StarterKit collapses these to
    // spaces during DOM serialization anyway); drop the token cleanly so it
    // doesn't surface as an "unsupported token" parser error. `noCloseToken`
    // is required because softbreak/html_inline/html_block/image are emitted
    // as single tokens (no `_open`/`_close` pair) — without it,
    // prosemirror-markdown would register `softbreak_open`/`_close` handlers
    // that never fire and the bare `softbreak` token still throws.
    softbreak: { ignore: true, noCloseToken: true },
    // `html: false` causes markdown-it to emit raw HTML as text tokens — but
    // some plugins still surface html_block/html_inline tokens for things
    // like comments. Ignore them defensively so the parser doesn't throw.
    html_block: { ignore: true, noCloseToken: true },
    html_inline: { ignore: true, noCloseToken: true },
    // Images are tokens, not text — without an explicit mapping the parser
    // would throw. We ignore (drop alt text + URL) rather than addText
    // because Tiptap's image node is optional in StarterKit and we don't
    // want to depend on it being present.
    image: { ignore: true, noCloseToken: true },
    em: { mark: "italic" },
    strong: { mark: "bold" },
    s: { mark: "strike" },
    code_inline: { mark: "code", noCloseToken: true },
    link: {
      mark: "link",
      getAttrs: (tok) => ({
        // sanitizeHrefForPaste rejects any unknown scheme (allowlist-based)
        // so a crafted markdown link can't smuggle an XSS payload through
        // paste. `html: false` on the tokenizer is the inline-HTML guard;
        // this is the link-target guard. Both are load-bearing.
        href: sanitizeHrefForPaste(tok.attrGet("href")),
        title: tok.attrGet("title") || null,
      }),
    },
  };

  // Only keep mappings whose target node/mark actually exists in the schema.
  // StarterKit always provides these, but guarding keeps the parser from
  // throwing if the editor schema is ever trimmed.
  const filtered: { [name: string]: ParseSpec } = {};
  for (const [name, spec] of Object.entries(tokens)) {
    if (spec.node && !schema.nodes[spec.node]) continue;
    if (spec.block && !schema.nodes[spec.block]) continue;
    if (spec.mark && !schema.marks[spec.mark]) continue;
    filtered[name] = spec;
  }
  return filtered;
}

/**
 * Create a `MarkdownParser` bound to the given editor schema. The markdown-it
 * tokenizer enables GFM-ish features (strikethrough via `~~`, autolinks) while
 * disabling HTML passthrough so pasted `<script>`-style markup is treated as
 * literal text rather than raw HTML.
 */
export function createMarkdownParser(schema: Schema): MarkdownParser {
  const tokenizer = MarkdownIt("commonmark", { html: false }).enable(["strikethrough", "linkify"]);
  return new MarkdownParser(schema, tokenizer, buildTokenSpec(schema));
}

/**
 * Heuristic: does this pasted text look like markdown worth converting?
 *
 * We deliberately err toward NOT converting: plain prose should paste as
 * plain text. We only treat text as markdown when it contains a structural
 * or inline marker that markdown-it would meaningfully transform. Single-line
 * text with no markers returns false so ordinary paste behavior is preserved.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;

  // Block-level markers (anchored to line starts).
  const blockPattern =
    /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/m;
  if (blockPattern.test(text)) return true;

  // Inline markers: bold/italic, inline code, strikethrough, or a markdown
  // link [text](url). Emphasis markers require a non-space character adjacent
  // to the delimiter (CommonMark flanking rule) so spaced asterisks like
  // "a * b * c" are NOT mistaken for emphasis.
  const inlinePattern =
    /(\*\*\S(?:[^*\n]*\S)?\*\*|__\S(?:[^_\n]*\S)?__|\*\S(?:[^*\n]*\S)?\*|`[^`\n]+`|~~\S(?:[^~\n]*\S)?~~|\[[^\]\n]+\]\([^)\n]+\))/;
  if (inlinePattern.test(text)) return true;

  return false;
}

/**
 * Parse markdown `text` into a ProseMirror `Slice` against `schema`, suitable
 * for `editorProps.clipboardTextParser`. Returns `null` when the text does not
 * look like markdown OR when parsing produces nothing meaningful, signaling the
 * caller to fall back to normal plain-text paste.
 *
 * The slice is created with `Slice.maxOpen`, which opens both ends as far as
 * the content allows. This is what makes inline-only markdown merge into the
 * surrounding paragraph (pasting `**bold**` mid-sentence yields inline bold,
 * not a new paragraph) while block-level markdown (headings, lists, ...) still
 * pastes as its own blocks. A fully-closed slice would instead split the
 * paragraph at the cursor for every paste.
 */
export function markdownToSlice(text: string, schema: Schema): Slice | null {
  if (!looksLikeMarkdown(text)) return null;

  let doc: ProseMirrorNode;
  try {
    const parser = createMarkdownParser(schema);
    const parsed = parser.parse(text);
    if (!parsed) return null;
    doc = parsed;
  } catch {
    // Malformed markdown / tokenizer error — fall back to plain text.
    return null;
  }

  // Empty parse (e.g. text that was all whitespace) — nothing to paste; let
  // the default plain-text path handle it.
  if (doc.childCount === 0) return null;

  return Slice.maxOpen(doc.content);
}
