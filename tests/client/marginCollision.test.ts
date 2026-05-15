import { describe, expect, it } from "vitest";
import { prunePlaceableHeights, resolveCollisions } from "../../src/client/panels/marginCollision";

describe("resolveCollisions", () => {
  it("returns an empty map for empty input", () => {
    expect(resolveCollisions([])).toEqual(new Map());
  });

  it("passes non-overlapping bubbles through unchanged", () => {
    const result = resolveCollisions([
      { id: "a", top: 0, height: 40 },
      { id: "b", top: 100, height: 40 },
    ]);
    expect(result.get("a")).toBe(0);
    expect(result.get("b")).toBe(100);
  });

  it("pushes the second bubble down when overlapping the first", () => {
    // a occupies [10, 60), b's natural top is 30 — overlaps.
    // With default gap=6, b should land at 10+50+6 = 66.
    const result = resolveCollisions([
      { id: "a", top: 10, height: 50 },
      { id: "b", top: 30, height: 40 },
    ]);
    expect(result.get("a")).toBe(10);
    expect(result.get("b")).toBe(66);
  });

  it("cascades pushes through a stack of overlapping bubbles", () => {
    // All three would render at the same y; sweep stacks them.
    const result = resolveCollisions(
      [
        { id: "a", top: 0, height: 30 },
        { id: "b", top: 5, height: 30 },
        { id: "c", top: 10, height: 30 },
      ],
      { gap: 4 },
    );
    expect(result.get("a")).toBe(0);
    expect(result.get("b")).toBe(34); // 0 + 30 + 4
    expect(result.get("c")).toBe(68); // 34 + 30 + 4
  });

  it("respects the gap option", () => {
    const result = resolveCollisions(
      [
        { id: "a", top: 0, height: 20 },
        { id: "b", top: 5, height: 20 },
      ],
      { gap: 20 },
    );
    expect(result.get("b")).toBe(40); // 0 + 20 + 20
  });

  it("sorts unordered input by raw top before sweeping", () => {
    // 'b' comes first in input but has a higher raw top.
    const result = resolveCollisions([
      { id: "b", top: 100, height: 30 },
      { id: "a", top: 0, height: 30 },
    ]);
    expect(result.get("a")).toBe(0);
    expect(result.get("b")).toBe(100);
  });

  it("breaks ties stably by original input index", () => {
    const result = resolveCollisions(
      [
        { id: "first", top: 50, height: 20 },
        { id: "second", top: 50, height: 20 },
      ],
      { gap: 5 },
    );
    expect(result.get("first")).toBe(50);
    expect(result.get("second")).toBe(75); // 50 + 20 + 5
  });

  it("pushes against previous known bubbles even when the bubble's own height is unknown", () => {
    // Previous bubble's bottom is the cursor; an unknown-height bubble still
    // respects that cursor (so it doesn't visually overlap a measured
    // bubble). It just doesn't advance the cursor itself.
    const result = resolveCollisions([
      { id: "a", top: 0, height: 40 },
      { id: "b", top: 10, height: undefined },
      { id: "c", top: 20, height: 30 },
    ]);
    expect(result.get("a")).toBe(0);
    // a's bottom is 0+40+6=46; b is clamped up to 46.
    expect(result.get("b")).toBe(46);
    // b had no height → cursor stayed at 46 → c is also clamped to 46.
    expect(result.get("c")).toBe(46);
  });

  it("does not push the next bubble down when the current bubble's height is unknown", () => {
    // If the FIRST bubble has unknown height, the cursor never advances, so
    // the second bubble can sit at its natural top.
    const result = resolveCollisions([
      { id: "a", top: 0, height: undefined },
      { id: "b", top: 10, height: 30 },
    ]);
    expect(result.get("a")).toBe(0);
    expect(result.get("b")).toBe(10);
  });

  it("ignores non-finite tops", () => {
    const result = resolveCollisions([
      { id: "ghost", top: Number.NaN, height: 40 },
      { id: "real", top: 0, height: 40 },
    ]);
    expect(result.has("ghost")).toBe(false);
    expect(result.get("real")).toBe(0);
  });

  it("ignores non-finite heights but still emits the bubble", () => {
    const result = resolveCollisions([
      { id: "a", top: 0, height: Number.NaN },
      { id: "b", top: 5, height: 30 },
    ]);
    expect(result.get("a")).toBe(0);
    // a's height is unusable → cursor stays at -Infinity → b is at its natural top.
    expect(result.get("b")).toBe(5);
  });

  it("treats zero or negative heights as unmeasured", () => {
    const result = resolveCollisions([
      { id: "a", top: 0, height: 0 },
      { id: "b", top: 5, height: 30 },
    ]);
    expect(result.get("a")).toBe(0);
    expect(result.get("b")).toBe(5);
  });
});

describe("prunePlaceableHeights", () => {
  it("removes entries not in placeableIds", () => {
    const heights = new Map([
      ["a", 10],
      ["b", 20],
      ["c", 30],
    ]);
    const removed = prunePlaceableHeights(heights, new Set(["a", "c"]));
    expect(removed).toBe(1);
    expect(heights.has("b")).toBe(false);
    expect(heights.get("a")).toBe(10);
    expect(heights.get("c")).toBe(30);
  });

  it("returns 0 when nothing to prune", () => {
    const heights = new Map([["a", 10]]);
    expect(prunePlaceableHeights(heights, new Set(["a", "b"]))).toBe(0);
    expect(heights.size).toBe(1);
  });

  it("keeps heights bounded across 1000 add-then-remove cycles", () => {
    // Simulate long-session churn: each cycle adds a new annotation id and
    // measurement, then the prior annotations leave the `placeable` set
    // (accepted/dismissed/removed). After pruning each cycle, `heights.size`
    // should stay at the steady-state size of the placeable set — never grow
    // unboundedly.
    const heights = new Map<string, number>();
    const STEADY_STATE = 3;
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = `ann-${i}`;
      ids.push(id);
      heights.set(id, 42);
      const placeableIds = new Set(ids.slice(-STEADY_STATE));
      prunePlaceableHeights(heights, placeableIds);
      expect(heights.size).toBeLessThanOrEqual(STEADY_STATE);
    }
    expect(heights.size).toBe(STEADY_STATE);
  });
});
