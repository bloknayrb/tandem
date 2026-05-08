import { PANEL_WIDTH_KEYS, type PanelSide } from "../../shared/constants.js";
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "../panel-layout.js";

export interface DragResizeState {
  readonly width: number;
  handleResizeStart: (e: MouseEvent) => void;
  handleResizeStep: (deltaPx: number) => void;
}

/**
 * Svelte 5 per-side drag-to-resize hook.
 *
 * Mount one instance per visible rail. Each instance owns its own width and
 * persists to the corresponding localStorage key on drag-end or keyboard step.
 * Drag is aborted when the panel closes mid-drag (getVisible returns false).
 */
export function createDragResize(opts: {
  side: PanelSide;
  initialWidth: number;
  getVisible: () => boolean;
}): DragResizeState {
  const { side } = opts;
  const storageKey = PANEL_WIDTH_KEYS[side];

  let width = $state(opts.initialWidth);
  let dragListeners: { move: (e: MouseEvent) => void; up: () => void } | null = null;

  // Abort drag if the panel is hidden while a drag is in progress.
  $effect(() => {
    const visible = opts.getVisible();
    if (!visible && dragListeners) {
      document.removeEventListener("mousemove", dragListeners.move);
      document.removeEventListener("mouseup", dragListeners.up);
      dragListeners = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }
  });

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

  const handleResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    let latestWidth = startWidth;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      // Left panel: drag right = wider. Right panel: drag right = narrower.
      const next = side === "left" ? startWidth + delta : startWidth - delta;
      latestWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, next));
      width = latestWidth;
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      dragListeners = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (opts.getVisible()) {
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

  const handleResizeStep = (deltaPx: number) => {
    const next = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, width + deltaPx));
    width = next;
    if (opts.getVisible()) {
      try {
        localStorage.setItem(storageKey, String(next));
      } catch (err) {
        console.warn(`[tandem] failed to persist ${storageKey}:`, err);
      }
    }
  };

  return {
    get width() {
      return width;
    },
    handleResizeStart,
    handleResizeStep,
  };
}
