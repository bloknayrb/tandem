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
  viewportHeight: number;
}

export function computeSelectionToolbarPosition({
  start,
  end,
  toolbarHeight,
  viewportHeight,
}: SelectionToolbarPositionArgs): { left: number; top: number } {
  const left = (start.left + end.right) / 2;
  const rawTop = Math.min(start.top, end.top) - SELECTION_TOOLBAR_SELECTION_GAP - toolbarHeight;
  const maxTop = Math.max(
    SELECTION_TOOLBAR_MIN_TOP,
    viewportHeight - toolbarHeight - SELECTION_TOOLBAR_EDGE_GAP,
  );

  return {
    left,
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
