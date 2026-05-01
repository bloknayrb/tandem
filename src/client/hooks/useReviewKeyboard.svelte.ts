import { onDestroy, onMount } from "svelte";

/**
 * Svelte 5 port of `useReviewKeyboard`.
 *
 * Keyboard event handler for annotation review mode. Handles Tab/Shift+Tab
 * (navigate), Y (accept), N (dismiss), E (examine/exit to annotation),
 * Escape (exit review or cancel bulk), and Ctrl+Shift+R (toggle review mode).
 *
 * Accepts getter functions for `reviewMode` and `callbacks` so changes
 * propagate without re-registering the listener.
 */
export function createReviewKeyboard(
  getReviewMode: () => boolean,
  getCallbacks: () => {
    onToggleReviewMode: () => void;
    onExitReviewMode: () => void;
    navigateReview: (direction: "next" | "prev") => void;
    acceptCurrent: () => void;
    dismissCurrent: () => void;
    scrollToCurrentAndExit: () => void;
    cancelBulkOrExit: () => void;
    undoLast: () => void;
  },
): void {
  let handler: ((e: KeyboardEvent) => void) | null = null;

  onMount(() => {
    handler = (e: KeyboardEvent) => {
      const callbacks = getCallbacks();

      if (e.ctrlKey && e.shiftKey && e.key === "R") {
        e.preventDefault();
        callbacks.onToggleReviewMode();
        return;
      }

      if (!getReviewMode()) return;

      if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        callbacks.navigateReview(e.shiftKey ? "prev" : "next");
      } else if (e.key === "y" || e.key === "Y") {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        callbacks.acceptCurrent();
      } else if (e.key === "n" || e.key === "N") {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        callbacks.dismissCurrent();
      } else if (e.key === "z" || e.key === "Z") {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        callbacks.undoLast();
      } else if (e.key === "e" || e.key === "E") {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        callbacks.scrollToCurrentAndExit();
      } else if (e.key === "Escape") {
        callbacks.cancelBulkOrExit();
      }
    };
    window.addEventListener("keydown", handler);
  });

  onDestroy(() => {
    if (handler) window.removeEventListener("keydown", handler);
  });
}
