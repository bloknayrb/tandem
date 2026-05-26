import type { ActivityItem } from "../hooks/useNotifications.svelte";

/** A resolved, actionable affordance for an activity row. */
export interface ActivityAction {
  label: string;
  /** The document the action targets (the failed save's doc). */
  documentId: string;
}

/**
 * Maps an activity item to its row action, or null if it has none. Pure (no
 * runes / no `triggerSave` import) so it's trivially unit-testable and is the
 * single source of truth for both the tray (button visibility + label) and
 * App's `onAction` handler (which performs the side effect).
 *
 * v1: only `save-error` carries a safe production semantic — re-run the save
 * for the failed doc. Undo is deferred (no notification has a safe revert).
 */
export function resolveActivityAction(item: ActivityItem): ActivityAction | null {
  if (item.type === "save-error" && item.documentId) {
    return { label: "Retry", documentId: item.documentId };
  }
  return null;
}
