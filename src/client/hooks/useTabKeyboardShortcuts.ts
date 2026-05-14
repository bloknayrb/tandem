/** Map digit 1-9 to tab id, clamping to the last tab when fewer tabs are open. */
export function pickTabByDigit(tabs: ReadonlyArray<{ id: string }>, digit: number): string | null {
  if (tabs.length === 0) return null;
  if (digit < 1 || digit > 9) return null;
  const idx = Math.min(digit - 1, tabs.length - 1);
  return tabs[idx].id;
}

/** Suppress shortcut firing when focus is in a form field or IME composing. */
export function shouldIgnoreShortcut(e: Pick<KeyboardEvent, "target" | "isComposing">): boolean {
  if (e.isComposing) return true;
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}
