import type { TandemNotification } from "../../shared/types";
import { generateNotificationId } from "../../shared/utils";
import type { ToastAction } from "../hooks/useNotifications.svelte";

interface Deps {
  /** Writes `dismissed` (the same path as Dismiss). */
  resolve: (id: string) => void;
  undo: (id: string) => boolean;
  /**
   * The record's current status, read fresh. `resolve` is a silent no-op on a
   * record that is no longer pending (Claude just dismissed it, or a double
   * click), and announcing "resolved" would then offer an Undo that reopens
   * someone else's dismissal. Read before AND after: only pending -> dismissed
   * is a write this click made.
   */
  getStatus: (id: string) => string | undefined;
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
  const { resolve, undo, getStatus, push, docId, getActiveDocId } = deps;
  const before = getStatus(id);
  resolve(id);
  if (before !== "pending" || getStatus(id) !== "dismissed") return;
  const notice = (message: string, documentId?: string): TandemNotification => ({
    id: generateNotificationId(),
    type: "annotation-resolved",
    severity: "info",
    message,
    documentId,
    timestamp: Date.now(),
  });
  push(notice("Comment resolved.", docId), {
    label: "Undo",
    onClick: () => {
      // The toast container dismisses this toast after the click whatever it
      // does, so a decline must name the Undo that is still left: the side
      // panel's resolved list (the id stays in `recentlyResolved`).
      if (getActiveDocId() !== docId) {
        push(
          notice("Switch back to that document to undo it from the side panel's resolved list."),
        );
        return;
      }
      if (!undo(id)) {
        // `undo` also declines a record that is already pending again (reopened
        // from the side panel); "changed" would misdescribe that one.
        push(
          notice(
            getStatus(id) === "pending"
              ? "That comment is already open again."
              : "Couldn't undo — the comment has changed.",
          ),
        );
      }
    },
  });
}
