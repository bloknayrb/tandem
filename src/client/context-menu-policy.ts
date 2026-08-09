// Global context-menu allowlist policy — issue #994.
//
// The WebView's default `contextmenu` (Reload/Back/Inspect in dev, a bare
// blank menu in production) leaks through on any app chrome that isn't one of
// the four #923-owned surfaces (editor, tabs, annotation cards). Those four
// surfaces each own a bubble-phase `contextmenu` listener that calls
// `preventDefault()` only when it resolves an actionable target — blank
// padding around them falls through with no `preventDefault`, which is
// exactly the stray-native-menu class this module exists to close.
//
// Design: ONE capture-phase listener on `document`, installed once for the
// app's lifetime, that defaults to `preventDefault()` and opts specific
// surfaces OUT of suppression via `closest()`. Because it runs in the CAPTURE
// phase and returns without calling `preventDefault`/`stopPropagation` when
// the target is allowed, it defers cleanly to the four existing bubble-phase
// listeners — they still run afterward and apply their own (more granular)
// logic for the surfaces they own. See docs/triage/2026-08-06/brief-994.md.
//
// Applies in BOTH the Tauri desktop build and the plain-browser distribution
// — it is a client-side DOM listener with no Tauri dependency. In the
// browser, none of the four existing handlers intercept `contextmenu` at all
// (they early-return via `isTauriRuntime()`), so this module is the ONLY
// thing standing between a right-click and the native menu there; the same
// allowlist selectors keep Copy alive on exactly the surfaces that need it.
//
// NEVER use Tauri's `Flags::CONTEXT_MENU` for this — it is a window-level
// flag that would take the menu away from the editor and inputs too. The
// allowlist has to live here, per surface, client-side.

/**
 * Selectors matched via `closest()` against the `contextmenu` event target.
 * A match means "let the native/existing menu through" — do NOT preventDefault.
 *
 * - `.ProseMirror` — the exact node Tiptap attaches to (verified: `.tandem-editor`
 *   IS `.ProseMirror`, Tiptap stacks both classes on one node — see
 *   `editor/editor.css`'s comment above the `.tandem-editor .ProseMirror` rule).
 *   Matching a wrapper that isn't an ancestor of all editor content would
 *   silently break the macOS Look-Up/Services/spellcheck passthrough
 *   (`context-menu/detect.ts`) with no error.
 * - `[data-testid^="tab-"][role="tab"]` — the tab pill itself, not the
 *   `tab-scroll-container` wrapper (which also matches a bare
 *   `[data-testid^="tab-"]` prefix — the `[role="tab"]` qualifier is what
 *   excludes it). Matches the selector `DocumentTabs.svelte` itself uses to
 *   resolve a right-clicked tab (`closest('[data-testid^="tab-"][role="tab"]')`).
 * - `[data-annotation-id]` — the annotation card itself, not the list
 *   container. `annotation-context-menu-host.ts` is NOT a DOM target (pure
 *   gesture bookkeeping) — the card element is what carries the attribute.
 * - `input`, `textarea`, `[contenteditable]` — real form/editable surfaces.
 * - `[data-allow-context-menu]` — explicit per-surface marker for text a user
 *   plausibly wants to copy via the native menu (chat messages, annotation
 *   composer text, read-only info panels, copyable CLI/URL snippets).
 * - `.iw-code`, `.iw-code-inline` — `IntegrationWizardModal.svelte`'s shared
 *   classes for copyable CLI commands / URLs / env-var names (8 call sites);
 *   listed here instead of `data-allow-context-menu` at each site since the
 *   class itself already means "this is a copyable snippet".
 */
export const CONTEXT_MENU_ALLOW_SELECTOR =
  '.ProseMirror, [data-testid^="tab-"][role="tab"], [data-annotation-id], input, textarea, [contenteditable], [data-allow-context-menu], .iw-code, .iw-code-inline';

/** True if `target` (or an ancestor) matches the allowlist. */
export function isContextMenuAllowed(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(CONTEXT_MENU_ALLOW_SELECTOR) !== null;
}

/**
 * Install the global allowlist policy on `doc` (defaults to `document`).
 * Capture-phase, defaults to suppress, opts in via {@link isContextMenuAllowed}.
 * Returns a teardown (mainly for tests — this is installed once for the
 * app's lifetime in `main.ts` and never torn down in production).
 */
export function installGlobalContextMenuPolicy(doc: Document = document): () => void {
  const onContextMenu = (e: MouseEvent) => {
    if (isContextMenuAllowed(e.target)) return; // defer to native/existing handling
    e.preventDefault();
  };
  doc.addEventListener("contextmenu", onContextMenu, { capture: true });
  return () => doc.removeEventListener("contextmenu", onContextMenu, { capture: true });
}
