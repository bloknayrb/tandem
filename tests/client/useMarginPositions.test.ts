import { describe, expect, it } from "vitest";
import { _mapsEqualForTesting as mapsEqual } from "../../src/client/hooks/useMarginPositions.svelte.js";

/**
 * Position tracking ships in PR 1 (#649). The composable depends on Svelte
 * runes and a real ProseMirror view, so we exercise it through manual smoke
 * testing rather than vitest. The pure-logic equality helper *is* unit-tested
 * here because it gates downstream re-renders — getting the tolerance wrong
 * causes either UI thrashing or stale-bubble bugs that are hard to diagnose.
 */
describe("useMarginPositions / mapsEqual", () => {
  it("treats two empty maps as equal", () => {
    expect(mapsEqual(new Map(), new Map())).toBe(true);
  });

  it("considers identical maps equal", () => {
    const a = new Map([
      ["a", 100],
      ["b", 200],
    ]);
    const b = new Map([
      ["a", 100],
      ["b", 200],
    ]);
    expect(mapsEqual(a, b)).toBe(true);
  });

  it("considers subpixel jitter (≤0.5px) equal — prevents UI thrash from layout reflow", () => {
    const a = new Map([["x", 100]]);
    const b = new Map([["x", 100.3]]);
    expect(mapsEqual(a, b)).toBe(true);
  });

  it("considers shifts >0.5px unequal — real position changes must propagate", () => {
    const a = new Map([["x", 100]]);
    const b = new Map([["x", 101]]);
    expect(mapsEqual(a, b)).toBe(false);
  });

  it("considers maps with different sizes unequal", () => {
    const a = new Map([["x", 100]]);
    const b = new Map([
      ["x", 100],
      ["y", 200],
    ]);
    expect(mapsEqual(a, b)).toBe(false);
  });

  it("considers maps with same size but different keys unequal", () => {
    const a = new Map([["x", 100]]);
    const b = new Map([["y", 100]]);
    expect(mapsEqual(a, b)).toBe(false);
  });
});
