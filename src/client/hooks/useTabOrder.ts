import type { OpenTab } from "../types";

export interface UseTabOrderResult {
  orderedTabs: OpenTab[];
  reorder: (fromId: string, toId: string, side?: "left" | "right") => void;
}

/**
 * Reconcile a local ordering with the current set of tab IDs.
 * Preserves existing order, appends new IDs, prunes removed ones.
 */
export function reconcileOrder(localOrder: string[], tabIds: string[]): string[] {
  const idSet = new Set(tabIds);
  const preserved = localOrder.filter((id) => idSet.has(id));
  const preservedSet = new Set(preserved);
  const newIds = tabIds.filter((id) => !preservedSet.has(id));
  return [...preserved, ...newIds];
}

/**
 * Move `fromId` relative to `toId` in the order.
 * When `side` is 'left' (default), inserts before `toId`.
 * When `side` is 'right', inserts after `toId`.
 * Returns a new array, or the filtered current array if either ID is missing.
 */
export function applyReorder(
  order: string[],
  fromId: string,
  toId: string,
  validIds: Set<string>,
  side: "left" | "right" = "left",
): string[] {
  const current = order.filter((id) => validIds.has(id));
  const fromIdx = current.indexOf(fromId);
  const toIdx = current.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) return current;

  const next = [...current];
  next.splice(fromIdx, 1);
  const targetIdx = next.indexOf(toId);
  const insertIdx = side === "right" ? targetIdx + 1 : targetIdx;
  next.splice(insertIdx, 0, fromId);
  return next;
}
