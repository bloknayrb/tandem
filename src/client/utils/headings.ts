import type { Editor } from "@tiptap/core";

export type HeadingEntry = { text: string; level: number; pos: number };

/**
 * Top-level headings, for the outline panel.
 *
 * The `parent === doc` test is not cosmetic. `OutlinePanel` treats consecutive
 * entries as section boundaries (`sectionEnd = headings[i + 1].pos`) to bucket
 * annotations, so any heading admitted here becomes a document section. Since
 * #1664 widened `listItem` to `block+`, a heading nested in a list item
 * (`- # Section`) is a loadable shape, and counting one as a section would both
 * list a bullet as a document heading and skew every bucket after it.
 *
 * A nested heading was already reachable before that change as a non-first child
 * (`- text` then an indented `## Sub`), so the guard was always needed; #1664
 * made the ordinary CommonMark spelling loadable and the case common.
 *
 * Mirrors the same guard in `heading-collapse.ts`, which walks for the collapse
 * chevron — the two must agree on what a section is.
 *
 * `forEach` rather than `descendants`, which makes "top-level only" structural
 * instead of a filter applied after visiting everything: `descendants` walks
 * every node in the document when nothing but a direct child of `doc` can ever
 * be accepted. That matters because this is a per-keystroke path —
 * `useHeadings.svelte.ts` re-runs it on every editor `update` — and the walk is
 * ~5-13x the work on real documents. `forEach`'s offset IS the absolute position
 * for a direct child of `doc`, so `pos` is unchanged.
 */
export function walkHeadings(ed: Editor): HeadingEntry[] {
  const result: HeadingEntry[] = [];
  ed.state.doc.forEach((node, offset) => {
    if (node.type.name !== "heading") return;
    if (node.attrs.level <= 3) {
      result.push({ text: node.textContent, level: node.attrs.level as number, pos: offset });
    }
  });
  return result;
}
