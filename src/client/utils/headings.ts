import type { Editor } from "@tiptap/core";

export type HeadingEntry = { text: string; level: number; pos: number };

/**
 * Every heading in the document, nested ones included — for NAVIGATION.
 *
 * The command palette's `#` jump uses this: a heading inside a list item or a
 * blockquote is still a heading the reader can see and wants to jump to, so
 * excluding it would drop a destination for no benefit.
 *
 * `descendants`, not `forEach`, precisely because nested headings must be found.
 * That is affordable here — the palette walks on demand, only while the `#`
 * prefix is active — which is why this is a separate function from
 * `walkSectionHeadings` rather than a flag on one.
 */
export function walkHeadings(ed: Editor): HeadingEntry[] {
  const result: HeadingEntry[] = [];
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    if (node.attrs.level <= 3) {
      result.push({ text: node.textContent, level: node.attrs.level as number, pos });
    }
    // A heading holds only inline content — nothing under it can be a heading.
    return false;
  });
  return result;
}

/**
 * Top-level headings only — for anything treating a heading as a SECTION.
 *
 * `OutlinePanel` derives section boundaries from consecutive entries
 * (`sectionEnd = headings[i + 1].pos`) to bucket annotations, so every entry it
 * receives becomes a document section. A heading nested in a list item is not a
 * section: counting one would list a bullet as a document heading and skew every
 * bucket after it.
 *
 * A nested heading was always reachable — `- text` followed by an indented
 * `## Sub` has always parsed — so this distinction was always needed; #1664
 * widening `listItem` to `block+` made the ordinary spelling (`- # Section`)
 * loadable and the case common. `heading-collapse.ts` applies the same rule for
 * its chevron; the two must agree on what a section is.
 *
 * `forEach` rather than `descendants` makes "top-level only" structural instead
 * of a filter applied after visiting everything, which matters because
 * `useHeadings.svelte.ts` re-runs this on every editor `update` — per keystroke.
 * `forEach`'s offset IS the absolute position for a direct child of `doc`.
 */
export function walkSectionHeadings(ed: Editor): HeadingEntry[] {
  const result: HeadingEntry[] = [];
  ed.state.doc.forEach((node, offset) => {
    if (node.type.name !== "heading") return;
    if (node.attrs.level <= 3) {
      result.push({ text: node.textContent, level: node.attrs.level as number, pos: offset });
    }
  });
  return result;
}
