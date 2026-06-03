import { describe, expect, it, vi } from "vitest";
import {
  attachSelectionToolbarListener,
  computeSelectionToolbarPosition,
} from "../../src/client/editor/toolbar/selection-toolbar";

describe("selection toolbar position", () => {
  // Cursor-anchored model (#798, Bryan 2026-06-03): the popup appears AT the
  // cursor point (anchorX/anchorY) and unrolls away from it — a 6px gap BELOW the
  // cursor by default, flipping ABOVE only when below would run off the viewport
  // bottom. Constants: MIN_TOP=48, EDGE_GAP=8, SELECTION_GAP=6, FLIP_HYSTERESIS=4.

  it("places the popup just below the cursor by default", () => {
    // Cursor mid-viewport → below fits, so the popup's top sits a gap under the
    // cursor and it unrolls downward. belowTop = anchorY + 6 = 206.
    const position = computeSelectionToolbarPosition({
      anchorX: 80,
      anchorY: 200,
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
    });

    expect(position.placement).toBe("below");
    expect(position.top).toBe(206);
    // Left edge pinned at the cursor X (fits, so no clamp).
    expect(position.left).toBe(80);
  });

  it("flips above the cursor when below would run off the viewport bottom", () => {
    // Cursor near the bottom: belowBottom = 560 + 6 + 40 = 606 > fitLimit
    // (600 - 8 - 4 = 588), so flip above. above-anchor pins the popup's BOTTOM a
    // gap above the cursor: bottom = 600 - (560 - 6) = 46.
    const position = computeSelectionToolbarPosition({
      anchorX: 80,
      anchorY: 560,
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
    });

    expect(position.placement).toBe("above");
    expect(position.bottom).toBe(46);
  });

  it("pins to the viewport bottom when neither below nor above fits", () => {
    // Tall popup, tiny viewport: below overflows (306 > 168) and above can't clear
    // MIN_TOP (aboveTop = 100 - 6 - 200 = -106 < 48). Pin to the bottom rather than
    // overlapping the chrome. maxTop = max(48, 180 - 200 - 8) = 48.
    const position = computeSelectionToolbarPosition({
      anchorX: 80,
      anchorY: 100,
      toolbarHeight: 200,
      toolbarWidth: 160,
      viewportHeight: 180,
      viewportWidth: 800,
    });

    expect(position.top).toBe(48);
    expect(position.placement).toBe("below");
  });

  it("applies flip hysteresis at the below/above boundary", () => {
    // anchorY = 546 → belowBottom = 546 + 6 + 40 = 592. Entry into below needs
    // belowBottom <= fitLimit - H = 592 - 4 = 588; 592 > 588, so a FRESH compute
    // (no prior placement) flips above (aboveTop = 546 - 6 - 40 = 500 >= 48).
    const args = {
      anchorX: 80,
      anchorY: 546,
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
    } as const;
    const fresh = computeSelectionToolbarPosition(args);
    expect(fresh.placement).toBe("above");

    // Once placed below, the exit threshold is sticky: belowBottom <= fitLimit + H
    // = 592 + 4 = 596; 592 <= 596, so it STAYS below. This is the load-bearing
    // assertion preventing per-frame flicker when a keyboard extend nudges the
    // anchor across the boundary.
    const stickyBelow = computeSelectionToolbarPosition({ ...args, previousPlacement: "below" });
    expect(stickyBelow.placement).toBe("below");
    // belowTop = 546 + 6 = 552.
    expect(stickyBelow.top).toBe(552);
  });

  it("returns a height-independent `bottom` anchor for above placement (#798 A26 morph)", () => {
    // The A26 morph grows an above-placed popup UPWARD by rendering CSS `bottom`
    // (pinned a gap above the cursor) instead of a height-dependent `top`. `bottom`
    // must NOT vary with toolbarHeight — that's what lets the popup animate its
    // height without repositioning.
    const base = {
      anchorX: 80,
      anchorY: 560,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
    } as const;
    const shortPopup = computeSelectionToolbarPosition({ ...base, toolbarHeight: 80 });
    const tallPopup = computeSelectionToolbarPosition({ ...base, toolbarHeight: 200 });

    // bottom = viewportHeight - (anchorY - SELECTION_GAP) = 600 - (560 - 6) = 46.
    expect(shortPopup.placement).toBe("above");
    expect(shortPopup.bottom).toBe(46);
    // Identical regardless of popup height — the load-bearing invariant.
    expect(tallPopup.bottom).toBe(shortPopup.bottom);
  });

  it("left-anchors the popup at the cursor X so the pills unroll rightward (#798)", () => {
    // Cursor-origin unroll: the popup's LEFT edge sits at `anchorX` (the user's
    // cursor), not centered. A cursor well to the right of the viewport's middle
    // still anchors at the cursor (it fits: 420 + 160 = 580 < 800 - 8).
    const position = computeSelectionToolbarPosition({
      anchorX: 420,
      anchorY: 300,
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
    });

    expect(position.left).toBe(420);
  });

  it("clamps the toolbar to the viewport left edge", () => {
    // Cursor off the left edge → left edge pinned at EDGE_GAP=8.
    const position = computeSelectionToolbarPosition({
      anchorX: -40,
      anchorY: 180,
      toolbarHeight: 40,
      toolbarWidth: 200,
      viewportHeight: 500,
      viewportWidth: 800,
    });

    expect(position.left).toBe(8);
  });

  it("clamps the toolbar to the viewport right edge", () => {
    // Cursor near the right edge → popup pushed left so its full width stays on
    // screen: maxLeft = viewportWidth - EDGE_GAP - toolbarWidth = 300 - 8 - 200 = 92.
    const position = computeSelectionToolbarPosition({
      anchorX: 290,
      anchorY: 180,
      toolbarHeight: 40,
      toolbarWidth: 200,
      viewportHeight: 500,
      viewportWidth: 300,
    });

    expect(position.left).toBe(92);
  });
});

describe("selection toolbar listener", () => {
  it("subscribes only to selectionUpdate", () => {
    const on = vi.fn();
    const off = vi.fn();
    const editor = { on, off } as const;
    const handler = vi.fn();

    const cleanup = attachSelectionToolbarListener(editor, handler);

    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith("selectionUpdate", handler);
    expect(off).not.toHaveBeenCalled();

    cleanup();

    expect(off).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledWith("selectionUpdate", handler);
  });
});
