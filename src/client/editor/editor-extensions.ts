import { type AnyExtension, mergeAttributes } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link, { isAllowedUri as tiptapDefaultIsAllowedUri } from "@tiptap/extension-link";
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
import { MarkdownHtmlExtension } from "./extensions/markdown-html";
import { RawMarkdownMark } from "./extensions/raw-markdown";
import { isSafeExternalHref, isSchemelessPathHref } from "./utils/url-safety";

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
// editor.css (`.tandem-editor a[href]`).
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
export function buildSchemaExtensions(): AnyExtension[] {
  return [
    // `listItem:false` disables StarterKit's stock ListItem so our
    // ListItemCheckbox (same node name "listItem", + a `checked` tri-state
    // attribute for GFM task lists, #982) owns the schema. history:false — Yjs
    // handles undo/redo.
    StarterKit.configure({ history: false, listItem: false }),
    ListItemCheckbox,
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
      // rendered with `href=""` and no hover tooltip. The vendored default
      // guard blocks `/^[a-zA-Z][a-zA-Z0-9+.-]*[:\/]/`.
      //
      // DERIVATION WARNING, because re-deriving it wrong flips the answer: the
      // vendored pattern is assembled inside a TEMPLATE LITERAL
      // (`dist/index.js:211-213`), so `\-` collapses to a bare `-` before
      // `new RegExp` ever sees it and the final class is `[^a-z+.-:]`, in which
      // `.-:` IS a range (U+002E–U+003A) swallowing `.`, `/`, the digits and
      // `:`. Written literally with an escaped hyphen it would be a plain set,
      // and `docs/spec.md` would be ALLOWED — the opposite of production.
      //
      // Fix: a strictly-additive union. `ctx.defaultValidate` runs FIRST so
      // Tiptap's DOMPurify-derived scheme allowlist stays the authority on
      // schemes, and our predicate can only ever ADD.
      //
      // Newly allowed, as a PROPERTY rather than a list (a list was measurably
      // wrong): every href that contains no URL-hostile character and no
      // backslash, does not begin `//`, and has either no colon or a `/`, `#`
      // or `?` before its first colon — that `defaultValidate` rejects.
      // Illustrations only: `docs/spec.md`, `java/script:alert(1)`,
      // `example.com/path`. `javascript:`/`data:`/`vbscript:`/`file:`/`blob:`/
      // `filesystem:` and their whitespace-obfuscated variants stay blocked by
      // BOTH halves (the default strips whitespace and sees the scheme; our
      // predicate fails closed on the hostile character).
      //
      // NOT claimed: that a newly-allowed href "can only be a relative URL".
      // That is true of `new URL()` and false of Tandem's actual consumer —
      // `utils/relative-link.ts` is a segment walk, and it is where the
      // traversal question is answered.
      //
      // This option governs SIX surfaces in `dist/index.js`: parseHTML getAttrs
      // (:290), renderHTML (:304), setLink (:322), toggleLink (:333), the
      // linkify markPasteRule (:361) and the autolink validator (:395).
      // setLink/toggleLink are the Link-editor + context-menu surface, where a
      // bare nested path silently no-opped before this change. The markPasteRule
      // reads `isAllowedUri` directly and CANNOT be narrowed by option — pasting
      // the plain text `example.com/path` now linkifies; accepted deliberately,
      // since bare `example.com` already linkifies today. Autolink is pinned
      // below.
      isAllowedUri: (url, ctx) => ctx.defaultValidate(url) || isSchemelessPathHref(url),
      // Autolink is held at EXACTLY today's behaviour, and only this option can
      // do it: the autolink plugin filters on `link.value` — the RAW TYPED TEXT
      // (`dist/index.js:106`), not the resolved href. Measured with the real
      // linkifyjs, `find("example.com/path")` yields
      // `{value: "example.com/path", href: "http://example.com/path"}` while
      // `defaultValidate("example.com/path")` is false, so widening
      // `isAllowedUri` alone would make typing `example.com/path ` auto-create a
      // link — writing markdown link syntax into the user's file on a keystroke,
      // entirely outside #1377. `shouldAutoLink` is applied AFTER `validate`
      // (:107), so restoring the vendored default here pins the gate exactly.
      // What is NOT new: typing `docs/spec.md ` already autolinks `spec.md`
      // today (linkify tokenizes to the last dotted run); this changes nothing
      // there.
      //
      // The `[]` is the `protocols` argument, and it is correct only because we
      // never configure `protocols`. If a custom protocol is ever added above,
      // it must be threaded through here too or autolink will silently ignore
      // it — an option literal cannot reach `this.options`.
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
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    MarkdownHtmlExtension,
    // Inline mark for verbatim markdown source (footnote/reference refs, inline
    // image/html). Name must match the server `rawMarkdown` delta key so it
    // round-trips through y-prosemirror. See raw-markdown.ts / #981.
    RawMarkdownMark,
  ];
}
