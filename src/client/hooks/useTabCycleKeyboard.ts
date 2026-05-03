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

// React hook removed — utilities migrated to useTabCycleKeyboard.svelte.ts
