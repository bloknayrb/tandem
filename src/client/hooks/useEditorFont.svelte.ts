import { applyEditorFont, applyEditorFontToRoot, type EditorFontKey } from "./useEditorFont.js";

export { applyEditorFont, applyEditorFontToRoot, type EditorFontKey } from "./useEditorFont.js";

/**
 * Svelte 5 effect that applies --tandem-editor-font-family to a specific
 * element whenever the font setting changes. Used when scoped override is
 * needed (e.g. a single editor container).
 */
export function createEditorFont(
  getFont: () => EditorFontKey,
  getEl: () => HTMLElement | null,
): void {
  $effect(() => {
    const el = getEl();
    if (!el) return;
    const font = getFont();
    const cleanup = applyEditorFont(font, el);
    return cleanup;
  });
}

/**
 * Svelte 5 effect that applies --tandem-editor-font-family to
 * document.documentElement whenever the font setting changes. Use this in
 * App.svelte so the font propagates to all surfaces (tabs, toolbar, editor).
 */
export function createRootEditorFont(getFont: () => EditorFontKey): void {
  $effect(() => {
    const cleanup = applyEditorFontToRoot(getFont());
    return cleanup;
  });
}
