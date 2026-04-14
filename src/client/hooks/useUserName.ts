import { useCallback, useEffect, useState } from "react";
import { USER_NAME_DEFAULT, USER_NAME_KEY } from "../../shared/constants";

const USER_NAME_EVENT = "tandem:user-name-changed";

export function resolveUserName(stored: string | null | undefined): string {
  return stored?.trim() || USER_NAME_DEFAULT;
}

function readStoredName(): string {
  try {
    return resolveUserName(localStorage.getItem(USER_NAME_KEY));
  } catch {
    return USER_NAME_DEFAULT;
  }
}

function writeStoredName(name: string): void {
  try {
    localStorage.setItem(USER_NAME_KEY, name);
  } catch {
    // localStorage unavailable (incognito/storage-disabled) — in-memory only.
  }
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
    const trimmed = resolveUserName(next);
    writeStoredName(trimmed);
    setUserNameState(trimmed);
    window.dispatchEvent(new Event(USER_NAME_EVENT));
  }, []);

  return { userName, setUserName };
}
