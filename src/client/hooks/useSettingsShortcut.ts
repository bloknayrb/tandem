import { useEffect } from "react";

// `e.code` (not `e.key`) so non-QWERTY layouts still hit; bail during IME.
export function isSettingsShortcut(
  e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "isComposing">,
): boolean {
  if (e.isComposing) return false;
  if (e.code !== "Comma") return false;
  return e.ctrlKey || e.metaKey;
}

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
