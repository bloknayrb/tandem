// `e.code` (not `e.key`) so non-QWERTY layouts still hit; bail during IME.
export function isSettingsShortcut(
  e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "isComposing">,
): boolean {
  if (e.isComposing) return false;
  if (e.code !== "Comma") return false;
  return e.ctrlKey || e.metaKey;
}
