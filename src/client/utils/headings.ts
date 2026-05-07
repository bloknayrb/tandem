import type { Editor } from "@tiptap/core";

export type HeadingEntry = { text: string; level: number; pos: number };

export function walkHeadings(ed: Editor): HeadingEntry[] {
  const result: HeadingEntry[] = [];
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading" && node.attrs.level <= 3) {
      result.push({ text: node.textContent, level: node.attrs.level as number, pos });
    }
  });
  return result;
}
