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

/** Current link's `href` attribute, or `""` if the cursor isn't on a link. */
export function getInitialLinkHref(editor: TiptapEditor): string {
  return (editor.getAttributes("link").href as string | undefined) ?? "";
}

/**
 * Apply or unset a link mark on the current selection. Trims `url`; an empty
 * string while a link is active unsets it (lets the link-input double as a
 * remove affordance).
 */
export function applyLink(editor: TiptapEditor, url: string): void {
  const trimmed = url.trim();
  if (trimmed) {
    editor.chain().focus().setLink({ href: trimmed }).run();
  } else if (editor.isActive("link")) {
    editor.chain().focus().unsetLink().run();
  }
}
