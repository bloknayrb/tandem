import type { TandemNotification } from "../../shared/types";
import { generateNotificationId } from "../../shared/utils";
import type { ToastAction } from "../hooks/useNotifications.svelte";

interface Deps {
  /** Writes `dismissed` (the same path as Dismiss). */
  resolve: (id: string) => void;
  undo: (id: string) => boolean;
  /**
   * Did the write land? `resolve` is a silent no-op on a record that is no longer
   * pending (Claude just dismissed it, say), and announcing "resolved" would then
   * offer an Undo that reopens someone else's dismissal.
   */
  wasResolved: (id: string) => boolean;
  push: (notification: TandemNotification, action?: ToastAction) => void;
  /** Document the comment lives in, captured when the user clicked Resolve. */
  docId: string | undefined;
  /** Read at Undo time, not captured: it is the point of the guard. */
  getActiveDocId: () => string | undefined;
}

/**
 * Margin-view Resolve (#2360) with its Undo toast.
 *
 * The margin lists pending cards only, so a resolved bubble vanishes with no
 * inline Undo (the side panel keeps one in its resolved list); the toast is that
 * Undo. Each resolve gets a fresh id and NO `dedupKey`: a shared key would
 * coalesce two resolves into one "x2" toast whose Undo restores only the last,
 * and a key reused for the same comment would collide in the keyed toast list.
 *
 * `undoResolveAnnotation` reads the ACTIVE tab's document, so after a tab switch
 * it would find nothing, drop the panel's Undo entry and report nothing. The
 * toast declines instead, with a notice.
 */
export function resolveWithUndoToast(id: string, deps: Deps): void {
  const { resolve, undo, wasResolved, push, docId, getActiveDocId } = deps;
  resolve(id);
  if (!wasResolved(id)) return;
  push(
    {
      id: generateNotificationId(),
      type: "annotation-resolved",
      severity: "info",
      message: "Comment resolved.",
      documentId: docId,
      timestamp: Date.now(),
    },
    {
      label: "Undo",
      onClick: () => {
        if (getActiveDocId() !== docId) {
          push({
            id: generateNotificationId(),
            type: "annotation-resolved",
            severity: "info",
            message: "Switch back to that document to undo.",
            timestamp: Date.now(),
          });
          return;
        }
        undo(id);
      },
    },
  );
}
