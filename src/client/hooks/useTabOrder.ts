import { useState, useCallback, useMemo } from "react";
import type { OpenTab } from "../types";

export interface UseTabOrderResult {
  orderedTabs: OpenTab[];
  reorder: (fromId: string, toId: string) => void;
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
 * Move `fromId` so it appears immediately before `toId` in the order.
 * Returns a new array, or the original if either ID is missing.
 */
export function applyReorder(
  order: string[],
  fromId: string,
  toId: string,
  validIds: Set<string>,
): string[] {
  const current = order.filter((id) => validIds.has(id));
  const fromIdx = current.indexOf(fromId);
  const toIdx = current.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) return order;

  const next = [...current];
  next.splice(fromIdx, 1);
  const insertIdx = next.indexOf(toId);
  next.splice(insertIdx, 0, fromId);
  return next;
}

/**
 * Client-local tab ordering hook. Reconciles server-broadcast tabs with a
 * local ordering preference — preserving user reorder operations while
 * tracking additions and removals from the server.
 */
export function useTabOrder(tabs: OpenTab[]): UseTabOrderResult {
  const [localOrder, setLocalOrder] = useState<string[]>([]);

  const orderedTabs = useMemo(() => {
    const tabMap = new Map(tabs.map((t) => [t.id, t]));
    const tabIds = tabs.map((t) => t.id);
    const merged = reconcileOrder(localOrder, tabIds);
    return merged.map((id) => tabMap.get(id)).filter(Boolean) as OpenTab[];
  }, [tabs, localOrder]);

  // Sync localOrder when tabs change (additions/removals from server).
  // Uses functional setState to avoid a render-time setState warning.
  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);
  if (needsReconcile(localOrder, tabIds)) {
    setLocalOrder(reconcileOrder(localOrder, tabIds));
  }

  const reorder = useCallback(
    function reorder(fromId: string, toId: string) {
      if (fromId === toId) return;
      const validIds = new Set(tabIds);
      setLocalOrder((prev) => applyReorder(prev, fromId, toId, validIds));
    },
    [tabIds],
  );

  return { orderedTabs, reorder };
}

/** True when localOrder doesn't match the current tab set. */
function needsReconcile(localOrder: string[], tabIds: string[]): boolean {
  if (localOrder.length !== tabIds.length) return true;
  const idSet = new Set(tabIds);
  return localOrder.some((id) => !idSet.has(id));
}
