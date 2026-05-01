import type { OpenTab } from "../types.js";
import { applyReorder, reconcileOrder } from "./useTabOrder.js";

export interface TabOrderState {
  readonly orderedTabs: OpenTab[];
  reorder: (fromId: string, toId: string, side?: "left" | "right") => void;
}

/**
 * Svelte 5 port of `useTabOrder`.
 *
 * Client-local tab ordering. Reconciles server-broadcast tabs with a local
 * ordering preference — preserving user reorder operations while tracking
 * additions and removals from the server.
 *
 * Accepts a getter for `tabs` so callers with `$state` values propagate reactively.
 */
export function createTabOrder(getTabs: () => OpenTab[]): TabOrderState {
  let localOrder = $state<string[]>([]);

  // Sync localOrder when tabs change (additions/removals from server).
  $effect(() => {
    const tabs = getTabs();
    const tabIds = tabs.map((t) => t.id);
    const reconciled = reconcileOrder(localOrder, tabIds);
    // Only update if something actually changed to avoid infinite loops
    if (
      localOrder.length !== reconciled.length ||
      localOrder.some((id, i) => id !== reconciled[i])
    ) {
      localOrder = reconciled;
    }
  });

  const orderedTabs = $derived.by(() => {
    const tabs = getTabs();
    const tabMap = new Map(tabs.map((t) => [t.id, t]));
    const tabIds = tabs.map((t) => t.id);
    const merged = reconcileOrder(localOrder, tabIds);
    return merged.map((id) => tabMap.get(id)).filter(Boolean) as OpenTab[];
  });

  const reorder = (fromId: string, toId: string, side: "left" | "right" = "left") => {
    if (fromId === toId) return;
    const tabs = getTabs();
    const validIds = new Set(tabs.map((t) => t.id));
    localOrder = applyReorder(localOrder, fromId, toId, validIds, side);
  };

  return {
    get orderedTabs() {
      return orderedTabs;
    },
    reorder,
  };
}
