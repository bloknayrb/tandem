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
 *
 * Both use `parseHTML: () => null` so the attribute is NEVER reconstructed from
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
        },
      },
    ];
  },
});
