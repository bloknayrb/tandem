/**
 * Slash-menu D10 suppression rules.
 *
 * The slash menu must NOT activate while any of the following surfaces are present:
 *   - Find bar focused (testid `find-input`)
 *   - Command palette open (testid `command-palette`)
 *   - Selection BubbleMenu / annotation popup visible (one of the
 *     `popup-annotation-input`, `popup-note-submit`, `popup-comment-submit`,
 *     or `popup-highlight-{yellow|green|blue|pink}` testids)
 *
 * Reverse direction is wired in `App.svelte` -- the selection toolbar suppresses
 * itself when `slashCommandMenuOpen` is true (see `suppressSelectionToolbar` prop
 * on `Toolbar.svelte`).
 *
 * We probe via `document.querySelector` rather than threading a reactive store
 * through every consumer: cheap (single keystroke on `/`), avoids coupling the
 * Tiptap plugin to Svelte runes, and stays in sync with whatever UI is actually
 * mounted in the DOM.
 */

const POPUP_TESTIDS = [
  "popup-annotation-input",
  "popup-note-submit",
  "popup-comment-submit",
  "popup-highlight-yellow",
  "popup-highlight-green",
  "popup-highlight-blue",
  "popup-highlight-pink",
] as const;

function findFocused(testid: string): boolean {
  const el = document.querySelector(`[data-testid="${testid}"]`);
  if (!el) return false;
  return document.activeElement === el;
}

function anyPresent(testids: readonly string[]): boolean {
  for (const id of testids) {
    if (document.querySelector(`[data-testid="${id}"]`)) return true;
  }
  return false;
}

export function isSlashMenuSuppressed(): boolean {
  if (typeof document === "undefined") return false;
  if (findFocused("find-input")) return true;
  if (document.querySelector('[data-testid="command-palette"]')) return true;
  if (anyPresent(POPUP_TESTIDS)) return true;
  return false;
}
