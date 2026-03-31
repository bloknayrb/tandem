import { describe, it, expect } from "vitest";
import { reconcileOrder, applyReorder } from "../../src/client/hooks/useTabOrder.js";

describe("reconcileOrder", () => {
  it("initial order matches tabs input order when localOrder is empty", () => {
    expect(reconcileOrder([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("preserves existing local order for known IDs", () => {
    expect(reconcileOrder(["c", "a", "b"], ["a", "b", "c"])).toEqual(["c", "a", "b"]);
  });

  it("appends new tabs to end of order", () => {
    expect(reconcileOrder(["a", "b"], ["a", "b", "c", "d"])).toEqual(["a", "b", "c", "d"]);
  });

  it("prunes removed tabs from order", () => {
    expect(reconcileOrder(["a", "b", "c"], ["a", "c"])).toEqual(["a", "c"]);
  });

  it("handles simultaneous add and remove", () => {
    // b removed, d added
    expect(reconcileOrder(["a", "b", "c"], ["a", "c", "d"])).toEqual(["a", "c", "d"]);
  });

  it("filters out IDs in localOrder but missing from tabs (race condition)", () => {
    expect(reconcileOrder(["a", "b", "x", "c"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("handles empty tabs list", () => {
    expect(reconcileOrder(["a", "b"], [])).toEqual([]);
  });

  it("handles both empty", () => {
    expect(reconcileOrder([], [])).toEqual([]);
  });
});

describe("applyReorder", () => {
  const ids = new Set(["a", "b", "c", "d"]);

  it("moves tab a before tab c", () => {
    expect(applyReorder(["a", "b", "c", "d"], "a", "c", ids)).toEqual(["b", "a", "c", "d"]);
  });

  it("moves tab c before tab a", () => {
    expect(applyReorder(["a", "b", "c", "d"], "c", "a", ids)).toEqual(["c", "a", "b", "d"]);
  });

  it("preserves other tabs' relative order", () => {
    const result = applyReorder(["a", "b", "c", "d"], "d", "b", ids);
    expect(result).toEqual(["a", "d", "b", "c"]);
    // b and c stayed in relative order
    expect(result.indexOf("b")).toBeLessThan(result.indexOf("c"));
  });

  it("returns original array if fromId is missing", () => {
    const original = ["a", "b", "c"];
    expect(applyReorder(original, "x", "b", ids)).toBe(original);
  });

  it("returns original array if toId is missing", () => {
    const original = ["a", "b", "c"];
    expect(applyReorder(original, "a", "x", ids)).toBe(original);
  });

  it("filters invalid IDs from order before reordering", () => {
    // "x" is in the order array but not in validIds — should be filtered out
    const validIds = new Set(["a", "b", "c"]);
    expect(applyReorder(["a", "x", "b", "c"], "c", "a", validIds)).toEqual(["c", "a", "b"]);
  });

  it("moves adjacent tabs", () => {
    expect(applyReorder(["a", "b", "c"], "b", "a", ids)).toEqual(["b", "a", "c"]);
  });

  it("moves to last position by targeting last element", () => {
    // Moving "a" before "c" puts it just before c
    expect(applyReorder(["a", "b", "c"], "a", "c", ids)).toEqual(["b", "a", "c"]);
  });
});
