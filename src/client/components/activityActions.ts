import type { ActivityItem } from "../hooks/useNotifications.svelte";

/** A resolved, actionable affordance for an activity row. */
export interface ActivityAction {
  /** What App's `onAction` does: re-run the failed save, or open the Version history. */
  kind: "retry-save" | "view-backups";
  label: string;
  /** The document the action targets (the failed save's doc, or the one whose edits were kept). */
  documentId: string;
}

/**
 * Maps an activity item to its row action, or null if it has none. Pure (no
 * runes / no `triggerSave` import) so it's trivially unit-testable and is the
 * single source of truth for both the tray (button visibility + label) and
 * App's `onAction` handler (which performs the side effect).
 *
 * `save-error` re-runs the save for the failed doc. `unsaved-edits-kept`
 * (ADR-057) opens the Version history, where the kept edits are one Restore
 * away. A notice has no revert of its own: undo lives in that list.
 */
export function resolveActivityAction(item: ActivityItem): ActivityAction | null {
  if (item.type === "save-error" && item.documentId) {
    return { kind: "retry-save", label: "Retry", documentId: item.documentId };
  }
  if (item.type === "unsaved-edits-kept" && item.documentId) {
    return { kind: "view-backups", label: "View", documentId: item.documentId };
  }
  return null;
}
