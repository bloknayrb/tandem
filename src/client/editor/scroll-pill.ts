/**
 * Pure geometry + opacity math for the editor scroll pill.
 *
 * Kept DOM-free so every branch is unit-testable without a browser. The
 * component (`ScrollPill.svelte`) owns all reads/writes; this module owns all
 * arithmetic. Nothing here touches `window`, `performance`, or the clock —
 * elapsed times are passed in.
 */

/** Floor for the thumb so a very long document still leaves a grabbable target. */
export const MIN_THUMB_PX = 36;

/** At or below this cursor distance the pill is fully lit. */
export const NEAR_PX = 48;

/** At or beyond this cursor distance the pill is fully transparent. */
export const FAR_PX = 260;

/**
 * Opacity below which the thumb stops accepting pointer events entirely.
 *
 * A thumb painted at 1% alpha that still swallows clicks is a mystery hit zone
 * over the document's right edge. The proximity ramp guarantees the pill is
 * well past this by the time a cursor could reach it, so the gate never costs
 * a reachable interaction.
 */
export const HIT_TEST_MIN_OPACITY = 0.02;

/** Full-strength window after a scroll, before the flash starts decaying. */
export const FLASH_HOLD_MS = 650;

/** Decay ramp following {@link FLASH_HOLD_MS}. */
export const FLASH_FADE_MS = 450;

export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  trackHeight: number;
  /**
   * Height of deliberate trailing whitespace that is NOT document content —
   * `.editor-end-marker`'s `70vh` of scroll room, which exists so the outline's
   * last heading can pin to the top of the viewport.
   *
   * This must be subtracted or the pill lies twice over: on a 900px viewport
   * the marker alone makes every document past ~126px "overflow", so a
   * five-line note grows a scrollbar; and the thumb would report a one-screen
   * document as ~59% visible, then drop the user onto a blank screen when
   * dragged to the bottom.
   *
   * Consequence of subtracting it, which is deliberate: wheel-scrolling on
   * through the trailing whitespace leaves the thumb pinned at the track
   * bottom. The thumb tracks the *document*, not the scrollable extent.
   */
  trailingSpacerPx?: number;
}

export interface ThumbMetrics {
  /** Thumb height in px. */
  height: number;
  /** Thumb offset from the top of the track, in px. */
  top: number;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Scrollable extent the pill represents: everything above the trailing spacer.
 * Shared by {@link thumbMetrics} and {@link scrollTopForThumbTop} so the render
 * path and the drag path can never disagree about where the document ends.
 */
function contentExtent(geo: {
  scrollHeight: number;
  clientHeight: number;
  trailingSpacerPx?: number;
}): { contentHeight: number; maxScroll: number } {
  const spacer = Math.max(0, geo.trailingSpacerPx ?? 0);
  // Never let the spacer subtraction drive the content below one viewport —
  // that would invert maxScroll and flip the thumb.
  const contentHeight = Math.max(geo.clientHeight, geo.scrollHeight - spacer);
  return { contentHeight, maxScroll: Math.max(0, contentHeight - geo.clientHeight) };
}

/**
 * Thumb size + position for the current scroll state, or `null` when the
 * document does not overflow (nothing to scrub, so nothing to render).
 *
 * The 1px slack on the overflow test matches `scrollFade`'s `update()` — a
 * sub-pixel difference is a fractional-layout artifact, not real overflow.
 */
export function thumbMetrics(geo: ScrollGeometry): ThumbMetrics | null {
  const { scrollTop, clientHeight, trackHeight } = geo;
  const { contentHeight, maxScroll } = contentExtent(geo);
  if (!(maxScroll > 1) || !(trackHeight > 0) || !(contentHeight > 0)) return null;

  const proportional = trackHeight * (clientHeight / contentHeight);
  // The floor can exceed the track on a very short viewport; the track always
  // wins so the thumb never overflows its own bounds.
  const height = clamp(proportional, Math.min(MIN_THUMB_PX, trackHeight), trackHeight);

  const travel = trackHeight - height;
  const top = clampThumbTop((scrollTop / maxScroll) * travel, {
    trackHeight,
    thumbHeight: height,
  });
  return { height, top };
}

/**
 * Inverse of {@link thumbMetrics}'s `top`: the `scrollTop` that would place the
 * thumb at `thumbTop`. Used by the drag handler.
 *
 * `thumbHeight` is passed in rather than recomputed so a drag in progress keeps
 * the thumb size it started with even if `scrollHeight` changes underneath it.
 */
export function scrollTopForThumbTop(
  thumbTop: number,
  geo: {
    trackHeight: number;
    thumbHeight: number;
    scrollHeight: number;
    clientHeight: number;
    trailingSpacerPx?: number;
  },
): number {
  const { maxScroll } = contentExtent(geo);
  if (!(maxScroll > 0)) return 0;
  const travel = geo.trackHeight - geo.thumbHeight;
  // Degenerate: thumb fills the track, so every position maps to the same
  // scroll offset. Returning 0 (rather than dividing by zero) keeps a drag on a
  // barely-overflowing document inert instead of teleporting it.
  if (!(travel > 0)) return 0;
  return clamp((thumbTop / travel) * maxScroll, 0, maxScroll);
}

/**
 * Clamp a proposed thumb offset into its track. The drag path renders the thumb
 * from the pointer position directly rather than round-tripping through
 * `scrollTop` — a round trip quantizes the thumb to whole-pixel scroll offsets
 * and makes the grab feel notchy on a long document.
 *
 * Pair this with the FROZEN drag geometry, not live measurements: if
 * `scrollHeight` changes mid-grab (an image decodes, margin annotations mount)
 * a live `thumbHeight` would resize the thumb out from under the pointer's grab
 * offset. Freeze at `pointerdown`, re-sync on release.
 */
export function clampThumbTop(
  thumbTop: number,
  geo: { trackHeight: number; thumbHeight: number },
): number {
  const travel = geo.trackHeight - geo.thumbHeight;
  return travel <= 0 ? 0 : clamp(thumbTop, 0, travel);
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Euclidean distance from a point to the nearest point of a rect. Zero when the
 * point is inside. This — not distance-to-center — is what makes the fade feel
 * right: a tall thumb should light up when you approach its flank, not only
 * when you approach its midpoint.
 */
export function rectDistance(px: number, py: number, rect: Rect): number {
  const dx = Math.max(rect.left - px, 0, px - rect.right);
  const dy = Math.max(rect.top - py, 0, py - rect.bottom);
  return Math.hypot(dx, dy);
}

/** Smoothstep, for a falloff without a hard edge at either end of the ramp. */
function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * Opacity for a given cursor distance: fully opaque at or inside
 * {@link NEAR_PX}, fully transparent at or beyond {@link FAR_PX}, smoothly
 * eased between.
 *
 * The peak is a full 1.0 rather than something artfully faint: the thumb paints
 * from `--tandem-scrollbar-thumb`, whose contrast against the page background
 * already sits near the WCAG 1.4.11 floor at full strength. Under-painting the
 * resting state would put the *identifying* state of the control below 3:1, and
 * a hover boost does not rescue that. The unobtrusiveness comes entirely from
 * the distance falloff, which is the actual requirement.
 *
 * `Infinity` (pointer has left the window) is a valid input and yields 0.
 */
export function proximityOpacity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  if (distance <= NEAR_PX) return 1;
  if (distance >= FAR_PX) return 0;
  return 1 - smoothstep((distance - NEAR_PX) / (FAR_PX - NEAR_PX));
}

/**
 * Opacity contribution of the post-scroll flash. Full for
 * {@link FLASH_HOLD_MS}, then linear to zero over {@link FLASH_FADE_MS}.
 * Returns 0 once spent, which is also the signal that the animation loop can
 * stop.
 */
export function flashOpacity(elapsedMs: number): number {
  if (elapsedMs <= FLASH_HOLD_MS) return 1;
  const decayed = 1 - (elapsedMs - FLASH_HOLD_MS) / FLASH_FADE_MS;
  return decayed <= 0 ? 0 : decayed;
}

/**
 * Final opacity for the frame. A drag pins it to 1 — the drag handler
 * deliberately stops updating the pointer cache, so proximity would otherwise
 * go stale mid-scrub. Otherwise the two contributions compose by `max`:
 * whichever reason to be visible is stronger wins, so a decaying flash never
 * *dims* a pill the cursor is already close to.
 *
 * There is no `hovered` term. Hover is not a separate state here — a pointer
 * over the thumb is at distance 0, which `proximityOpacity` already maps to 1.
 * Both inputs are `[0, 1]` by construction, so no clamp is needed either.
 */
export function composeOpacity(args: {
  proximity: number;
  flash: number;
  dragging: boolean;
}): number {
  if (args.dragging) return 1;
  return Math.max(args.proximity, args.flash);
}
