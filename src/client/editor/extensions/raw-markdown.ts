import { Mark } from "@tiptap/core";

/**
 * Inline mark carrying verbatim markdown source for a construct Tandem has no
 * first-class node for (footnoteReference, linkReference, imageReference,
 * nested inline image, inline HTML). The server stores the source as
 * `rawMarkdown`-marked Y.XmlText and re-emits it as an inline mdast `html` node
 * on save, so it round-trips byte-exact (#981 / ADR-042).
 *
 * The mark `name` MUST byte-match the server delta-attribute key
 * (`RAW_MARKDOWN_MARK` in `src/server/file-io/mdast-ydoc.ts`) or y-prosemirror
 * will drop it on the way to/from the Y.Doc.
 *
 * Renders `<span class="tandem-raw-md">` so the editor.css visibility toggle
 * (`.hide-raw-md .tandem-raw-md`) can hide it. `parseHTML: () => []` means it is
 * NEVER reconstructed from pasted/loaded HTML — the mark only ever originates
 * from the collaboration (Y.Doc) binding, so re-deriving it from the DOM would
 * let pasted spans masquerade as raw source and corrupt the document on save.
 */
export const RawMarkdownMark = Mark.create({
  name: "rawMarkdown",

  // Exclude nothing special; it coexists with other marks but the source it
  // carries already encodes its own formatting.
  parseHTML() {
    return [];
  },

  renderHTML() {
    return ["span", { class: "tandem-raw-md" }, 0];
  },
});
