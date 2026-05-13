import { applyEditorFontToRoot, type EditorFontKey } from "./useEditorFont.js";

export { applyEditorFont, applyEditorFontToRoot, type EditorFontKey } from "./useEditorFont.js";

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
