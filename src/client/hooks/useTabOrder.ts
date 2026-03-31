import { useState, useCallback, useEffect, useMemo } from "react";
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
  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);
  useEffect(() => {
    setLocalOrder((prev) => {
      const reconciled = reconcileOrder(prev, tabIds);
      if (prev.length === reconciled.length && prev.every((id, i) => id === reconciled[i])) {
        return prev;
      }
      return reconciled;
    });
  }, [tabIds]);

  const reorder = useCallback(
    function reorder(fromId: string, toId: string, side: "left" | "right" = "left") {
      if (fromId === toId) return;
      const validIds = new Set(tabIds);
      setLocalOrder((prev) => applyReorder(prev, fromId, toId, validIds, side));
    },
    [tabIds],
  );

  return { orderedTabs, reorder };
}
