import { useEffect, useRef } from "react";

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
      const tabs = tabsRef.current;
      if (tabs.length < 2) return;

      e.preventDefault();

      const currentIdx = tabs.findIndex((t) => t.id === activeRef.current);
      const direction = e.shiftKey ? -1 : 1;
      const nextIdx = (currentIdx + direction + tabs.length) % tabs.length;
      setActiveTabId(tabs[nextIdx].id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setActiveTabId]);
}
