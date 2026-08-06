import type { Editor as TiptapEditor } from "@tiptap/core";
import "@tiptap/extension-link";

/**
 * `withPreventDefault` is the canonical handler shape for toolbar buttons
 * that toggle a mark or run an editor command. Binding to `mousedown` (not
 * `click`) and calling `preventDefault()` first keeps the editor selection
 * intact so the command applies to the user's range — without this, the
 * button steals focus, the selection collapses, and any subsequent
 * `toggleMark`/`toggleBold`/etc. runs against an empty selection (the
 * "format-before-type" symptom).
 */
export function withPreventDefault(command: () => void): (e: MouseEvent) => void {
  return (e: MouseEvent) => {
    e.preventDefault();
    command();
  };
}

/**
 * Keyboard half of the toolbar handler pair. Enter/Space on a focused button
 * fires `click` with `detail === 0`; the mouse path binds `mousedown` +
 * `preventDefault()` (see `withPreventDefault`) so the editor selection
 * survives. Pair `onMouseDown={h}` with `onClick={onKeyActivate(h)}` so both
 * routes work without double-firing.
 *
 * The opposite case to `utils/keyboard-activate.ts`, which exists for NON-native
 * interactive elements: a native `<button>` already synthesises the click, and
 * the `detail === 0` filter is what stops that synthesised click re-running the
 * mousedown handler.
 */
export function onKeyActivate(handler: (e: MouseEvent) => void): (e: MouseEvent) => void {
  return (e: MouseEvent) => {
    if (e.detail === 0) handler(e);
  };
}

/** Current link's `href` attribute, or `""` if the cursor isn't on a link. */
export function getInitialLinkHref(editor: TiptapEditor): string {
  const href = editor.getAttributes("link").href;
  if (href === undefined) return "";
  if (typeof href === "string") return href;
  console.warn("[tandem] getInitialLinkHref: non-string href attribute", { href });
  return "";
}

/**
 * Apply or unset a link mark on the current selection. Trims `url`; an empty
 * string while a link is active unsets it (lets the link-input double as a
 * remove affordance).
 */
export function applyLink(editor: TiptapEditor, url: string): void {
  const trimmed = url.trim();
  if (trimmed) {
    const chain = editor.chain().focus();
    if (editor.isActive("link")) chain.extendMarkRange("link");
    chain.setLink({ href: trimmed }).run();
  } else if (editor.isActive("link")) {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
  }
}
