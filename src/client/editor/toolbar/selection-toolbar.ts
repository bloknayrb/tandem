import type { Editor as TiptapEditor } from "@tiptap/core";

export const SELECTION_TOOLBAR_MIN_TOP = 48;
export const SELECTION_TOOLBAR_EDGE_GAP = 8;
export const SELECTION_TOOLBAR_SELECTION_GAP = 10;

export interface SelectionToolbarBounds {
  left: number;
  top: number;
  bottom: number;
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

  // Default placement is above the selection — but if the natural above-top
  // would intrude on the chrome reserved by SELECTION_TOOLBAR_MIN_TOP, flip
  // the toolbar below the selection so it never sits on top of fixed bars
  // (TitleBar + FormattingBar = 76px of chrome, pre-#680 the toolbar would
  // clamp onto them and intercept clicks at `toolbar-highlight-btn`). When
  // even below would push the toolbar off-screen, fall back to the original
  // clamped-to-MIN_TOP behavior — the user has bigger problems than overlap
  // at that viewport height.
  const selectionTop = Math.min(start.top, end.top);
  const selectionBottom = Math.max(start.bottom, end.bottom);
  const aboveTop = selectionTop - SELECTION_TOOLBAR_SELECTION_GAP - toolbarHeight;
  const belowTop = selectionBottom + SELECTION_TOOLBAR_SELECTION_GAP;
  const belowBottom = belowTop + toolbarHeight;

  const fitsAbove = aboveTop >= SELECTION_TOOLBAR_MIN_TOP;
  const fitsBelow = belowBottom <= viewportHeight - SELECTION_TOOLBAR_EDGE_GAP;

  let rawTop: number;
  if (fitsAbove) rawTop = aboveTop;
  else if (fitsBelow) rawTop = belowTop;
  else rawTop = aboveTop;

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
