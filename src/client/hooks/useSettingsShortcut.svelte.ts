import { onDestroy, onMount } from "svelte";
import { isSettingsShortcut } from "./useSettingsShortcut.js";

/**
 * Svelte 5 port of `useSettingsShortcut`.
 *
 * Registers a keydown listener on mount and removes it on destroy.
 * `onOpen` is called each time the shortcut fires — pass a stable reference
 * (or a wrapper) if the callback captures reactive state.
 */
export function createSettingsShortcut(getOnOpen: () => () => void): void {
  let handler: ((e: KeyboardEvent) => void) | null = null;

  onMount(() => {
    handler = (e: KeyboardEvent) => {
      if (!isSettingsShortcut(e)) return;
      e.preventDefault();
      getOnOpen()();
    };
    window.addEventListener("keydown", handler);
  });

  onDestroy(() => {
    if (handler) window.removeEventListener("keydown", handler);
  });
}
