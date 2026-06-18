import { type AnyExtension, mergeAttributes } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
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

// Link mark that surfaces the destination URL on hover via a native `title`
// tooltip (issue #996). The base `@tiptap/extension-link` renderHTML emits the
// `href` (plus our configured rel/target) but no title, so links give no hover
// affordance for where they point. We delegate to the base renderHTML via
// `this.parent()` — which keeps its `isAllowedUri` security branch (blanking
// `javascript:`/`data:`/etc. hrefs to "") — and then post-process: mirror the
// href into `title` only when the BASE output's href survived (non-empty) and no
// explicit title already exists (e.g. a .docx-imported title attr wins). Reading
// the base output rather than the raw HTMLAttributes means a disallowed scheme is
// never given a title and never resurrected. Pointer-cursor styling lives in
// editor.css (`.tandem-editor a[href]`).
const LinkWithHoverTitle = Link.extend({
  renderHTML(props) {
    const out = this.parent?.(props) ?? [
      "a",
      mergeAttributes(this.options.HTMLAttributes, props.HTMLAttributes),
      0,
    ];
    if (Array.isArray(out) && out.length >= 2 && out[1] && typeof out[1] === "object") {
      const attrs = out[1] as Record<string, unknown>;
      const href = attrs.href;
      if (typeof href === "string" && href.length > 0 && attrs.title == null) {
        (out as unknown[])[1] = { ...attrs, title: href };
      }
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
