import { type AnyExtension, mergeAttributes, type RawCommands } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link, { isAllowedUri as tiptapDefaultIsAllowedUri } from "@tiptap/extension-link";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { FootnoteRefMark } from "./extensions/footnote-ref";
import { ListItemCheckbox } from "./extensions/list-item-checkbox";
import { ListSpreadExtension } from "./extensions/list-spread";
import { MarkdownHtmlExtension } from "./extensions/markdown-html";
import { RawMarkdownMark } from "./extensions/raw-markdown";
import { runColumnCommandWithReindex } from "./extensions/table-align-commands";
import { TableColumnAlignExtension } from "./extensions/table-column-align";
import {
  isRenderableLinkHref,
  isRenderableLinkScheme,
  isSafeExternalHref,
  isSchemelessPathHref,
} from "./utils/url-safety";

// Link mark that surfaces the destination URL on hover via a native `title`
// tooltip (issue #996). The base `@tiptap/extension-link` renderHTML emits the
// `href` (plus our configured rel/target) but no title, so links give no hover
// affordance for where they point. We delegate to the base renderHTML via
// `this.parent()` — which keeps its href-blanking security branch, emitting
// `href: ""` for any URI its guard refuses — and then post-process: mirror the
// href into `title` only when the BASE output's href survived (non-empty) and no
// explicit title already exists (e.g. a .docx-imported title attr wins). Reading
// the base output rather than the raw HTMLAttributes means a disallowed scheme is
// never given a title and never resurrected. Pointer-cursor styling lives in
// editor.css (`.tandem-editor a[href]`), alongside the blocked-link styling keyed
// on the `data-tandem-link-blocked` attribute this renderHTML sets.
//
// Two halves, deliberately separate: the BLANKING lives here in the base
// renderHTML, but WHICH hrefs get blanked is decided by the `isAllowedUri`
// option configured at the `.configure({…})` site below — not by the vendored
// default. Read that comment before reasoning about what reaches `attrs.href`.
//
// It also strips the configured `target="_blank"` from non-external hrefs — see
// the comment at that branch for why the attribute is a double-open on internal
// links but a safety net on external ones.
const LinkWithHoverTitle = Link.extend({
  renderHTML(props) {
    const out = this.parent?.(props) ?? [
      "a",
      mergeAttributes(this.options.HTMLAttributes, props.HTMLAttributes),
      0,
    ];
    if (Array.isArray(out) && out.length >= 2 && out[1] && typeof out[1] === "object") {
      const attrs = { ...(out[1] as Record<string, unknown>) };
      const href = attrs.href;
      if (typeof href === "string" && href.length > 0 && attrs.title == null) {
        attrs.title = href;
      }
      // Mark an anchor the base renderHTML BLANKED, so `editor.css` can stop it
      // looking clickable — `.tandem-editor a[href]` matches an empty href too,
      // so a refused link kept `cursor: pointer` and did nothing on click.
      //
      // Deliberately an attribute and NOT a `title` (#1537). A disallowed
      // scheme is never given a title and never resurrected — the rule stated
      // at the top of this comment block, pinned by the `hasAttribute("title")
      // === false` rows in `tests/client/link-target-internal.test.ts`. A title
      // would also have to carry the refused href to be useful, which is both a
      // resurrection of the string we just refused to emit and a bidi
      // tooltip-spoofing surface (U+202A-U+202E render a different host than
      // the anchor resolves to). The attribute carries no href-derived data at
      // all, so neither problem exists.
      if (typeof href === "string" && href.length === 0) {
        attrs["data-tandem-link-blocked"] = "true";
      }
      // Drop `target="_blank"` on anything that is not a safe external URL
      // (#1343). Clicking a relative link to a local `.md` opened it as a
      // Tandem tab AND popped the system browser: `handleEditorClick`
      // preventDefaults and routes the click through `openHref`, but WebView2
      // treats a `_blank` anchor as a new-window request in its own right, and
      // no `on_new_window` handler is registered, so it falls through to the OS.
      //
      // Kept for external hrefs deliberately, even though `openHref` already
      // calls `window.open` itself and the attribute is redundant on the happy
      // path: if the intercept ever fails to run, `_blank` degrades to "opens a
      // new tab" instead of navigating the editor frame away and taking the
      // session with it. Internal links have no such consolation — their
      // fallback is the double-open being fixed here.
      if (typeof href === "string" && !isSafeExternalHref(href)) {
        delete attrs.target;
      }
      (out as unknown[])[1] = attrs;
    }
    return out;
  },
});

/**
 * The schema-defining editor extensions: every node and mark the ProseMirror
 * schema needs, plus the static (no-runtime-param) plugins. Shared between
 * `Editor.svelte` and the editor tests so the tested schema CANNOT drift from
 * production — that drift is exactly what hid the missing `underline`/
 * `superscript`/`subscript` marks (the `.docx` import emitted them, the editor
 * never registered them, and y-prosemirror silently deleted the affected text on
 * sync). `tests/client/editor-schema-marks.test.ts` asserts this set covers
 * `DOCX_INLINE_MARKS`.
 *
 * Returns FRESH instances on every call. Tiptap's `ExtensionManager` mutates and
 * owns each extension object (storage, the `editor` back-reference, per-editor
 * plugin instances), so the same configured instance must not be reused across
 * the editor rebuilds `Editor.svelte` performs on a ydoc/provider swap — hence a
 * factory, not a shared module-level array. Takes no reactive arguments and reads
 * no reactive state, so calling it inside the rebuild `$effect` adds nothing to
 * that effect's tracked dependency set.
 *
 * The runtime-param extensions (Collaboration, CollaborationCursor, Annotation*,
 * AnnotationPing, HeadingCollapse, Authorship, Awareness, SlashCommand,
 * FindReplace, SelectionDecoration) stay inline in `Editor.svelte` and are
 * appended AFTER this block, preserving the documented order contracts:
 * ListItemCheckbox after StarterKit's `listItem:false`, and HeadingCollapse after
 * AnnotationExtension (#650).
 */
/**
 * Paragraph that preserves soft line wraps instead of converting them to hard
 * breaks (#1448).
 *
 * A soft wrap lives in the Y.Doc as a literal `\n` inside a `Y.XmlText`; a real
 * hard break is a sibling `Y.XmlElement("hardBreak")`. The Y.Doc distinguishes
 * the two, ProseMirror does not — so every time the editor re-reads the DOM,
 * `prosemirror-model` splits paragraph text on `/\r?\n|\r/` and inserts
 * `hardBreak` nodes. Saving then writes a trailing `\` onto every wrapped line,
 * which is a semantic hard break: GitHub and every other renderer break the
 * paragraph at the original author's wrap column, at any viewport width.
 *
 * One edit is enough to damage the whole file, because a childList mutation on
 * the doc node makes `readDOMChange` re-parse a doc-spanning range in one pass.
 *
 * `whitespace: "pre"` is what `prosemirror-view` itself keys on: `parseBetween`
 * passes `preserveWhitespace: "full"` when the parent node's whitespace is
 * `"pre"`, and `linebreakReplacement` only splits when it is truthy-but-not-
 * `"full"`. An explicit Shift+Enter `hardBreak` still survives, and it closes
 * the paste doorway too — any clipboard carrying `text/html` bypasses
 * `clipboardTextParser` and hits the same split.
 *
 * Rejected alternatives: stock is the bug; `linebreakReplacement: false`
 * collapses the wrap to a space, losing the line entirely.
 *
 * **`whitespace` must be an extension config field, not `extendNodeSchema`.**
 * Tiptap's schema builder spreads `extendNodeSchema`'s result FIRST and then
 * assigns `whitespace: callOrReturn(getExtensionField(extension, "whitespace"))`
 * over the top, so an `extendNodeSchema` that returns `{ whitespace: "pre" }`
 * is overwritten with `undefined` and then dropped by `cleanUpSchemaItem`. It
 * reads as correct and does nothing.
 *
 * Scoped to `paragraph` deliberately — NOT `heading`. A heading carrying a
 * newline serializes as setext at depth 1–2 (`foo\nbar\n===`), which inverts one
 * of our own documented normalizations. Table cells need no separate handling: a
 * cell's content is a paragraph, so they inherit this.
 *
 * The obvious objection — that `"pre"` reintroduces the bug, since two trailing
 * spaces are a markdown hard break and four leading spaces an indented code
 * block — does not hold. `remark-stringify`'s `safe()` already escapes both to
 * `&#x20;`, idempotently. Pinned in `tests/server/file-io/whitespace-escaping`.
 *
 * Two knock-on effects of `"pre"` that are NOT about the newline split, both
 * found by reviewing this change rather than by the test suite:
 *
 * - **Paste.** The per-node setting beats the paste-level `preserveWhitespace:
 *   false` once parsing enters a `<p>`, so pretty-printed external HTML would
 *   import its own indentation as content. Handled at the paste boundary by
 *   `utils/paste-whitespace.ts` — deliberately not by giving this node's parse
 *   rule an explicit `preserveWhitespace`, which would fix paste and silently
 *   reopen the newline split for any paragraph re-read without a node view desc.
 * - **Trailing whitespace** is no longer stripped when a paragraph is parsed
 *   from the DOM (`prosemirror-model` `NodeContext.finish` gates stripping on
 *   the same flag). Trailing spaces the user actually typed now survive, and
 *   save as a `&#x20;` escape. Accepted: it is cosmetic, it is idempotent, and
 *   stripping it back out would mean editing text the user typed on purpose.
 *
 * A third — that preserved newlines would render as collapsed spaces because
 * nothing sets `white-space` on `.tandem-editor` — is not real: `@tiptap/core`
 * injects `.ProseMirror { white-space: pre-wrap }` itself (`injectCSS` defaults
 * to true and is not disabled here), so do NOT add a rule for it.
 */
const SoftWrapParagraph = Paragraph.extend({ whitespace: "pre" });

/**
 * Table that carries GFM column alignment (#1448).
 *
 * `@tiptap/extension-table` declares no attributes at all, so the `align` array
 * the server writes on the table element was discarded by `computeAttrs` the
 * moment the ProseMirror doc was built from the Y.Doc — before the DOM was
 * involved — and `updateYFragment` then pruned it from the Y.Doc on the next
 * write. `|:--|:-:|--:|` became `|---|---|---|` on the user's first edit, and
 * permanently: reopening the file cannot recover what is no longer on disk.
 *
 * Stored the way the server stores it: a JSON array at the TABLE level, not
 * per-cell — that mirrors mdast's own shape and avoids per-cell plumbing.
 *
 * **Deliberately NOT `parseHTML: () => null`.** The `markdownRaw` /
 * `markdownHtml` attributes next door use that pattern so pasted HTML can never
 * forge a verbatim-passthrough block, which would let arbitrary pasted text
 * serialize as un-escaped markdown source. Alignment carries no such risk, and
 * copying the pattern here would re-break the thing being fixed: the attribute
 * would reset to null on the next DOM re-read. It must survive a DOM round trip,
 * so it renders to `data-align` and parses back from it.
 */
const TableWithAlignment = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      align: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-align"),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.align ? { "data-align": String(attrs.align) } : {},
      },
    };
  },

  /**
   * Re-index `align` when a column is inserted or deleted (#1535).
   *
   * `prosemirror-tables` does not know this attribute exists, so its column
   * commands changed the column count and left the array at its old length and
   * old positional meaning — every entry after the change point then described
   * the wrong column, and the next save wrote that to disk. Overriding the
   * COMMAND rather than patching the #923 context-menu call sites means the
   * menu, a future toolbar or keyboard binding, and a direct
   * `editor.commands.addColumnBefore()` all get the fix with nothing to keep in
   * sync.
   *
   * Row operations are deliberately NOT wrapped: `findWidth` takes the per-row
   * max of colspan sums plus any rowspan carried in from an earlier row, so
   * `addRowBefore`/`addRowAfter`/`deleteRow`/`toggleHeaderRow`/`mergeCells`/
   * `splitCell` all preserve the width. That was probed against the
   * prosemirror-tables source and measured, not assumed, and
   * `table-align-commands.test.ts` pins it so a future refactor cannot
   * "helpfully" re-index on a row op.
   *
   * The mechanism, the undo-atomicity argument and the Critical Rule 2 answer
   * are in `table-align-commands.ts`. Read it before changing this.
   */
  addCommands() {
    const parent = this.parent?.() ?? ({} as Record<string, never>);
    return {
      ...parent,
      addColumnBefore: () => (props: Parameters<ReturnType<RawCommands["addColumnBefore"]>>[0]) =>
        runColumnCommandWithReindex(props, parent.addColumnBefore?.(), "before"),
      addColumnAfter: () => (props: Parameters<ReturnType<RawCommands["addColumnAfter"]>>[0]) =>
        runColumnCommandWithReindex(props, parent.addColumnAfter?.(), "after"),
      deleteColumn: () => (props: Parameters<ReturnType<RawCommands["deleteColumn"]>>[0]) =>
        runColumnCommandWithReindex(props, parent.deleteColumn?.(), "delete"),
    };
  },
});

export function buildSchemaExtensions(): AnyExtension[] {
  return [
    // `listItem:false` disables StarterKit's stock ListItem so our
    // ListItemCheckbox (same node name "listItem", + a `checked` tri-state
    // attribute for GFM task lists, #982) owns the schema. `paragraph:false`
    // hands the paragraph node to SoftWrapParagraph below. history:false — Yjs
    // handles undo/redo.
    StarterKit.configure({ history: false, listItem: false, paragraph: false }),
    SoftWrapParagraph,
    ListItemCheckbox,
    ListSpreadExtension,
    // underline/superscript/subscript: marks the .docx import (mammoth) emits but
    // StarterKit does not provide. Required client-side or y-prosemirror deletes
    // the marked text on sync (see DOCX_INLINE_MARKS). Underline → Mod-u.
    Underline,
    Superscript,
    Subscript,
    // Footnote reference mark — REQUIRED client-side or y-prosemirror deletes the
    // marked `[N]` text on sync (see DOCX_INLINE_MARKS / #1123 Tier-A #3 PR 2).
    FootnoteRefMark,
    Highlight.configure({ multicolor: true }),
    LinkWithHoverTitle.configure({
      openOnClick: false,
      HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      // #1377: `[spec](docs/spec.md)` — the relative-link form most repos use —
      // rendered with `href=""` and no hover tooltip, because Tiptap's default
      // guard rejects it. (Don't re-derive that guard's regex by reading it:
      // it is assembled in a template literal, so the escape you see is not the
      // one `new RegExp` gets, and the naive reading flips the answer. The
      // behaviour is pinned executably in `tests/client/link-target-internal.test.ts`.)
      //
      // The `||` half is a union, and it is strictly additive because `||` can
      // only ever widen — not because of which operand runs first. Tiptap's
      // DOMPurify-derived scheme allowlist therefore stays the authority on
      // schemes and our predicate only ADDs: hrefs with no URL-hostile
      // character, no backslash, no leading `//`, and either no colon or a
      // `/`/`#`/`?` before the first one. `javascript:` and friends stay blocked
      // by both halves.
      //
      // NOT claimed: that a newly-allowed href "can only be a relative URL".
      // That is true of `new URL()` and false of Tandem's actual consumer —
      // `utils/relative-link.ts` is a segment walk, and it is where the
      // traversal question is answered.
      //
      // Widening reaches every surface that reads this option, including the
      // linkify markPasteRule, which cannot be narrowed separately: pasting the
      // plain text `example.com/path` now linkifies. Accepted deliberately —
      // bare `example.com` already did.
      //
      // `isRenderableLinkHref` is the one term that NARROWS, and it was added in
      // #1420 precisely because the paragraph above is a complete description of
      // an expression that could only ever grow. `defaultValidate` accepts a
      // leading `/` via its `[^a-z]` alternative WITHOUT looking at what
      // follows, so `/\evil.com/x.md` short-circuited the `||` and rendered as a
      // live link that `new URL()` resolves to `http://evil.com/x.md`. The
      // rejection inside `isSchemelessPathHref` was real and inert. Read the
      // veto's docblock before touching this line: its ordering (leading
      // whitespace first) is load-bearing, and it deliberately does NOT use
      // `URL_HOSTILE_CHARS`.
      //
      // `isRenderableLinkScheme` is the one term that NARROWS, and it was added
      // in #1537 precisely because the paragraph above is a complete
      // description of an expression that could only ever grow. Tiptap's
      // `defaultValidate` is NOT the scheme authority the paragraph claims: the
      // escape collapse described above also puts the hyphen OUTSIDE its
      // negated class, so `ms-msdt:`, `ms-appinstaller:`, `search-ms:`,
      // `view-source:` and `itms-services:` all satisfied it and rendered live
      // with the href verbatim. ANDing can only subtract — measured over a
      // 68-case corpus and re-measured over 800k generated hrefs, nothing
      // master rejects becomes accepted. Those two runs predate #1420; the
      // property was re-measured against post-#1420 master over ~14k cases
      // (0 widened, 624 narrowed) and holds by construction anyway, since
      // this expression is that one with a conjunct added.
      //
      // It also drops `tel:`/`sms:`/`callto:`/`cid:`/`xmpp:`/`ftps:`, which
      // Tiptap allowlists and `SAFE_EXTERNAL_PREFIXES` does not. FOLLOWING one
      // was already broken, with a visible refusal (`openHref` ->
      // `resolveRelativeLink` -> `unsupported-ext` -> `notifyLinkProblem`), so
      // the render closed a link that never worked. CREATING one is a SECOND
      // surface and that reasoning does not cover it: `setLink` reads this
      // union too, so it started returning `false` where it used to succeed.
      // `applyLink` (`toolbar/handlers.ts`) reports that refusal through the
      // notification channel — do not let it go back to a silent no-op.
      //
      // Read the predicate's docblock before touching this line. In
      // particular, "scheme-bearing" there is the WHATWG scheme grammar and
      // NOT `hasSchemePrefix`: the looser test also blanks colon-bearing
      // RELATIVE paths (`2024:plan.md`, `.hidden:note.md`) that opened
      // perfectly well, which breaks the same rule from the other side.
      //
      // BOTH narrowing terms are present and NEITHER covers the other. A
      // leading space makes `isRenderableLinkScheme` see a schemeless href --
      // its WHATWG test is anchored -- so " ms-msdt:/id" passes it and is
      // refused only by `isRenderableLinkHref`'s trimStart clause. Bare
      // "ms-msdt:/id" carries no special scheme and no Windows prefix, so it
      // passes `isRenderableLinkHref` and is refused only by the scheme
      // allowlist. Tiptap's own `defaultValidate` strips whitespace before
      // matching, which is why the whitespace veto has to live out here.
      isAllowedUri: (url, ctx) =>
        isRenderableLinkHref(url) &&
        isRenderableLinkScheme(url) &&
        (ctx.defaultValidate(url) || isSchemelessPathHref(url)),
      // Autolink is the one surface held at EXACTLY today's behaviour, and only
      // this option can do it: the autolink plugin filters on the RAW TYPED
      // TEXT, not the resolved href, so widening `isAllowedUri` alone would make
      // typing `example.com/path ` auto-create a link — writing markdown link
      // syntax into the user's file on a keystroke, entirely outside #1377.
      //
      // Substituting the vendored default URI GUARD here pins that gate. Note
      // it is not the vendored `shouldAutoLink` default (that one is
      // `url => !!url`): autolink's effective gate is `validate && shouldAutoLink`,
      // so widened-validate AND default-guard re-composes to exactly the
      // default. The `!!` is required, not decorative — `isAllowedUri` returns
      // `RegExpMatchArray | null`, and this option is typed boolean.
      //
      // The `[]` is the `protocols` argument, and it is correct only because we
      // never configure `protocols` (asserted in the test file). If a custom
      // protocol is ever added above, it must be threaded through here too or
      // autolink will silently ignore it — an option literal cannot reach
      // `this.options`.
      shouldAutoLink: (url) => !!tiptapDefaultIsAllowedUri(url, []),
    }),
    // Block-level image node (issue #153). Renders `![alt](url)` markdown
    // (round-tripped through mdast-ydoc) and embedded .docx images (mammoth
    // converts them to base64 data URIs). allowBase64 is required so those
    // data-URI sources parse and render rather than being stripped.
    Image.configure({ allowBase64: true }),
    Placeholder.configure({
      placeholder: "Start typing…",
    }),
    TableWithAlignment.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    // Renders the `align` array above as `text-align` on each cell (#995).
    // Decoration-only — it adds no node, mark or attribute — so it contributes
    // nothing to `getSchema()`. It lives in this builder anyway, deliberately:
    // this is what the client tests build editors from, so registering here is
    // what makes "the extension is actually wired into production" a thing the
    // unit suite can fail on. Appending it in Editor.svelte instead would let
    // every test pass with the feature unwired.
    //
    // Being here places it BEFORE annotation/authorship/heading-collapse in
    // decoration order (see Editor.svelte, #650). Inert today: no other
    // Decoration.node in src/client emits `text-align`. Note prosemirror-view
    // concatenates `class` AND `style` alike — the reason to keep this a `class`
    // is that concatenated styles apply via `cssText +=`, so two decorations
    // setting `text-align` would resolve by registration order. See the
    // extension's header comment.
    TableColumnAlignExtension,
    MarkdownHtmlExtension,
    // Inline mark for verbatim markdown source (footnote/reference refs, inline
    // image/html). Name must match the server `rawMarkdown` delta key so it
    // round-trips through y-prosemirror. See raw-markdown.ts / #981.
    RawMarkdownMark,
  ];
}
