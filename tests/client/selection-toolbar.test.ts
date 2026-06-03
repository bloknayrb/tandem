import { describe, expect, it, vi } from "vitest";
import {
  attachSelectionToolbarListener,
  computeSelectionToolbarPosition,
} from "../../src/client/editor/toolbar/selection-toolbar";

describe("selection toolbar position", () => {
  it("flips below the selection when above would intrude on the chrome (#680)", () => {
    // Selection top is 62 — natural above-top is 62 - 10 - 40 = 12, which is
    // BELOW MIN_TOP=48. Pre-#680 this clamped to 48 (on top of TitleBar +
    // FormattingBar = 76px of chrome) and the BubbleMenu intercepted clicks
    // on `toolbar-highlight-btn`. With flip-below, the toolbar moves to
    // selection.bottom + gap = 82 + 10 = 92, clear of the chrome.
    const position = computeSelectionToolbarPosition({
      start: { left: 80, top: 62, bottom: 82, right: 150 },
      end: { left: 80, top: 62, bottom: 82, right: 150 },
      anchorX: 80,
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
    });

    expect(position.top).toBe(92);
    // Left-anchored at the cursor X (#798): fits, so left === anchorX.
    expect(position.left).toBe(80);
  });

  it("pins to viewport bottom when neither above nor below fits (#680 fold-straddle)", () => {
    // Tight viewport — neither above (12) nor below (172+40=212 vs viewport
    // 180) fits. Pre-fold-straddle this clamped to MIN_TOP=48 (on the chrome),
    // which is exactly the pointer-intercept failure mode #678 caught. Pin to
    // the viewport bottom instead — the toolbar is visible, the user can
    // dismiss it, and fixed-bar clicks above are never intercepted.
    const position = computeSelectionToolbarPosition({
      start: { left: 80, top: 62, bottom: 162, right: 150 },
      end: { left: 80, top: 62, bottom: 162, right: 150 },
      anchorX: 80,
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 180,
      viewportWidth: 800,
    });

    // maxTop = max(MIN_TOP=48, viewportHeight - toolbarHeight - EDGE_GAP)
    //        = max(48, 180 - 40 - 8) = 132.
    expect(position.top).toBe(132);
    expect(position.placement).toBe("below");
  });

  it("applies flip hysteresis at the above/below boundary", () => {
    // Selection.top sits where aboveTop = 50: just above MIN_TOP=48 (so a naïve
    // implementation would call this "above"), but BELOW the +4 entry threshold.
    // With no prior placement, the toolbar flips below. Then, with placement
    // already below, the same bounds still resolve to below.
    //
    // Numbers: selection.top = 100, aboveTop = 100 - 10 - 40 = 50.
    // Without hysteresis: 50 >= 48 → above. With +4 entry: 50 >= 52 → below.
    const argsBoundary = {
      start: { left: 80, top: 100, bottom: 120, right: 150 },
      end: { left: 80, top: 100, bottom: 120, right: 150 },
      anchorX: 80,
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
    } as const;
    const first = computeSelectionToolbarPosition(argsBoundary);
    expect(first.placement).toBe("below");

    // Once placed above, exit only when aboveTop drops 4 below MIN_TOP.
    // selection.top = 95 → aboveTop = 45. Without hysteresis: 45 < 48 → flip
    // below. With sticky-above (-4 exit): 45 >= 44 → still above. This is the
    // load-bearing assertion preventing per-frame flicker on slow drags.
    const stickyAbove = computeSelectionToolbarPosition({
      start: { left: 80, top: 95, bottom: 115, right: 150 },
      end: { left: 80, top: 95, bottom: 115, right: 150 },
      anchorX: 80,
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
      previousPlacement: "above",
    });
    expect(stickyAbove.placement).toBe("above");
    // aboveTop = 95 - 10 - 40 = 45, clamped up to MIN_TOP=48.
    expect(stickyAbove.top).toBe(48);

    // From above, only crossing the -4 exit threshold flips below.
    // selection.top = 91 → aboveTop = 41 → 41 < 44 → flip.
    const flipDown = computeSelectionToolbarPosition({
      start: { left: 80, top: 91, bottom: 111, right: 150 },
      end: { left: 80, top: 91, bottom: 111, right: 150 },
      anchorX: 80,
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
      previousPlacement: "above",
    });
    expect(flipDown.placement).toBe("below");
  });

  it("places the toolbar above when there's room", () => {
    // Selection top is 200 — natural above-top is 200 - 10 - 40 = 150, well
    // clear of MIN_TOP=48. No flip needed.
    const position = computeSelectionToolbarPosition({
      start: { left: 80, top: 200, bottom: 220, right: 150 },
      end: { left: 80, top: 200, bottom: 220, right: 150 },
      anchorX: 80,
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
    });

    expect(position.top).toBe(150);
  });

  it("clamps the toolbar to the viewport bottom when the selection is near the end", () => {
    const position = computeSelectionToolbarPosition({
      start: { left: 80, top: 500, bottom: 520, right: 150 },
      end: { left: 80, top: 500, bottom: 520, right: 150 },
      anchorX: 80,
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 400,
      viewportWidth: 800,
    });

    expect(position.top).toBe(352);
  });

  it("returns a height-independent `bottom` anchor for above placement (#798 A26 morph)", () => {
    // The A26 morph grows an above-placed popup UPWARD by rendering CSS `bottom`
    // (pinned a gap above the selection's top) instead of a height-dependent
    // `top`. `bottom` must NOT vary with toolbarHeight — that's what lets the
    // popup animate its height without repositioning.
    const base = {
      start: { left: 80, top: 200, bottom: 220, right: 150 },
      end: { left: 80, top: 200, bottom: 220, right: 150 },
      anchorX: 80,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
    } as const;
    const shortPopup = computeSelectionToolbarPosition({ ...base, toolbarHeight: 80 });
    const tallPopup = computeSelectionToolbarPosition({ ...base, toolbarHeight: 200 });

    // bottom = viewportHeight - (selectionTop - SELECTION_GAP) = 600 - (200 - 10) = 410.
    expect(shortPopup.placement).toBe("above");
    expect(shortPopup.bottom).toBe(410);
    // Identical regardless of popup height — the load-bearing invariant.
    expect(tallPopup.bottom).toBe(shortPopup.bottom);
  });

  it("left-anchors the popup at the cursor X so the pills unroll rightward (#798)", () => {
    // Cursor-origin unroll: the popup's LEFT edge sits at `anchorX` (the user's
    // cursor), NOT the selection midpoint. A wide selection whose midpoint is far
    // from the cursor must still anchor at the cursor.
    const position = computeSelectionToolbarPosition({
      start: { left: 80, top: 300, bottom: 320, right: 600 },
      end: { left: 80, top: 300, bottom: 320, right: 600 },
      anchorX: 420,
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
    });

    // Fits (420 + 160 = 580 < 800 - 8), so left === anchorX — not the midpoint 340.
    expect(position.left).toBe(420);
  });

  it("clamps the toolbar to the viewport left edge", () => {
    // Cursor off the left edge → left edge pinned at EDGE_GAP=8.
    const position = computeSelectionToolbarPosition({
      start: { left: -40, top: 180, bottom: 200, right: 20 },
      end: { left: -20, top: 180, bottom: 200, right: 20 },
      anchorX: -40,
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
      start: { left: 290, top: 180, bottom: 200, right: 340 },
      end: { left: 300, top: 180, bottom: 200, right: 340 },
      anchorX: 290,
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
