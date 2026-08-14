import { Extension } from "@tiptap/core";

/**
 * Paragraph-level passthrough attributes for the markdown fidelity pipeline.
 *
 * - `markdownHtml`: a raw HTML block (stored server-side as `paragraph`
 *   carrying the attr, re-emitted as an mdast `html` node). Renders nothing
 *   extra — the paragraph's text IS the HTML source.
 * - `markdownRaw`: verbatim markdown source for a construct Tandem has no
 *   first-class node for (footnote/reference definitions, unknown blocks). See
 *   #981 / ADR-042. Unlike `markdownHtml` it emits `data-markdown-raw` so the
 *   editor.css visibility toggle (`.hide-raw-md [data-markdown-raw]`) has a DOM
 *   hook.
 * - `markdownFrontmatter`: narrows `markdownRaw` to YAML/TOML frontmatter
 *   (#1457) so it can be styled as a metadata block rather than body prose.
 *   Purely presentational — serialization goes through the same path either way.
 *
 * All three must be DECLARED here even though nothing in the editor sets them.
 * An attribute the client schema does not declare is discarded by
 * `computeAttrs` when the PM doc is built from the Y.Doc, and `updateYFragment`
 * then prunes it from the Y.Doc on the next write — so the server's attribute
 * silently disappears on the user's first edit. That is the mechanism that
 * destroyed table alignment (#1448), and it happens before the DOM is involved
 * at all, so no `parseHTML` choice can protect against it.
 *
 * They use `parseHTML: () => null` so the attribute is NEVER reconstructed from
 * pasted/loaded HTML — it is a server-Y.Doc-only attribute. Re-deriving it from
 * the DOM would let pasted content masquerade as raw passthrough and serialize
 * back as un-escaped source, corrupting the document.
 */
export const MarkdownHtmlExtension = Extension.create({
  name: "markdownHtml",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph"],
        attributes: {
          markdownHtml: {
            default: null,
            parseHTML: () => null,
            renderHTML: () => ({}),
          },
          markdownRaw: {
            default: null,
            parseHTML: () => null,
            renderHTML: (attrs) => (attrs.markdownRaw ? { "data-markdown-raw": "" } : {}),
          },
          markdownFrontmatter: {
            default: null,
            parseHTML: () => null,
            renderHTML: (attrs) =>
              attrs.markdownFrontmatter ? { "data-markdown-frontmatter": "" } : {},
          },
        },
      },
    ];
  },
});
