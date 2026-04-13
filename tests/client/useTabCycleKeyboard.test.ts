import { describe, expect, it } from "vitest";
import { cycleTab } from "../../src/client/hooks/useTabCycleKeyboard.js";

const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("cycleTab", () => {
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

  it("returns null with zero tabs", () => {
    expect(cycleTab([], null, false)).toBeNull();
  });

  it("handles unknown activeTabId by cycling from index -1", () => {
    // findIndex returns -1, so (-1 + 1 + 3) % 3 = 0 → first tab
    expect(cycleTab(tabs, "unknown", false)).toBe("a");
  });
});
