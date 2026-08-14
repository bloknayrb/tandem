import { Extension } from "@tiptap/core";

/**
 * Loose vs tight list spacing (#1448).
 *
 * `spread` is what distinguishes a loose list — blank lines between items, each
 * item's content wrapped in `<p>` — from a tight one. mdast carries it on both
 * the list and each item, and the server writes it on both.
 *
 * Without this declaration the attribute is discarded by `computeAttrs` when the
 * ProseMirror doc is built from the Y.Doc, and `updateYFragment` then prunes it
 * from the Y.Doc on the next write — so the server's value is gone from disk on
 * the user's first edit. That is the same mechanism that destroyed table
 * alignment, and it happens before the DOM is involved, so no `parseHTML` choice
 * can protect against it. 56 files in this repo were affected.
 *
 * A global attribute rather than three separate node extensions because
 * `bulletList` and `orderedList` come from `starterKit` and have no entry of
 * their own in `buildSchemaExtensions()` — filtering the extension list by name
 * to override them matches nothing and silently does nothing.
 *
 * **Round-trips through the DOM, deliberately** — unlike the `markdownRaw` /
 * `markdownHtml` markers next door, which use `parseHTML: () => null` so pasted
 * HTML cannot forge a verbatim-passthrough block and smuggle un-escaped markdown
 * source into the document. A forged `spread` changes blank-line spacing and
 * nothing else, so the same precaution would cost the fix for no benefit: the
 * attribute would reset on the next DOM re-read.
 */
export const ListSpreadExtension = Extension.create({
  name: "listSpread",

  addGlobalAttributes() {
    return [
      {
        types: ["bulletList", "orderedList", "listItem"],
        attributes: {
          spread: {
            default: null,
            // Splitting a loose item should produce another loose item —
            // otherwise pressing Enter in a loose list silently tightens the
            // item you just created and the list becomes half-and-half.
            keepOnSplit: true,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute("data-spread") === "true" ? true : null,
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.spread ? { "data-spread": "true" } : {},
          },
        },
      },
    ];
  },
});
