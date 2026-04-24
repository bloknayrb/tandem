import React, { useCallback, useEffect, useRef } from "react";
import { PANEL_WIDTH_KEYS, type PanelSide } from "../../shared/constants";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  type PanelLayout,
} from "../panel-layout";

interface DragResizeOptions {
  panelLayout: PanelLayout;
  setPanelLayout: React.Dispatch<React.SetStateAction<PanelLayout>>;
}

interface DragResizeResult {
  handleResizeStart: (e: React.MouseEvent, side: PanelSide) => void;
}

/**
 * Encapsulates drag-to-resize logic for side panels.
 *
 * Attaches and cleans up mousemove/mouseup listeners atomically so
 * mid-drag unmount cannot leak listeners. The panelLayoutRef sync
 * happens in render phase (not inside useEffect) so drag always reads
 * current layout state.
 */
export function useDragResize({
  panelLayout,
  setPanelLayout,
}: DragResizeOptions): DragResizeResult {
  // Keep a ref current in render phase so drag callbacks read latest layout
  const panelLayoutRef = useRef(panelLayout);
  panelLayoutRef.current = panelLayout;

  const dragListenersRef = useRef<{
    move: (e: MouseEvent) => void;
    up: () => void;
  } | null>(null);

  // Clean up drag listeners if the component unmounts mid-drag
  useEffect(() => {
    return () => {
      if (dragListenersRef.current) {
        document.removeEventListener("mousemove", dragListenersRef.current.move);
        document.removeEventListener("mouseup", dragListenersRef.current.up);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      }
    };
  }, []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, side: PanelSide) => {
      e.preventDefault();
      const startX = e.clientX;
      const current = panelLayoutRef.current;
      // `left` is only defined in three-panel; fall back to the default so a
      // stale mid-transition drag never reads undefined.
      const startWidth =
        side === "left"
          ? current.kind === "three-panel"
            ? current.left
            : PANEL_DEFAULT_WIDTH
          : current.right;
      const storageKey = PANEL_WIDTH_KEYS[side];
      let latestWidth = startWidth;

      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        // The left panel's handle sits on its right edge (drag right = wider).
        // The right panel's handle sits on its left edge (drag right = narrower).
        const next = side === "left" ? startWidth + delta : startWidth - delta;
        latestWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, next));
        setPanelLayout((prev) => {
          if (side === "right") {
            return prev.kind === "three-panel"
              ? { ...prev, right: latestWidth }
              : { kind: "tabbed", right: latestWidth };
          }
          // Left handle is only rendered in three-panel, but guard anyway.
          if (prev.kind !== "three-panel") return prev;
          return { ...prev, left: latestWidth };
        });
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        dragListenersRef.current = null;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        try {
          localStorage.setItem(storageKey, String(latestWidth));
        } catch (err) {
          console.warn(`[tandem] failed to persist ${storageKey}:`, err);
        }
      };

      dragListenersRef.current = { move: onMouseMove, up: onMouseUp };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [setPanelLayout],
  );

  return { handleResizeStart };
}
