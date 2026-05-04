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
      viewportHeight: 400,
    });

    expect(position.top).toBe(48);
    expect(position.left).toBe(115);
  });

  it("clamps the toolbar to the viewport bottom when the selection is near the end", () => {
    const position = computeSelectionToolbarPosition({
      start: { left: 80, top: 500 },
      end: { left: 80, top: 500, right: 150 },
      toolbarHeight: 40,
      viewportHeight: 400,
    });

    expect(position.top).toBe(352);
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
