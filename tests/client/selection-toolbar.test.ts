import { describe, expect, it, vi } from "vitest";
import {
  attachSelectionToolbarListener,
  computeSelectionToolbarPosition,
} from "../../src/client/editor/toolbar/selection-toolbar";

describe("selection toolbar position", () => {
  it("clamps the toolbar to the minimum top offset", () => {
    const position = computeSelectionToolbarPosition({
      start: { left: 80, top: 62 },
      end: { left: 80, top: 62, right: 150 },
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 400,
      viewportWidth: 800,
    });

    expect(position.top).toBe(48);
    expect(position.left).toBe(115);
  });

  it("clamps the toolbar to the viewport bottom when the selection is near the end", () => {
    const position = computeSelectionToolbarPosition({
      start: { left: 80, top: 500 },
      end: { left: 80, top: 500, right: 150 },
      toolbarHeight: 40,
      toolbarWidth: 160,
      viewportHeight: 400,
      viewportWidth: 800,
    });

    expect(position.top).toBe(352);
  });

  it("clamps the toolbar to the viewport left edge", () => {
    const position = computeSelectionToolbarPosition({
      start: { left: -40, top: 180 },
      end: { left: -20, top: 180, right: 20 },
      toolbarHeight: 40,
      toolbarWidth: 200,
      viewportHeight: 500,
      viewportWidth: 800,
    });

    expect(position.left).toBe(108);
  });

  it("clamps the toolbar to the viewport right edge", () => {
    const position = computeSelectionToolbarPosition({
      start: { left: 290, top: 180 },
      end: { left: 300, top: 180, right: 340 },
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
