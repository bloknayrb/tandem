import { useEffect } from "react";

/**
 * Keyboard event handler for annotation review mode.
 * Handles Tab/Shift+Tab (navigate), Y (accept), N (dismiss),
 * E (examine/exit to annotation), Escape (exit review or cancel bulk),
 * and Ctrl+Shift+R (toggle review mode).
 */
export function useReviewKeyboard(
  reviewMode: boolean,
  callbacks: {
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
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.shiftKey && e.key === "R") {
        e.preventDefault();
        callbacks.onToggleReviewMode();
        return;
      }

      if (!reviewMode) return;

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
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [reviewMode, callbacks]);
}
