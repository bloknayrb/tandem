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
import { sanitizeHrefForPaste, sanitizeImageSrcForPaste } from "./url-safety";

// Link-href sanitization uses the shared ALLOWLIST in ./url-safety.ts
// (http://, https://, mailto:, ftp://, //, plus fragments and relative
// paths). The Editor's click-time anchor intercept uses the same allowlist
// via isSafeExternalHref — one source of truth means a new XSS-relevant
// scheme rejected by the click-time check is automatically rejected at
// paste time too (no drift between the two defense layers). Image sources
// go through the sibling allowlist `sanitizeImageSrcForPaste` (same file) —
// see `normalizeImagesForPaste` below.

/**
 * Minimal structural types for the markdown-it tokens/state our core-ruler
 * plugins (below) read and write. Deliberately NOT importing markdown-it's
 * own `Token`/`StateCore` types — deep subpath type imports through
 * `@types/markdown-it` are fragile under `moduleResolution: "bundler"`. This
 * local shape covers exactly the members we touch and is structurally
 * compatible with the real runtime objects markdown-it constructs.
 */
interface MdToken {
  type: string;
  tag: string;
  nesting: 0 | 1 | -1;
  content: string;
  children: MdToken[] | null;
  attrGet(name: string): string | null;
}

interface MdCoreState {
  tokens: MdToken[];
  Token: new (type: string, tag: string, nesting: 0 | 1 | -1) => MdToken;
}

/**
 * Core-ruler plugin: wraps each table cell's flat `inline` token in a
 * `paragraph_open`/`paragraph_close` pair.
 *
 * Tiptap's `tableHeader`/`tableCell` nodes are `block+` (they must contain
 * block nodes, e.g. `paragraph`), but markdown-it's table rule emits inline
 * content directly inside `th`/`td` — `th_open, inline, th_close` with no
 * wrapping block. Handed straight to `MarkdownParser`, `createAndFill` can't
 * place inline content into a `block+` node and returns null, silently
 * dropping the cell. GFM pipe-table cells are always single-line (no nested
 * block content is possible in the syntax), so `th_open`/`td_open` is always
 * immediately followed by exactly one `inline` token — a fixed pattern safe
 * to pattern-match without a general tree walk.
 *
 * Registered on the `core` ruler (not `block`) so it runs once over the
 * final flat token stream, after the default `inline` core rule has already
 * decided token boundaries — flat-array splicing is simplest to do as a
 * dedicated pass rather than threading paragraph-wrapping into the table
 * block rule itself (which we don't own).
 */
function wrapCellParagraphs(state: MdCoreState): void {
  const tokens = state.tokens;
  const out: MdToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    out.push(tok);
    if ((tok.type === "th_open" || tok.type === "td_open") && tokens[i + 1]?.type === "inline") {
      const open = new state.Token("paragraph_open", "p", 1);
      const close = new state.Token("paragraph_close", "p", -1);
      out.push(open, tokens[i + 1], close);
      i += 1; // the inline token was consumed directly above; don't re-push it
    }
  }
  state.tokens = out;
}

/** True when an inline `image` token's `src` passes the paste-time allowlist. */
function isSafeImageToken(tok: MdToken): boolean {
  return sanitizeImageSrcForPaste(tok.attrGet("src")) != null;
}

/**
 * Build a plain-text fallback token carrying an image's alt text, for images
 * we can't render as-is (unsafe src, or mixed with other inline content — see
 * `normalizeImagesForPaste`). `tok.content` is the image's raw label source
 * (markdown-it stores it pre-inline-parse on the `image` token itself), which
 * is exactly the `alt` text for the common case of a plain-text label.
 */
function imageFallbackToken(state: MdCoreState, tok: MdToken): MdToken {
  const fallback = new state.Token("text", "", 0);
  fallback.content = tok.content || tok.attrGet("alt") || "";
  return fallback;
}

/**
 * Core-ruler plugin: makes pasted markdown images renderable against a
 * schema where the `image` node is BLOCK-level (`editor-extensions.ts`,
 * `Image.configure({ allowBase64: true })` — default `inline: false`) while
 * markdown-it emits `image` as an INLINE token nested inside `inline`
 * tokens' `children` arrays.
 *
 * A paragraph whose ENTIRE inline content is a single SAFE image (passes
 * {@link isSafeImageToken}) is promoted — mirroring the server's
 * `splitParagraphImages`, `src/server/file-io/mdast-ydoc.ts` — from
 * `paragraph_open, inline({children:[image]}), paragraph_close` to a bare
 * block-level `image` token, UNLESS that paragraph sits inside a table cell
 * (`cellDepth > 0`, tracked below). A hoisted `tableCell > image` is a shape
 * the server's save path silently drops: `cellToPhrasingContent`
 * (`src/server/file-io/mdast-ydoc.ts`) discards any non-`paragraph` cell
 * child whose plain text is empty, so `plainTextFromElement` sees nothing
 * and the whole cell chunk is dropped — the image would paste correctly and
 * then vanish from the file on the very next save. Inside a cell we instead
 * fall through to the same downgrade-to-alt-text path used for a
 * mixed-content paragraph: it survives save, which the hoisted shape does
 * not. Every other image — unsafe src, or sitting alongside other inline
 * content in its paragraph — is downgraded in place to its alt-text
 * fallback: our `image` node can't be a paragraph's inline child, so
 * leaving it in place would make `createAndFill` return null and silently
 * drop the WHOLE paragraph — a regression versus "drop the image, keep the
 * text" (see the #885 follow-up test in markdown-paste.test.ts). Per-child
 * safety only matters for the solo-hoist decision: a mixed paragraph
 * downgrades its images regardless of safety either way.
 *
 * Accepted limitation (F5, not fixed): a solo image hoisted inside a
 * `listItem` (not a table cell) yields `listItem(paragraph(empty), image)`
 * — the client `listItem` node requires a `paragraph` head, so
 * `createAndFill` inserts an empty one alongside the hoisted `image`. Left
 * alone deliberately: downgrading loses the image entirely (worse), and the
 * server's own `.docx` import path independently produces `listItem >
 * image` — the two shapes converge after a save/reload round-trip anyway.
 */
function normalizeImagesForPaste(state: MdCoreState): void {
  const tokens = state.tokens;
  const out: MdToken[] = [];
  // Tracks whether the token currently being visited is nested inside a
  // table cell (`th`/`td`). Incremented/decremented on the cell open/close
  // tokens themselves, before the paragraph_open hoist check below, so by
  // the time we reach a cell's paragraph_open the depth already reflects
  // "inside a cell." GFM cells never nest (no cell-within-cell), so a plain
  // counter — rather than a stack — is sufficient.
  let cellDepth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === "th_open" || tok.type === "td_open") {
      cellDepth++;
    } else if (tok.type === "th_close" || tok.type === "td_close") {
      cellDepth--;
    }
    if (tok.type === "paragraph_open" && cellDepth === 0) {
      const inlineTok = tokens[i + 1];
      const closeTok = tokens[i + 2];
      if (inlineTok?.type === "inline" && closeTok?.type === "paragraph_close") {
        const children = inlineTok.children ?? [];
        if (
          children.length === 1 &&
          children[0].type === "image" &&
          isSafeImageToken(children[0])
        ) {
          out.push(children[0]);
          i += 2; // consumed inline + paragraph_close along with paragraph_open
          continue;
        }
      }
    }
    if (tok.type === "inline" && tok.children) {
      for (let j = 0; j < tok.children.length; j++) {
        if (tok.children[j].type === "image") {
          tok.children[j] = imageFallbackToken(state, tok.children[j]);
        }
      }
    }
    out.push(tok);
  }
  state.tokens = out;
}

/**
 * markdown-it token -> Tiptap schema entity map.
 *
 * Scope (per issue #788, extended by the #885 follow-up): paragraphs,
 * headings, bold/italic/code/strike, links, bullet/ordered lists,
 * blockquotes, fenced code blocks, GFM tables, and images. Tables and images
 * need the core-ruler plugins registered in `createMarkdownParser` (see
 * `wrapCellParagraphs` / `normalizeImagesForPaste` above) to reshape the raw
 * markdown-it token stream into something `MarkdownParser` can place against
 * Tandem's schema — without them, both would either throw
 * `Token type '...' not supported by parser` or silently drop content via
 * `createAndFill` returning null. Any other unmapped block-level token is
 * still silently dropped via `ignore: true` — without an explicit `ignore`,
 * the parser throws and the caller falls back to plain text, losing ALL the
 * user's surrounding formatting just because the pasted snippet happens to
 * mention the unmapped construct.
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
    // is required because softbreak/html_inline/html_block are emitted as
    // single tokens (no `_open`/`_close` pair) — without it,
    // prosemirror-markdown would register `softbreak_open`/`_close` handlers
    // that never fire and the bare `softbreak` token still throws.
    softbreak: { ignore: true, noCloseToken: true },
    // `html: false` causes markdown-it to emit raw HTML as text tokens — but
    // some plugins still surface html_block/html_inline tokens for things
    // like comments. Ignore them defensively so the parser doesn't throw.
    html_block: { ignore: true, noCloseToken: true },
    html_inline: { ignore: true, noCloseToken: true },
    // GFM table (enabled via `.enable(["table"])` in createMarkdownParser).
    // `thead`/`tbody` are paired wrapper tokens with no Tiptap equivalent —
    // NOT `noCloseToken` (they DO have separate `_open`/`_close` tokens; that
    // flag is only for markdown-it's single-token constructs like `image` or
    // `softbreak`). `th`/`td` map to Tiptap's `block+` cell nodes; their
    // inline content is paragraph-wrapped by the `wrapCellParagraphs`
    // core-ruler plugin before this spec ever sees them.
    table: { block: "table" },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: "tableRow" },
    th: { block: "tableHeader" },
    td: { block: "tableCell" },
    // Images are reshaped from markdown-it's inline token into a flat
    // block-level token by the `normalizeImagesForPaste` core-ruler plugin
    // before parsing reaches this spec (see that function's doc comment for
    // the full block-vs-inline schema mismatch and the sanitize-before-hoist
    // ordering). `src` has already passed `sanitizeImageSrcForPaste` by this
    // point — any image that failed was replaced with a text fallback token
    // upstream, so this handler only ever sees safe sources.
    image: {
      node: "image",
      noCloseToken: true,
      getAttrs: (tok) => ({
        src: tok.attrGet("src"),
        alt: tok.content || null,
        title: tok.attrGet("title") || null,
      }),
    },
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
 * tokenizer enables GFM-ish features (strikethrough via `~~`, autolinks,
 * pipe tables) while disabling HTML passthrough so pasted `<script>`-style
 * markup is treated as literal text rather than raw HTML.
 *
 * `table` is disabled by the `commonmark` preset by default — without
 * `.enable(["table"])` no table tokens are ever emitted and `| a | b |`
 * pastes as a plain paragraph of pipe-delimited text.
 *
 * The two core-ruler plugins run in this order, both AFTER markdown-it's
 * default `inline` core rule (so `children` arrays are already populated):
 * `wrapCellParagraphs` first, so every `th`/`td`'s inline content is
 * paragraph-wrapped before `normalizeImagesForPaste` walks the stream —
 * that wrapping is required for ALL cell content, text or image, to satisfy
 * Tiptap's `block+` cell schema (see `wrapCellParagraphs`'s own doc
 * comment). `normalizeImagesForPaste` runs second and deliberately does
 * NOT hoist a solo cell image into a bare `image` child the way it hoists a
 * solo top-level paragraph image — see its `cellDepth` guard and doc
 * comment for why (the server's save path silently drops that shape). The
 * ordering still matters for cells even without hoisting: without
 * `wrapCellParagraphs` running first, a cell's un-wrapped `inline` token
 * would still have its image downgraded to alt text, but would remain bare
 * `inline` content directly inside `th`/`td` — which `createAndFill` can't
 * place against the `block+` schema — so the cell would still be dropped,
 * just for a different reason.
 */
export function createMarkdownParser(schema: Schema): MarkdownParser {
  const tokenizer = MarkdownIt("commonmark", { html: false }).enable([
    "strikethrough",
    "linkify",
    "table",
  ]);
  tokenizer.core.ruler.push("tandem-wrap-cell-paragraphs", wrapCellParagraphs);
  tokenizer.core.ruler.push("tandem-normalize-images", normalizeImagesForPaste);
  return new MarkdownParser(schema, tokenizer, buildTokenSpec(schema));
}

/**
 * Split a single table row line into cell strings, mirroring markdown-it's
 * own `escapedSplit` (verified against markdown-it 14.2.0
 * `lib/rules_block/table.mjs`) closely enough to match its CELL COUNT for
 * every input this file cares about — the cell text itself is only ever
 * used for a delimiter-row regex check (see `isTableDelimiterLine`), never
 * rendered.
 *
 * Escape-aware: a `|` immediately preceded by `\` is NOT a cell separator.
 * This mirrors markdown-it's `isEscaped` check exactly — it looks only at
 * the immediately-preceding character, not at backslash-run parity, so
 * `\\|` (two backslashes then a pipe) is STILL not treated as a separator.
 * Do not be cleverer than markdown-it here; a simple char-walk is correct.
 *
 * Leading/trailing empty cells (a `|` at the very start/end of the trimmed
 * line) are dropped, down to a floor of one cell — this deliberately
 * diverges from markdown-it's real (sequential shift-then-pop) behavior for
 * a degenerate bare `"|"` line, where markdown-it ends up at 0 cells and
 * this helper ends up at 1. That divergence is an accepted, documented
 * false-positive path (see `hasMarkdownTable`'s doc comment) rather than a
 * bug: a bare `"|"` header is a pathological input, not a realistic one. Do
 * NOT replace this with `.replace(/^\|/, "").replace(/\|$/, "")`-style
 * stripping — that counts `||`-edge cases differently than markdown-it's
 * shift/pop-on-empty-cell approach, which this mirrors instead.
 */
function splitTableRowCells(line: string): string[] {
  const str = line.trim();
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "|" && str[i - 1] !== "\\") {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  if (cells.length > 1 && cells[0] === "") cells.shift();
  if (cells.length > 1 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/**
 * True when `line` is a valid GFM table delimiter row: pipe-separated cells
 * (split via {@link splitTableRowCells}, escape-aware and cell-count
 * compatible with markdown-it) that each contain only dashes and optional
 * leading/trailing colons (e.g. `---`, `:--`, `--:`, `:-:`), with at least
 * one non-empty cell. An empty MIDDLE cell is rejected implicitly — the
 * `/^:?-+:?$/` pattern requires at least one dash, so `""` never matches it.
 * Mirrors the validation markdown-it's own table rule performs, kept
 * independent so `looksLikeMarkdown` can stay a cheap heuristic that never
 * invokes the tokenizer. The delimiter row can never contain a `\`
 * (markdown-it's own charcode pre-scan only allows `|`, `-`, `:`, and
 * whitespace on this line), so escape-awareness is a no-op for this
 * caller — the shared helper exists for `hasMarkdownTable`'s header-row
 * count, where it matters.
 */
function isTableDelimiterLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const cells = splitTableRowCells(trimmed);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.trim())) && cells.some((c) => c.trim().length > 0);
}

/**
 * True when `text` contains a GFM pipe table: a header row (any line with a
 * `|`) immediately followed by a delimiter row, WHOSE CELL COUNTS MATCH
 * (both via {@link splitTableRowCells}). Requiring both the row pair AND a
 * matching column count (not just a lone pipe-containing line, and not just
 * any delimiter row underneath it) errs toward NOT converting — a line like
 * `| just | pipes |` with no delimiter row underneath stays plain text,
 * matching `looksLikeMarkdown`'s overall bias.
 *
 * The column-count check mirrors markdown-it, which refuses to parse a
 * table when the header and delimiter row cell counts differ. Without it, a
 * hand-typed table with a column-count typo (e.g. a header cell the author
 * forgot to close with `|`) would still route through the markdown path,
 * where `softbreak: ignore` glues every source line into one word-soup
 * paragraph instead of leaving the text alone.
 */
function hasMarkdownTable(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|")) continue;
    if (!isTableDelimiterLine(lines[i + 1])) continue;
    const headerCells = splitTableRowCells(lines[i]);
    const delimiterCells = splitTableRowCells(lines[i + 1]);
    if (headerCells.length > 0 && headerCells.length === delimiterCells.length) return true;
  }
  return false;
}

// Inline markers: bold/italic, inline code, strikethrough, a markdown link
// [text](url), or an image ![alt](url) — alt may be empty (`![]`), unlike the
// link-text bracket which requires at least one character. Emphasis markers
// require a non-space character adjacent to the delimiter (CommonMark
// flanking rule) so spaced asterisks like "a * b * c" are NOT mistaken for
// emphasis.
//
// The link/image bracket classes (`[^\]\n]`, `[^)\n]`) don't exclude their own
// delimiter (`[`/`(` respectively), unlike the emphasis classes which exclude
// their own marker char. That self-overlap makes an unbounded `*`/`+` here
// quadratic: a paste of N unmatched `[` (or `(`) chars retries the
// greedy-then-backtrack scan from every position, ~O(n^2). Capping both to a
// generous-but-finite length keeps real links/images matching (no realistic
// link text or URL approaches this) while bounding worst-case paste time.
//
// Built once at module load (not per `looksLikeMarkdown` call, which runs on
// every paste) since `MAX_INLINE_SPAN` is fixed — a `new RegExp` from a
// template string can't use the literal-regex per-call-site cache a `/.../`
// literal gets, so rebuilding it per call would re-parse the pattern on every
// paste for no reason.
const MAX_INLINE_SPAN = 2000;
const INLINE_MARKDOWN_PATTERN = new RegExp(
  `(\\*\\*\\S(?:[^*\\n]{0,${MAX_INLINE_SPAN}}\\S)?\\*\\*|` +
    `__\\S(?:[^_\\n]{0,${MAX_INLINE_SPAN}}\\S)?__|` +
    `\\*\\S(?:[^*\\n]{0,${MAX_INLINE_SPAN}}\\S)?\\*|` +
    `\`[^\`\\n]{1,${MAX_INLINE_SPAN}}\`|` +
    `~~\\S(?:[^~\\n]{0,${MAX_INLINE_SPAN}}\\S)?~~|` +
    `!?\\[[^\\]\\n]{0,${MAX_INLINE_SPAN}}\\]\\([^)\\n]{1,${MAX_INLINE_SPAN}}\\))`,
);

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

  if (INLINE_MARKDOWN_PATTERN.test(text)) return true;

  if (hasMarkdownTable(text)) return true;

  return false;
}

/**
 * Parse markdown `text` into a ProseMirror `Slice` against `schema`, suitable
 * for `editorProps.clipboardTextParser`. Returns `null` when the text does not
 * look like markdown OR when parsing produces nothing meaningful, signaling the
 * caller to fall back to normal plain-text paste.
 *
 * The slice is created with `Slice.maxOpen(doc.content, false)`, which opens
 * both ends as far as the content allows WITHOUT descending into isolating
 * nodes. This is what makes inline-only markdown merge into the surrounding
 * paragraph (pasting `**bold**` mid-sentence yields inline bold, not a new
 * paragraph) while block-level markdown (headings, lists, ...) still pastes
 * as its own blocks. A fully-closed slice would instead split the paragraph
 * at the cursor for every paste.
 *
 * `openIsolating` (prosemirror-model's `Slice.maxOpen` second parameter,
 * default `true`) must be `false` here: Tiptap's `table` node is
 * `isolating: true` (`@tiptap/extension-table`), and the default `true`
 * descends straight through that boundary — pasting a table produces a slice
 * open ~4 levels deep (table > tableRow > tableHeader > paragraph), which
 * then mangles a paste that lands mid-paragraph in unrelated content. No
 * other token in this file's map targets an isolating node, so passing
 * `false` unconditionally is safe for every other case too.
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

  return Slice.maxOpen(doc.content, false);
}
