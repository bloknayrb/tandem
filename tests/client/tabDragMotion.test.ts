// A30 tab-reorder drag — the pure geometry.
//
// Everything here is arithmetic over a hand-built snapshot: no DOM, no layout,
// no component. The parts that need a real layout engine (does the pill track
// the pointer, does the parted gap survive the drop without a stranded
// transform) live in tests/e2e/tab-drag-motion.spec.ts, because happy-dom has
// no layout and would let either of them regress silently.

import { describe, expect, it } from "vitest";
import { applyReorder } from "../../src/client/hooks/useTabOrder.js";
import {
  computeShift,
  gapFromRects,
  resolveDragFrame,
  slotIndexFor,
  slotToTarget,
  type TabStripSnapshot,
} from "../../src/client/tabs/tabDragMotion.js";

/** `n` tabs of the given widths, laid out left to right from `startLeft`. */
function strip(widths: number[], gap = 6, startLeft = 10): TabStripSnapshot {
  const ids = widths.map((_, i) => String.fromCharCode(97 + i));
  const lefts: number[] = [];
  let x = startLeft;
  for (const w of widths) {
    lefts.push(x);
    x += w + gap;
  }
  return { ids, lefts, widths, gap };
}

/** Midpoint of tab `i` in snapshot coordinates. */
function mid(snap: TabStripSnapshot, i: number): number {
  return snap.lefts[i] + snap.widths[i] / 2;
}

describe("gapFromRects", () => {
  it("reads the gap off the first adjacent pair", () => {
    expect(gapFromRects([10, 116, 222], [100, 100, 100])).toBe(6);
  });

  it("is 0 for a strip that cannot show one", () => {
    expect(gapFromRects([10], [100])).toBe(0);
    expect(gapFromRects([], [])).toBe(0);
  });

  it("never goes negative when tabs visually overlap", () => {
    expect(gapFromRects([10, 50], [100, 100])).toBe(0);
  });
});

describe("slotIndexFor", () => {
  const snap = strip([100, 100, 100]); // lefts 10/116/222, mids 60/166/272

  // The property that matters is not monotonicity — the correct model and the
  // hair-trigger self-included one are BOTH monotonic. It is the exact x at
  // which the index increments. Dragging "a", the self-included model would
  // step at a's own midpoint (60); the correct one waits for b's (166).
  it("steps at the NEIGHBOUR's midpoint, not the dragged tab's own", () => {
    expect(slotIndexFor(snap, 60, "a")).toBe(0);
    expect(slotIndexFor(snap, 61, "a")).toBe(0);
    expect(slotIndexFor(snap, 165.9, "a")).toBe(0);
    expect(slotIndexFor(snap, mid(snap, 1), "a")).toBe(0); // strictly past
    expect(slotIndexFor(snap, mid(snap, 1) + 0.1, "a")).toBe(1);
    expect(slotIndexFor(snap, mid(snap, 2), "a")).toBe(1);
    expect(slotIndexFor(snap, mid(snap, 2) + 0.1, "a")).toBe(2);
  });

  it("skips the dragged tab's own midpoint from the middle of the strip too", () => {
    // Dragging "b": a's midpoint (60) and c's (272) are the only steps.
    expect(slotIndexFor(snap, 0, "b")).toBe(0);
    expect(slotIndexFor(snap, 60.1, "b")).toBe(1);
    expect(slotIndexFor(snap, 166, "b")).toBe(1); // its own midpoint: no step
    expect(slotIndexFor(snap, 272.1, "b")).toBe(2);
  });

  it("clamps to the strip at either extreme", () => {
    expect(slotIndexFor(snap, -10_000, "b")).toBe(0);
    expect(slotIndexFor(snap, 10_000, "b")).toBe(2);
  });
});

describe("slotToTarget", () => {
  const ids = ["a", "b", "c", "d"];

  it("returns null for the slot the dragged tab already occupies", () => {
    expect(slotToTarget(ids, "a", 0)).toBeNull();
    expect(slotToTarget(ids, "c", 2)).toBeNull();
  });

  it("never names the dragged tab as the target", () => {
    // applyReorder has NO fromId === toId guard of its own (that lives in the
    // useTabOrder wrapper this path bypasses), and hovering your own slot is the
    // modal state of the gesture — so this is the guard that keeps it honest.
    for (const dragged of ids) {
      for (let slot = 0; slot <= ids.length; slot++) {
        expect(slotToTarget(ids, dragged, slot)?.toId).not.toBe(dragged);
      }
    }
  });

  it("returns null for an id that isn't in the strip", () => {
    expect(slotToTarget(ids, "zz", 2)).toBeNull();
  });

  it("returns null for a single-tab strip", () => {
    expect(slotToTarget(["a"], "a", 0)).toBeNull();
    expect(slotToTarget(["a"], "a", 5)).toBeNull();
  });

  // The one place an inverse of applyReorder is unavoidable. Pin it by
  // round-trip, not by reading: feed the output through the REAL applyReorder
  // and check the dragged id lands at exactly the slot that was asked for.
  it("round-trips through the real applyReorder for every (dragged, slot)", () => {
    const validIds = new Set(ids);
    for (const dragged of ids) {
      for (let slot = 0; slot < ids.length; slot++) {
        const target = slotToTarget(ids, dragged, slot);
        if (!target) {
          expect(slot).toBe(ids.indexOf(dragged));
          continue;
        }
        const next = applyReorder(ids, dragged, target.toId, validIds, target.side);
        expect(next.indexOf(dragged)).toBe(slot);
        expect([...next].sort()).toEqual([...ids].sort()); // still a permutation
      }
    }
  });

  it("round-trips on a two-tab strip (the shape the E2E drags)", () => {
    const two = ["a", "b"];
    const t = slotToTarget(two, "a", 1);
    expect(t).toEqual({ toId: "b", side: "right" });
    expect(applyReorder(two, "a", "b", new Set(two), "right")).toEqual(["b", "a"]);
  });
});

describe("computeShift", () => {
  it("moves the dragged tab forward by exactly the widths it passes", () => {
    const snap = strip([100, 100, 100]);
    const next = applyReorder(snap.ids, "a", "c", new Set(snap.ids), "right");
    expect(next).toEqual(["b", "c", "a"]);
    // a clears two 100px tabs and two 6px gaps; b and c each back up by one.
    expect(computeShift(snap, next)).toEqual([212, -106, -106]);
  });

  it("uses each tab's OWN width, not a uniform step", () => {
    const snap = strip([100, 60, 140]);
    const next = applyReorder(snap.ids, "a", "b", new Set(snap.ids), "right");
    expect(next).toEqual(["b", "a", "c"]);
    // a moves right by b's width + gap; b moves left by a's; c doesn't move at
    // all — a uniform `step = w + gap` model would move all three.
    expect(computeShift(snap, next)).toEqual([66, -106, 0]);
  });

  it("is zero everywhere when the order is unchanged", () => {
    const snap = strip([100, 60, 140]);
    expect(computeShift(snap, snap.ids)).toEqual([0, 0, 0]);
  });

  it("no-ops rather than producing NaN on degenerate input", () => {
    const snap = strip([100, 100]);
    expect(computeShift(snap, ["a"])).toEqual([0, 0]); // wrong length
    expect(computeShift(snap, ["a", "zz"])).toEqual([0, 0]); // not a permutation
    expect(computeShift({ ids: [], lefts: [], widths: [], gap: 0 }, [])).toEqual([]);
    for (const v of computeShift(snap, ["b", "a"])) expect(Number.isFinite(v)).toBe(true);
  });

  it("lands every tab on the left its post-reorder layout would give it", () => {
    // The whole point: a sibling parted by exactly this much satisfies flip's
    // `from === to`, so flip creates no animation and the parting IS the settle.
    const snap = strip([100, 60, 140, 80]);
    const next = applyReorder(snap.ids, "d", "b", new Set(snap.ids), "left");
    expect(next).toEqual(["a", "d", "b", "c"]);
    const shifts = computeShift(snap, next);
    // Rebuild the expected layout independently of the implementation.
    const expected = strip([100, 80, 60, 140]); // widths in the NEW order
    for (const [i, id] of snap.ids.entries()) {
      expect(snap.lefts[i] + shifts[i]).toBeCloseTo(expected.lefts[next.indexOf(id)], 6);
    }
  });
});

describe("resolveDragFrame", () => {
  const snap = strip([100, 100, 100]);

  it("opens no gap while the pointer is still over the dragged tab's own slot", () => {
    const frame = resolveDragFrame(snap, mid(snap, 0), "a");
    expect(frame.target).toBeNull();
    expect(frame.shifts).toEqual([0, 0, 0]);
  });

  it("parts exactly one neighbour once its midpoint is crossed", () => {
    const frame = resolveDragFrame(snap, mid(snap, 1) + 1, "a");
    expect(frame.target).toEqual({ toId: "b", side: "right" });
    expect(frame.shifts).toEqual([106, -106, 0]);
  });

  it("agrees with what a release would commit", () => {
    // The gap the user sees and the reorder pointerup calls are the same
    // computation — that is what makes the drop land where the gap was.
    const frame = resolveDragFrame(snap, mid(snap, 2) + 1, "a");
    expect(frame.target).not.toBeNull();
    const next = applyReorder(
      snap.ids,
      "a",
      // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
      frame.target!.toId,
      new Set(snap.ids),
      // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
      frame.target!.side,
    );
    expect(computeShift(snap, next)).toEqual(frame.shifts);
    expect(next.indexOf("a")).toBe(frame.slot);
  });
});
