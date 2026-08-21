import type { Editor as TiptapEditor } from "@tiptap/core";
import "@tiptap/extension-link";
import type { TandemNotification } from "../../../shared/types.js";
import { SAFE_EXTERNAL_PREFIXES } from "../utils/url-safety.js";

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
 * The notification a REFUSED authoring attempt raises (#1537).
 *
 * `setLink` consults the same `isAllowedUri` union as render, so since the
 * scheme allowlist landed, typing `tel:+15551234` into the Link editor returns
 * `false` and writes nothing. Before the allowlist it succeeded. A silent
 * no-op is therefore STRICTLY LESS visible than the behaviour it replaced —
 * the opposite of what the change is for. `openHref` got `notifyLinkProblem`
 * for exactly this reason in #1377; the authoring path never got the
 * equivalent, and this is it.
 *
 * Past tense deliberately: `warning` persists in the activity tray, which is a
 * log, so a present-tense observation would outlive the moment it describes
 * (the convention on `TandemNotification.severity`).
 */
function linkRefusedNotification(href: string): TandemNotification {
  return {
    id: `link-problem-${Date.now()}`,
    type: "general-error",
    severity: "warning",
    message: `Didn't create the link — Tandem can't link to "${href}". A link must start with ${SAFE_EXTERNAL_PREFIXES.join(", ")} or be a path relative to this document.`,
    dedupKey: `link-authoring-refused:${href}`,
    timestamp: Date.now(),
    errorCode: "LINK_NOT_OPENABLE",
  };
}

/**
 * Apply or unset a link mark on the current selection. Trims `url`; an empty
 * string while a link is active unsets it (lets the link-input double as a
 * remove affordance).
 *
 * Returns whether the editor accepted the command. `false` means the render
 * gate refused the href — see {@link linkRefusedNotification}. Pass `onNotify`
 * (every caller in the app does) so the refusal is SAID rather than swallowed;
 * the return value is there for tests and for a caller that wants to react
 * differently, not as an alternative to reporting.
 */
export function applyLink(
  editor: TiptapEditor,
  url: string,
  onNotify?: (n: TandemNotification) => void,
): boolean {
  const trimmed = url.trim();
  if (trimmed) {
    const chain = editor.chain().focus();
    if (editor.isActive("link")) chain.extendMarkRange("link");
    const applied = chain.setLink({ href: trimmed }).run();
    if (!applied) onNotify?.(linkRefusedNotification(trimmed));
    return applied;
  }
  if (editor.isActive("link")) {
    return editor.chain().focus().extendMarkRange("link").unsetLink().run();
  }
  return true;
}
