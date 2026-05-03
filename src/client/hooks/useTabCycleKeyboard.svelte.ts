import { onDestroy, onMount } from "svelte";
import { cycleTab } from "./useTabCycleKeyboard.js";

/**
 * Svelte 5 port of `useTabCycleKeyboard`.
 *
 * Uses getter functions so the latest tabs / activeTabId are always read
 * inside the keydown handler without re-registering the listener.
 */
export function createTabCycleKeyboard(
  getTabs: () => Array<{ id: string }>,
  getActiveTabId: () => string | null,
  setActiveTabId: (id: string) => void,
): void {
  let handler: ((e: KeyboardEvent) => void) | null = null;

  onMount(() => {
    handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key !== "Tab") return;

      const nextId = cycleTab(getTabs(), getActiveTabId(), e.shiftKey);
      if (!nextId) return;

      e.preventDefault();
      setActiveTabId(nextId);
    };
    window.addEventListener("keydown", handler);
  });

  onDestroy(() => {
    if (handler) window.removeEventListener("keydown", handler);
  });
}
