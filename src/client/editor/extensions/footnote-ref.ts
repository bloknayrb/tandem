import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * Inline mark for a reconstructed Word footnote reference (#1123 Tier-A #3 PR 2).
 * Carries `{ id, kind }` on the verbatim `[N]` marker text so the server export
 * can emit a real `<w:footnoteReference>` (the footnote BODY lives off-fragment
 * in Y_MAP_FOOTNOTE_BODIES, keyed by the same id).
 *
 * The mark `name` MUST byte-match the server delta-attribute key (the literal
 * "footnote-ref" in `DOCX_INLINE_MARKS` / `docx-html.ts`) or y-prosemirror's
 * sync deletes the whole offending Y.XmlText — silent content loss, not a crash
 * (asserted by `tests/client/editor-schema-marks.test.ts`'s real-sync test).
 *
 * `parseHTML: () => []` means it is NEVER reconstructed from pasted/loaded HTML —
 * the mark originates only from the collaboration (Y.Doc) binding, so a pasted
 * `<sup>` can't masquerade as a footnote and corrupt the document on save.
 * `inclusive: false` keeps the user's typing at the marker boundary from
 * inheriting the footnote reference.
 */
export const FootnoteRefMark = Mark.create({
  name: "footnote-ref",
  inclusive: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: () => null,
        renderHTML: (attrs) => (attrs.id != null ? { "data-footnote-id": String(attrs.id) } : {}),
      },
      kind: {
        default: "footnote",
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [];
  },

  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes({ class: "tandem-footnote-ref" }, HTMLAttributes), 0];
  },
});
