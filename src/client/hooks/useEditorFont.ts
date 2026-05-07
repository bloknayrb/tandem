import type { EditorFont } from "./useTandemSettings.js";

const FONT_STACKS: Record<EditorFont, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: '"JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
};

/** @deprecated Use {@link EditorFont} from useTandemSettings instead. */
export type EditorFontKey = EditorFont;

export function applyEditorFont(font: EditorFont, el: HTMLElement): () => void {
  el.style.setProperty("--tandem-editor-font-family", FONT_STACKS[font]);
  return () => el.style.removeProperty("--tandem-editor-font-family");
}

export function applyEditorFontToRoot(font: EditorFont): () => void {
  const root = document.documentElement;
  root.style.setProperty("--tandem-editor-font-family", FONT_STACKS[font]);
  return () => root.style.removeProperty("--tandem-editor-font-family");
}
