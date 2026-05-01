import { PANEL_WIDTH_KEYS, type PanelSide } from "../../shared/constants.js";
import {
  getRightWidth,
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  type PanelLayout,
} from "../panel-layout.js";

export interface DragResizeState {
  handleResizeStart: (e: MouseEvent, side: PanelSide) => void;
}

/**
 * Svelte 5 port of `useDragResize`.
 *
 * Encapsulates drag-to-resize logic for side panels. Attaches and cleans up
 * mousemove/mouseup listeners atomically. Accepts getters for reactive inputs.
 */
export function createDragResize(
  getPanelLayout: () => PanelLayout,
  setPanelLayout: (updater: (prev: PanelLayout) => PanelLayout) => void,
): DragResizeState {
  let dragListeners: { move: (e: MouseEvent) => void; up: () => void } | null = null;

  // Clean up drag listeners if the component is destroyed mid-drag
  $effect(() => {
    return () => {
      if (dragListeners) {
        document.removeEventListener("mousemove", dragListeners.move);
        document.removeEventListener("mouseup", dragListeners.up);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        dragListeners = null;
      }
    };
  });

  const handleResizeStart = (e: MouseEvent, side: PanelSide) => {
    e.preventDefault();
    const startX = e.clientX;
    const current = getPanelLayout();
    let startWidth: number;
    if (side === "left") {
      startWidth = "left" in current ? current.left : PANEL_DEFAULT_WIDTH;
    } else {
      startWidth = getRightWidth(current);
    }
    const storageKey = PANEL_WIDTH_KEYS[side];
    let latestWidth = startWidth;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const next = side === "left" ? startWidth + delta : startWidth - delta;
      latestWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, next));
      setPanelLayout((prev) => {
        if (side === "right") {
          if (prev.kind === "three-panel") return { ...prev, right: latestWidth };
          if (prev.kind === "tabbed") return { kind: "tabbed", right: latestWidth };
          return prev;
        }
        if (prev.kind === "three-panel") return { ...prev, left: latestWidth };
        if (prev.kind === "tabbed-left") return { ...prev, left: latestWidth };
        return prev;
      });
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      dragListeners = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const layoutNow = getPanelLayout();
      const shouldPersist =
        (side === "left" && "left" in layoutNow) || (side === "right" && "right" in layoutNow);
      if (shouldPersist) {
        try {
          localStorage.setItem(storageKey, String(latestWidth));
        } catch (err) {
          console.warn(`[tandem] failed to persist ${storageKey}:`, err);
        }
      }
    };

    dragListeners = { move: onMouseMove, up: onMouseUp };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  return { handleResizeStart };
}
