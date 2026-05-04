import { applyEditorFont, type EditorFontKey } from "./useEditorFont.js";

export { applyEditorFont, type EditorFontKey } from "./useEditorFont.js";

/**
 * Svelte 5 effect that applies --tandem-editor-font-family to the editor
 * container element whenever the font setting changes. Accepts getters so
 * callers with $state values propagate reactively.
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
