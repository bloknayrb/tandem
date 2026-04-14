import { useCallback, useEffect, useState } from "react";
import { USER_NAME_DEFAULT, USER_NAME_EVENT, USER_NAME_KEY } from "../../shared/constants";

export function resolveUserName(stored: string | null | undefined): string {
  return stored?.trim() || USER_NAME_DEFAULT;
}

export function readStoredName(): string {
  try {
    return resolveUserName(localStorage.getItem(USER_NAME_KEY));
  } catch {
    return USER_NAME_DEFAULT;
  }
}

/**
 * Persist a display name to localStorage and broadcast the change so other
 * hook instances (StatusBar, Settings popover, Editor cursor) pick it up
 * in-tab. Pure — no React — so the write+notify contract is testable.
 * Returns the trimmed value actually written.
 */
export function persistUserName(name: string): string {
  const trimmed = resolveUserName(name);
  try {
    localStorage.setItem(USER_NAME_KEY, trimmed);
  } catch {
    // localStorage unavailable (incognito/storage-disabled) — in-memory only.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(USER_NAME_EVENT));
  }
  return trimmed;
}

/**
 * Shared display-name state. Persists to localStorage and broadcasts via a
 * custom event so every in-tab subscriber updates together; the `storage`
 * event covers cross-tab.
 */
export function useUserName(): {
  userName: string;
  setUserName: (next: string) => void;
} {
  const [userName, setUserNameState] = useState(readStoredName);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== USER_NAME_KEY) return;
      setUserNameState(resolveUserName(e.newValue));
    };
    const onCustom = () => setUserNameState(readStoredName());
    window.addEventListener("storage", onStorage);
    window.addEventListener(USER_NAME_EVENT, onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(USER_NAME_EVENT, onCustom);
    };
  }, []);

  const setUserName = useCallback((next: string) => {
    const trimmed = persistUserName(next);
    setUserNameState(trimmed);
  }, []);

  return { userName, setUserName };
}
