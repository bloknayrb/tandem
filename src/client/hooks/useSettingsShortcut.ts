import { useEffect } from "react";

/**
 * Pure matcher so the hotkey logic can be unit-tested without a DOM.
 * `e.code === "Comma"` survives AZERTY/QWERTZ/IME layouts where `,` lives on
 * a different physical key; QWERTZ users must Shift to type it, so the shifted
 * form is accepted. Bail during IME composition.
 */
export function isSettingsShortcut(
  e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "isComposing">,
): boolean {
  if (e.isComposing) return false;
  if (e.code !== "Comma") return false;
  return e.ctrlKey || e.metaKey;
}

/** Ctrl+, / Cmd+, opens the Settings popover. */
export function useSettingsShortcut(onOpen: () => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isSettingsShortcut(e)) return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}
