import { PANEL_WIDTH_KEYS, type PanelSide } from "../../shared/constants.js";
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "../panel-layout.js";

export interface DragResizeState {
  readonly width: number;
  /**
   * True while a POINTER drag is in flight. Bound to a class on `.rail-shell` so the
   * 360ms width transition can be suppressed for the duration — see #1426. Deliberately
   * NOT set by `handleResizeStep` (the keyboard path), which has no release event to
   * clear it against.
   */
  readonly dragging: boolean;
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
  // Safe to write from the raw mouse handlers below: `width` already is, and both
  // mousemove and mouseup are UA-queued tasks, so no Svelte reaction is active when
  // they run (the `state_unsafe_mutation` hazard needs a synchronously-dispatched
  // event — a native blur during render — which these are not).
  let dragging = $state(false);
  let dragListeners: { move: (e: MouseEvent) => void; up: () => void } | null = null;

  // Abort drag if the panel is hidden while a drag is in progress.
  $effect(() => {
    const visible = opts.getVisible();
    if (!visible && dragListeners) {
      document.removeEventListener("mousemove", dragListeners.move);
      document.removeEventListener("mouseup", dragListeners.up);
      dragListeners = null;
      dragging = false;
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
        // Inert today (the object dies with the component), but kept so all three exit
        // paths clear the same set — the asymmetry is what would rot.
        dragging = false;
      }
    };
  });

  const handleResizeStart = (e: MouseEvent) => {
    // Re-entrant start (a second mousedown with no intervening mouseup): release the
    // previous drag first. Otherwise its listeners stay on `document` unreachable by
    // either cleanup path, and its stale `onMouseUp` can later fire mid-drag — clearing
    // `dragging` and re-enabling the ease it exists to suppress.
    if (dragListeners) {
      document.removeEventListener("mousemove", dragListeners.move);
      document.removeEventListener("mouseup", dragListeners.up);
      dragListeners = null;
    }
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    let latestWidth = startWidth;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    dragging = true;

    const onMouseMove = (ev: MouseEvent) => {
      // If the button is already up, the terminating `mouseup` was never delivered —
      // a context menu, an app switch, or a drag over native chrome that stole implicit
      // capture. Previously that just leaked two listeners invisibly; now it would also
      // strand `dragging` true and kill the rail's open/close ease for the rest of the
      // session (#1426), so release explicitly rather than waiting for an event that
      // is not coming.
      if (ev.buttons === 0) {
        onMouseUp();
        return;
      }
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
      dragging = false;
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
    get dragging() {
      return dragging;
    },
    handleResizeStart,
    handleResizeStep,
  };
}
