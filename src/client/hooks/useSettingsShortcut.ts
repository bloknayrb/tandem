// `e.code` (not `e.key`) so non-QWERTY layouts still hit; bail during IME.
//
// Reject Shift because Wave 1 routes `Ctrl+Shift+,` to the new SettingsModal
// (see `isSettingsModalShortcut` below). Without the `!shiftKey` guard,
// Ctrl+Shift+, would match this predicate first and open the popover.
export function isSettingsShortcut(
  e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing">,
): boolean {
  if (e.isComposing) return false;
  if (e.code !== "Comma") return false;
  if (e.shiftKey) return false;
  return e.ctrlKey || e.metaKey;
}

/**
 * Wave 1 shortcut for opening the new `SettingsModal` (sibling to the popover).
 * Wave 2 retires the popover; this predicate becomes the only settings
 * shortcut at that point.
 */
export function isSettingsModalShortcut(
  e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing">,
): boolean {
  if (e.isComposing) return false;
  if (e.code !== "Comma") return false;
  if (!e.shiftKey) return false;
  return e.ctrlKey || e.metaKey;
}
