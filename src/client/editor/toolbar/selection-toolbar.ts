import type { Editor as TiptapEditor } from "@tiptap/core";

export const SELECTION_TOOLBAR_MIN_TOP = 48;
export const SELECTION_TOOLBAR_EDGE_GAP = 8;
export const SELECTION_TOOLBAR_SELECTION_GAP = 10;

export interface SelectionToolbarBounds {
  left: number;
  top: number;
  right: number;
}

export interface SelectionToolbarPositionArgs {
  start: SelectionToolbarBounds;
  end: SelectionToolbarBounds;
  toolbarHeight: number;
  toolbarWidth: number;
  viewportHeight: number;
  viewportWidth: number;
}

export function computeSelectionToolbarPosition({
  start,
  end,
  toolbarHeight,
  toolbarWidth,
  viewportHeight,
  viewportWidth,
}: SelectionToolbarPositionArgs): { left: number; top: number } {
  const rawLeft = (start.left + end.right) / 2;
  const halfWidth = toolbarWidth / 2;
  const minLeft = SELECTION_TOOLBAR_EDGE_GAP + halfWidth;
  const maxLeft = Math.max(minLeft, viewportWidth - SELECTION_TOOLBAR_EDGE_GAP - halfWidth);
  const rawTop = Math.min(start.top, end.top) - SELECTION_TOOLBAR_SELECTION_GAP - toolbarHeight;
  const maxTop = Math.max(
    SELECTION_TOOLBAR_MIN_TOP,
    viewportHeight - toolbarHeight - SELECTION_TOOLBAR_EDGE_GAP,
  );

  return {
    left: Math.min(Math.max(rawLeft, minLeft), maxLeft),
    top: Math.min(Math.max(rawTop, SELECTION_TOOLBAR_MIN_TOP), maxTop),
  };
}

export function attachSelectionToolbarListener(
  editor: Pick<TiptapEditor, "on" | "off">,
  onSelectionUpdate: () => void,
): () => void {
  editor.on("selectionUpdate", onSelectionUpdate);
  return () => editor.off("selectionUpdate", onSelectionUpdate);
}
