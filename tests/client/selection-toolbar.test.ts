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
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 600,
      viewportWidth: 800,
    });

    expect(position.top).toBe(92);
    expect(position.left).toBe(115);
  });

  it("falls back to clamped above-placement when below would overflow the viewport (#680)", () => {
    // Tight viewport — neither above (12) nor below (172+40=212 vs viewport
    // 180) fits. Clamp to MIN_TOP=48, matching pre-#680 behavior. The user
    // already has an unusable viewport; overlap is the least of their
    // worries.
    const position = computeSelectionToolbarPosition({
      start: { left: 80, top: 62, bottom: 162, right: 150 },
      end: { left: 80, top: 62, bottom: 162, right: 150 },
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 180,
      viewportWidth: 800,
    });

    expect(position.top).toBe(48);
  });

  it("places the toolbar above when there's room", () => {
    // Selection top is 200 — natural above-top is 200 - 10 - 40 = 150, well
    // clear of MIN_TOP=48. No flip needed.
    const position = computeSelectionToolbarPosition({
      start: { left: 80, top: 200, bottom: 220, right: 150 },
      end: { left: 80, top: 200, bottom: 220, right: 150 },
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
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 400,
      viewportWidth: 800,
    });

    expect(position.top).toBe(352);
  });

  it("clamps the toolbar to the viewport left edge", () => {
    const position = computeSelectionToolbarPosition({
      start: { left: -40, top: 180, bottom: 200, right: 20 },
      end: { left: -20, top: 180, bottom: 200, right: 20 },
      toolbarHeight: 40,
      toolbarWidth: 200,
      viewportHeight: 500,
      viewportWidth: 800,
    });

    expect(position.left).toBe(108);
  });

  it("clamps the toolbar to the viewport right edge", () => {
    const position = computeSelectionToolbarPosition({
      start: { left: 290, top: 180, bottom: 200, right: 340 },
      end: { left: 300, top: 180, bottom: 200, right: 340 },
      toolbarHeight: 40,
      toolbarWidth: 200,
      viewportHeight: 500,
      viewportWidth: 300,
    });

    expect(position.left).toBe(192);
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
