import type { Editor as TiptapEditor } from "@tiptap/core";

export const SELECTION_TOOLBAR_MIN_TOP = 48;
export const SELECTION_TOOLBAR_EDGE_GAP = 8;
// Gap between the cursor point and the popup's near edge (#798 cursor-origin).
export const SELECTION_TOOLBAR_CURSOR_GAP = 6;
// Asymmetric flip thresholds on the below/above boundary: enter "below" only with
// >=4px of slack under the viewport bottom, exit (to "above") only after
// overflowing it by >=4px. A 1px boundary drift (sub-pixel scroll, font-metric
// jitter) otherwise flips placement every frame and the toolbar visibly shimmers.
export const SELECTION_TOOLBAR_FLIP_HYSTERESIS = 4;

// Conservative height used by the A26 morph (#798) to DECIDE placement, so the
// above/below choice is stable across the format↔annotate morph. Since the A8
// two-pill restructure the format state is two stacked capsules + a 5px gap
// (~95–105px); the annotate composer (eyebrow + textarea max-height 120px +
// divider + buttons) remains the taller, binding case. Only `rect.width` feeds
// positioning — height reaches the placement math ONLY as this constant — so a
// taller format state can't move the anchor. Passing this constant rather than
// the live animating `toolbarHeight` means a placement re-decision can't flip
// mid-morph and the height-independent edge-anchor (`bottom` for above) always
// clears MIN_TOP as the popup grows.
//
// Must stay a genuine over-estimate. An under-estimate bites hardest on
// `below`, which is TOP-anchored, so the bottom of the card is clipped
// off-screen; `above` is bottom-anchored and immune to that, though not to the
// constant generally — `fitsAbove` consumes it too, so an under-estimate also
// lets an above-placed popup's top edge render past MIN_TOP into the chrome.
//
// #1385 broke the `below` half silently: the eyebrow row and the action row's
// divider + padding took the fully-scrolled composer to a measured 205px (cozy)
// / 225px (spacious) including the shell's 2px border, against a reserve of
// 200. (The larger type ramp is NOT a contributor — `.composer-input` is
// `box-sizing: border-box` under a hard `max-height`, so a taller line box
// changes how fast the field reaches the cap, not the cap. Both densities
// reconcile to the same 14px eyebrow row without it.) It was invisible because
// the reserve is a hand-maintained number with nothing asserting it against the
// rendered card. Measure the real max before trusting this again; density
// scales it — only `--tandem-space-*` is density-dependent, not the type ramp —
// so `spacious` is the case to measure.
//
// The cost of raising it, stated so it is not mistaken for a new bug: the
// neither-fits fallback pins `below` at `maxTop`, which moves UP as this grows.
// Below a viewport height of roughly 548px there is now a band where the popup
// is pinned above the cursor and can overlap the selection it annotates. Not
// reachable in the desktop app (`minHeight: 600` in tauri.conf.json), reachable
// in a short browser window. Accepted deliberately: overlapping a selection is
// recoverable, clipping the submit buttons off-screen is not.
export const SELECTION_POPUP_HEIGHT_RESERVE = 240;

export type SelectionToolbarPlacement = "above" | "below";

export interface SelectionToolbarPositionArgs {
  /**
   * Horizontal origin the popup unrolls away from — the user's cursor at popup
   * time (mouse pointer X for a pointer selection, caret X for a keyboard
   * selection; see Toolbar.svelte's latch). The popup's LEFT edge is pinned here
   * (left-anchored, not centered), so the format pills unroll rightward from the
   * cursor. Clamped so the toolbar's full measured width stays on-screen.
   */
  anchorX: number;
  /**
   * Vertical origin — the cursor Y at popup time (pointerup Y for a pointer
   * selection, the caret head's bottom for a keyboard selection). The popup is
   * anchored AT this point and unrolls away from it: a gap BELOW by default
   * (growing down), flipping ABOVE only when below would run off the viewport
   * bottom. This is what makes the popup appear where the cursor is, rather than
   * offset to the selection box.
   */
  anchorY: number;
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
   * cursor point. Used by the A26 morph (#798) so an above-placed popup grows
   * UPWARD as its height animates — no per-frame JS reposition, no snap. Always
   * computed; the caller consumes it only when `placement === "above"` (a `below`
   * popup is top-anchored via `top`).
   */
  bottom: number;
  placement: SelectionToolbarPlacement;
}

export function computeSelectionToolbarPosition({
  anchorX,
  anchorY,
  toolbarHeight,
  toolbarWidth,
  viewportHeight,
  viewportWidth,
  previousPlacement,
}: SelectionToolbarPositionArgs): SelectionToolbarPosition {
  // Left-anchored at the cursor: the popup's left edge sits at `anchorX` and the
  // pills unroll rightward from there (#798 cursor-origin unroll). Clamp keeps the
  // full measured width on-screen — minLeft is just the edge gap; maxLeft pushes
  // the whole popup left if the cursor is near the right edge.
  const minLeft = SELECTION_TOOLBAR_EDGE_GAP;
  const maxLeft = Math.max(minLeft, viewportWidth - SELECTION_TOOLBAR_EDGE_GAP - toolbarWidth);

  // Cursor-anchored vertical (Bryan 2026-06-03): the popup appears AT the cursor
  // point and unrolls away from it. Default BELOW the cursor — top edge a gap
  // under the point, growing down — the intuitive "appears at the pointer"
  // placement. Flip ABOVE only when below would run past the viewport bottom
  // (cursor near the bottom edge); if even above can't clear the top chrome
  // (MIN_TOP), pin to the viewport bottom rather than overlapping the fixed bars.
  const belowTop = anchorY + SELECTION_TOOLBAR_CURSOR_GAP;
  const belowBottom = belowTop + toolbarHeight;
  const aboveTop = anchorY - SELECTION_TOOLBAR_CURSOR_GAP - toolbarHeight;

  // Asymmetric hysteresis on the below/above boundary. Once below, stay below
  // until it overflows the viewport bottom by >H; entering below needs H of slack
  // — so a keyboard extend that nudges the anchor across the boundary doesn't
  // flip-flop every frame.
  const fitLimit = viewportHeight - SELECTION_TOOLBAR_EDGE_GAP;
  const belowLimit =
    previousPlacement === "below"
      ? fitLimit + SELECTION_TOOLBAR_FLIP_HYSTERESIS
      : fitLimit - SELECTION_TOOLBAR_FLIP_HYSTERESIS;
  const fitsBelow = belowBottom <= belowLimit;
  const fitsAbove = aboveTop >= SELECTION_TOOLBAR_MIN_TOP;

  const maxTop = Math.max(
    SELECTION_TOOLBAR_MIN_TOP,
    viewportHeight - toolbarHeight - SELECTION_TOOLBAR_EDGE_GAP,
  );

  let rawTop: number;
  let placement: SelectionToolbarPlacement;
  if (fitsBelow) {
    rawTop = belowTop;
    placement = "below";
  } else if (fitsAbove) {
    rawTop = aboveTop;
    placement = "above";
  } else {
    // Neither fits (tiny viewport) — pin to the viewport bottom rather than
    // clamping onto the chrome.
    rawTop = maxTop;
    placement = "below";
  }

  // Height-independent above-anchor: pin the popup's bottom edge a gap above the
  // cursor. Independent of `toolbarHeight`, so an above-placed popup grows upward
  // during the morph without any reposition.
  const bottom = viewportHeight - (anchorY - SELECTION_TOOLBAR_CURSOR_GAP);

  return {
    left: Math.min(Math.max(anchorX, minLeft), maxLeft),
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
