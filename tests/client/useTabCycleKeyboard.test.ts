import { describe, expect, it } from "vitest";

/**
 * Tests for the tab-cycling logic used by useTabCycleKeyboard.
 * Extracted to avoid needing a full React/DOM environment.
 */

function cycleTab(
  tabs: { id: string }[],
  activeTabId: string | null,
  shiftKey: boolean,
): string | null {
  if (tabs.length < 2) return null;
  const currentIdx = tabs.findIndex((t) => t.id === activeTabId);
  const direction = shiftKey ? -1 : 1;
  const nextIdx = (currentIdx + direction + tabs.length) % tabs.length;
  return tabs[nextIdx].id;
}

const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("tab cycle logic", () => {
  it("cycles forward from first tab", () => {
    expect(cycleTab(tabs, "a", false)).toBe("b");
  });

  it("cycles forward from last tab wraps to first", () => {
    expect(cycleTab(tabs, "c", false)).toBe("a");
  });

  it("cycles backward from first tab wraps to last", () => {
    expect(cycleTab(tabs, "a", true)).toBe("c");
  });

  it("cycles backward from middle tab", () => {
    expect(cycleTab(tabs, "b", true)).toBe("a");
  });

  it("returns null with fewer than 2 tabs", () => {
    expect(cycleTab([{ id: "only" }], "only", false)).toBeNull();
  });

  it("handles unknown activeTabId by cycling from index -1", () => {
    // findIndex returns -1, so (-1 + 1 + 3) % 3 = 0 → first tab
    expect(cycleTab(tabs, "unknown", false)).toBe("a");
  });
});
