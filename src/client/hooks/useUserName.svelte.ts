import { onDestroy } from "svelte";
import { persistUserName, readStoredName, subscribeToUserName } from "./useUserName.js";

export interface UserNameState {
  readonly userName: string;
  setUserName: (next: string) => void;
}

/**
 * Svelte 5 port of `useUserName`.
 *
 * Shared display-name state. Persists to localStorage and broadcasts via a
 * custom event so every in-tab subscriber updates together; the `storage`
 * event covers cross-tab.
 */
export function createUserName(): UserNameState {
  let userName = $state(readStoredName());

  const unsubscribe = subscribeToUserName((name) => {
    userName = name;
  });

  onDestroy(unsubscribe);

  const setUserName = (next: string) => {
    const trimmed = persistUserName(next);
    userName = trimmed;
  };

  return {
    get userName() {
      return userName;
    },
    setUserName,
  };
}
