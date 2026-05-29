import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _computeNextPositionsForTesting as computeNextPositions,
  createScheduler,
  _mapsEqualForTesting as mapsEqual,
} from "../../src/client/hooks/useMarginPositions.svelte.js";
import type { Annotation } from "../../src/shared/types.js";

/**
 * Position tracking ships in PR 1 (#649). The full composable depends on
 * Svelte runes + a real ProseMirror view + a Y.Doc, so we exercise that
 * end-to-end through Playwright and manual smoke. The pure-logic primitives
 * (`mapsEqual`, `computeNextPositions`, `createScheduler`) ARE unit-tested
 * here — they gate downstream re-renders and silent-failure signals, and
 * getting them wrong causes UI thrashing or systemic-failure blind spots
 * that are hard to diagnose at runtime.
 */

function ann(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    type: "comment",
    author: "claude",
    status: "pending",
    range: { from: 0, to: 1 },
    content: "",
    timestamp: 0,
    ...overrides,
  } as Annotation;
}

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

describe("useMarginPositions / computeNextPositions", () => {
  it("returns empty result for empty annotation list", () => {
    const r = computeNextPositions(
      [],
      () => ({ from: 0, to: 0 }),
      () => ({ top: 0 }),
      () => 0,
    );
    expect(r.positions.size).toBe(0);
    expect(r.attempted).toBe(0);
    expect(r.thrown).toBe(0);
  });

  it("does NOT count null-range annotations as attempted (they aren't anchor-staleness signals)", () => {
    const r = computeNextPositions(
      [ann("a"), ann("b"), ann("c")],
      () => null,
      () => ({ top: 0 }),
      () => 0,
    );
    expect(r.positions.size).toBe(0);
    expect(r.attempted).toBe(0);
    expect(r.thrown).toBe(0);
  });

  it("sets position relative to layerTop and counts attempted", () => {
    const r = computeNextPositions(
      [ann("a")],
      () => ({ from: 5, to: 10 }),
      () => ({ top: 150 }),
      () => 50,
    );
    expect(r.positions.get("a")).toBe(100);
    expect(r.attempted).toBe(1);
    expect(r.thrown).toBe(0);
  });

  it("skips annotations where coords.top is NaN (would defeat mapsEqual tolerance)", () => {
    const r = computeNextPositions(
      [ann("a")],
      () => ({ from: 0, to: 0 }),
      () => ({ top: Number.NaN }),
      () => 0,
    );
    expect(r.positions.has("a")).toBe(false);
    expect(r.attempted).toBe(1);
    expect(r.thrown).toBe(0);
  });

  it("skips annotations where coords.top is Infinity (degenerate layout)", () => {
    const r = computeNextPositions(
      [ann("a")],
      () => ({ from: 0, to: 0 }),
      () => ({ top: Number.POSITIVE_INFINITY }),
      () => 0,
    );
    expect(r.positions.has("a")).toBe(false);
    expect(r.attempted).toBe(1);
  });

  it("re-reads layerTop per iteration — mid-loop layer reflow does not cause Y drift", () => {
    // Simulate the layer shifting by 10px after the first coordsAtPos call
    // (e.g. a ResizeObserver flush or bind:clientHeight reflow). With a
    // pre-captured layerTop the second annotation's offset would be wrong
    // (210 - 100 = 110 instead of 100). With getLayerTop() called per
    // iteration after coordsAtPos, both offsets are 100.
    let coordsCall = 0;
    let layerTopCall = 0;
    const r = computeNextPositions(
      [ann("a"), ann("b")],
      () => ({ from: 0, to: 0 }),
      () => {
        const top = coordsCall === 0 ? 200 : 210;
        coordsCall++;
        return { top };
      },
      () => {
        const top = layerTopCall === 0 ? 100 : 110;
        layerTopCall++;
        return top;
      },
    );
    expect(r.positions.get("a")).toBe(100); // 200 - 100
    expect(r.positions.get("b")).toBe(100); // 210 - 110
  });

  it("counts thrown when coordsAtPos throws — one stale anchor doesn't blank the column", () => {
    const r = computeNextPositions(
      [ann("a"), ann("b"), ann("c")],
      () => ({ from: 0, to: 0 }),
      (pos) => {
        if (pos === 0) {
          // a, b, c all resolve to from:0 in this contrived test; the throw
          // matters per call. Use a counter instead.
        }
        return { top: 0 };
      },
      () => 0,
    );
    // All three pass — sanity baseline for the next case.
    expect(r.positions.size).toBe(3);
    expect(r.thrown).toBe(0);

    let call = 0;
    const r2 = computeNextPositions(
      [ann("a"), ann("b"), ann("c")],
      () => ({ from: 0, to: 0 }),
      () => {
        call++;
        if (call === 2) throw new Error("stale position");
        return { top: 100 };
      },
      () => 0,
    );
    expect(r2.positions.has("a")).toBe(true);
    expect(r2.positions.has("b")).toBe(false);
    expect(r2.positions.has("c")).toBe(true);
    expect(r2.attempted).toBe(3);
    expect(r2.thrown).toBe(1);
  });

  it("reports thrown === attempted when every coordsAtPos throws — caller uses this as systemic signal", () => {
    const r = computeNextPositions(
      [ann("a"), ann("b"), ann("c")],
      () => ({ from: 0, to: 0 }),
      () => {
        throw new Error("view detached");
      },
      () => 0,
    );
    expect(r.positions.size).toBe(0);
    expect(r.attempted).toBe(3);
    expect(r.thrown).toBe(3);
  });

  it("does not raise the systemic signal when some throw and some succeed", () => {
    let call = 0;
    const r = computeNextPositions(
      [ann("a"), ann("b"), ann("c")],
      () => ({ from: 0, to: 0 }),
      () => {
        call++;
        if (call % 2 === 0) throw new Error("stale");
        return { top: 100 };
      },
      () => 0,
    );
    expect(r.attempted).toBe(3);
    expect(r.thrown).toBe(1);
    // attempted !== thrown so caller will NOT warn
    expect(r.thrown === r.attempted).toBe(false);
  });
});

describe("useMarginPositions / createScheduler", () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;

  beforeEach(() => {
    rafCallbacks = new Map();
    nextRafId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
      rafCallbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushRaf(): void {
    const pending = Array.from(rafCallbacks.entries());
    rafCallbacks.clear();
    for (const [, cb] of pending) cb(performance.now());
  }

  it("fires the callback once per schedule()", () => {
    const fn = vi.fn();
    const s = createScheduler(fn);
    s.schedule();
    flushRaf();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("coalesces multiple schedule() calls in the same tick into one frame", () => {
    const fn = vi.fn();
    const s = createScheduler(fn);
    s.schedule();
    s.schedule();
    s.schedule();
    flushRaf();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel() prevents a pending frame from firing", () => {
    const fn = vi.fn();
    const s = createScheduler(fn);
    s.schedule();
    s.cancel();
    flushRaf();
    expect(fn).not.toHaveBeenCalled();
  });

  it("schedule after cancel queues a new frame", () => {
    const fn = vi.fn();
    const s = createScheduler(fn);
    s.schedule();
    s.cancel();
    s.schedule();
    flushRaf();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("re-scheduling after the frame fires queues another", () => {
    const fn = vi.fn();
    const s = createScheduler(fn);
    s.schedule();
    flushRaf();
    s.schedule();
    flushRaf();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel() is a no-op when nothing is scheduled", () => {
    const fn = vi.fn();
    const s = createScheduler(fn);
    expect(() => s.cancel()).not.toThrow();
    flushRaf();
    expect(fn).not.toHaveBeenCalled();
  });
});
