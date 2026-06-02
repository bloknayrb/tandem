import type { Editor as TiptapEditor } from "@tiptap/core";

export const SELECTION_TOOLBAR_MIN_TOP = 48;
export const SELECTION_TOOLBAR_EDGE_GAP = 8;
export const SELECTION_TOOLBAR_SELECTION_GAP = 10;
// Asymmetric flip thresholds: enter "above" when there's >=4px of slack above
// MIN_TOP, exit only after dropping >=4px below it. A 1px boundary drift
// (sub-pixel scroll, font-metric jitter) otherwise flips placement every
// frame and the toolbar visibly shimmers.
export const SELECTION_TOOLBAR_FLIP_HYSTERESIS = 4;

// Conservative height used by the A26 morph (#798) to DECIDE placement, so the
// above/below choice is stable across the format↔annotate morph (the popup's
// real height animates ~73→~85px). Passing this constant — rather than the live
// animating `toolbarHeight` — means a placement re-decision can't flip mid-morph
// and the height-independent edge-anchor (`bottom` for above) always clears
// MIN_TOP as the popup grows to its real height. A safe over-estimate of the
// real popup height (~85px) — the morph grows each block to its natural height
// (grid-row 0fr→1fr), so there is no fixed max-height cap for this to match.
export const SELECTION_POPUP_HEIGHT_RESERVE = 200;

export type SelectionToolbarPlacement = "above" | "below";

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
  /**
   * Last placement returned by this function for the current toolbar instance.
   * Used purely for hysteresis at the above/below flip boundary; pass
   * `undefined` on the first call. Callers should store this in a plain `let`
   * (not reactive state) since the function is invoked from a Tiptap event
   * listener, not from a Svelte $effect — reading+writing reactive state
   * inside an effect that fires on every selection update would risk an
   * effect_update_depth crash.
   */
  previousPlacement?: SelectionToolbarPlacement;
}

export interface SelectionToolbarPosition {
  left: number;
  top: number;
  /**
   * Height-independent anchor for `above` placement: the CSS `bottom` distance
   * (from viewport bottom) that pins the popup's bottom edge a gap above the
   * selection's top. Used by the A26 morph (#798) so an above-placed popup
   * grows UPWARD as its height animates — no per-frame JS reposition, no
   * grow-over-selection, no snap. Always computed; the caller consumes it only
   * when `placement === "above"` (a `below` popup is top-anchored via `top`).
   */
  bottom: number;
  placement: SelectionToolbarPlacement;
}

export function computeSelectionToolbarPosition({
  start,
  end,
  toolbarHeight,
  toolbarWidth,
  viewportHeight,
  viewportWidth,
  previousPlacement,
}: SelectionToolbarPositionArgs): SelectionToolbarPosition {
  const rawLeft = (start.left + end.right) / 2;
  const halfWidth = toolbarWidth / 2;
  const minLeft = SELECTION_TOOLBAR_EDGE_GAP + halfWidth;
  const maxLeft = Math.max(minLeft, viewportWidth - SELECTION_TOOLBAR_EDGE_GAP - halfWidth);

  // Default placement is above the selection — but if the natural above-top
  // would intrude on the chrome reserved by SELECTION_TOOLBAR_MIN_TOP, flip
  // the toolbar below the selection so it never sits on top of fixed bars
  // (TitleBar + FormattingBar = 76px of chrome). When even below would push
  // the toolbar off-screen, fall back to anchoring the toolbar at the
  // bottom of the viewport — this is better than clamping onto the chrome,
  // because intercepting fixed-bar clicks is what triggered #678 in the
  // first place.
  const selectionTop = Math.min(start.top, end.top);
  const selectionBottom = Math.max(start.bottom, end.bottom);
  const aboveTop = selectionTop - SELECTION_TOOLBAR_SELECTION_GAP - toolbarHeight;
  const belowTop = selectionBottom + SELECTION_TOOLBAR_SELECTION_GAP;
  const belowBottom = belowTop + toolbarHeight;

  // Asymmetric hysteresis on the above/below boundary. Entry requires +H slack
  // over MIN_TOP; once placed above, exit doesn't trip until -H of slack — so a
  // selection oscillating around the boundary doesn't repaint every frame.
  const enterAboveThreshold = SELECTION_TOOLBAR_MIN_TOP + SELECTION_TOOLBAR_FLIP_HYSTERESIS;
  const exitAboveThreshold = SELECTION_TOOLBAR_MIN_TOP - SELECTION_TOOLBAR_FLIP_HYSTERESIS;
  const aboveThreshold = previousPlacement === "above" ? exitAboveThreshold : enterAboveThreshold;
  const fitsAbove = aboveTop >= aboveThreshold;
  const fitsBelow = belowBottom <= viewportHeight - SELECTION_TOOLBAR_EDGE_GAP;

  const maxTop = Math.max(
    SELECTION_TOOLBAR_MIN_TOP,
    viewportHeight - toolbarHeight - SELECTION_TOOLBAR_EDGE_GAP,
  );

  let rawTop: number;
  let placement: SelectionToolbarPlacement;
  if (fitsAbove) {
    rawTop = aboveTop;
    placement = "above";
  } else if (fitsBelow) {
    rawTop = belowTop;
    placement = "below";
  } else {
    // Neither fits — pin to viewport bottom rather than clamping back into the
    // chrome zone. Selections that straddle the fold hit this branch.
    rawTop = maxTop;
    placement = "below";
  }

  // Height-independent above-anchor: pin the popup's bottom edge a selection-gap
  // above the selection's top. Independent of `toolbarHeight`, so the popup can
  // grow upward during the morph without any reposition.
  const bottom = viewportHeight - (selectionTop - SELECTION_TOOLBAR_SELECTION_GAP);

  return {
    left: Math.min(Math.max(rawLeft, minLeft), maxLeft),
    top: Math.min(Math.max(rawTop, SELECTION_TOOLBAR_MIN_TOP), maxTop),
    bottom,
    placement,
  };
}

export function attachSelectionToolbarListener(
  editor: Pick<TiptapEditor, "on" | "off">,
  onSelectionUpdate: () => void,
): () => void {
  editor.on("selectionUpdate", onSelectionUpdate);
  return () => editor.off("selectionUpdate", onSelectionUpdate);
}
