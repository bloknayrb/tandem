/**
 * Margin-bubble collision avoidance — pure helper extracted from
 * `MarginColumn.svelte` so the sweep is independently unit-testable.
 *
 * Each bubble has a raw `top` (from `useMarginPositions`, derived from
 * `coordsAtPos`) and a measured `height` (from `bind:clientHeight`). When two
 * bubbles would overlap, the lower one is pushed down so it sits `gap` pixels
 * below the previous bubble's bottom edge. Bubbles whose height is unknown
 * (not yet measured) are skipped from the sweep — their natural top wins.
 *
 * The returned map is a NEW object; callers can safely treat it as the source
 * of truth for a `$derived` layer without writing into the same `$state` that
 * `useMarginPositions` exposes (which would create the effect-depth hazard
 * documented in `feedback_svelte_effect_depth_guard`).
 */
export interface CollisionInput {
  id: string;
  top: number;
  height: number | undefined;
}

export interface CollisionOptions {
  /** Vertical pixels between two stacked bubbles. */
  gap?: number;
}

const DEFAULT_GAP = 6;

/**
 * Sort by raw `top` ascending, then walk and push each subsequent bubble down
 * to clear the previous bubble's bottom. Bubbles with unknown height are
 * still emitted at their natural `top` (they just don't participate as
 * push-sources, since we don't know their bottom edge).
 *
 * Stable ordering for equal tops: input order is preserved by tagging the
 * original index pre-sort.
 */
export function resolveCollisions(
  bubbles: readonly CollisionInput[],
  options: CollisionOptions = {},
): Map<string, number> {
  const gap = options.gap ?? DEFAULT_GAP;
  const adjusted = new Map<string, number>();
  if (bubbles.length === 0) return adjusted;

  // Tag with original index to break ties stably.
  const ordered = bubbles
    .map((b, idx) => ({ ...b, idx }))
    .sort((a, b) => a.top - b.top || a.idx - b.idx);

  let cursor = Number.NEGATIVE_INFINITY;
  for (const b of ordered) {
    if (!Number.isFinite(b.top)) continue;
    const next = Math.max(b.top, cursor);
    adjusted.set(b.id, next);
    if (typeof b.height === "number" && Number.isFinite(b.height) && b.height > 0) {
      cursor = next + b.height + gap;
    }
    // If height unknown, do NOT advance the cursor — the next bubble's natural
    // top is still our best guess. Once measurement lands the next frame will
    // recompute and converge.
  }

  return adjusted;
}
