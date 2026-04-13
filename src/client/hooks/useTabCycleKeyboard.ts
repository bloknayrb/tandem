import { useEffect, useRef } from "react";

/** Pure cycling logic — exported for direct testing. */
export function cycleTab(
  tabs: Array<{ id: string }>,
  activeTabId: string | null,
  shiftKey: boolean,
): string | null {
  if (tabs.length < 2) return null;
  const currentIdx = tabs.findIndex((t) => t.id === activeTabId);
  const direction = shiftKey ? -1 : 1;
  const nextIdx = (currentIdx + direction + tabs.length) % tabs.length;
  return tabs[nextIdx].id;
}

/**
 * Ctrl+Tab / Ctrl+Shift+Tab to cycle through document tabs.
 * Registers a single listener on mount; refs avoid churn on every tab switch.
 */
export function useTabCycleKeyboard(
  orderedTabs: Array<{ id: string }>,
  activeTabId: string | null,
  setActiveTabId: (id: string) => void,
): void {
  const tabsRef = useRef(orderedTabs);
  tabsRef.current = orderedTabs;
  const activeRef = useRef(activeTabId);
  activeRef.current = activeTabId;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key !== "Tab") return;

      const nextId = cycleTab(tabsRef.current, activeRef.current, e.shiftKey);
      if (!nextId) return;

      e.preventDefault();
      setActiveTabId(nextId);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setActiveTabId]);
}
