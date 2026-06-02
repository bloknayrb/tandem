/**
 * Cubic-bezier leader geometry for margin-view annotation connectors.
 *
 * Endpoints + control-point placement match `MarginFrame.svelte` from the C4
 * design bundle: horizontal tangents at both endpoints, both control points set
 * a proportional `SETTLE_K` (0.62) of the horizontal span inward — a symmetric
 * "settle" lay-in that stays smooth even at large vertical deltas
 * (collision-pushed bubbles).
 *
 * Endpoints are GEOMETRIC column-X, not glyph-X. The leader runs from the
 * text-track edge to the margin-column edge; the anchor dot sits at the
 * bezier's text-edge endpoint (same X as the bezier start).
 *
 * Sibling pattern matches `marginCollision.ts` — pure module, importable from
 * both `.svelte` template and vitest.
 */

import type { Annotation } from "../../shared/types.js";

export interface LeaderEndpoints {
  /** SVG-local X at the text-edge endpoint (= dot center X). */
  readonly startX: number;
  /** SVG-local Y at the text-edge endpoint (= dot center Y = raw anchor top). */
  readonly startY: number;
  /** SVG-local X at the bubble-edge endpoint. */
  readonly endX: number;
  /** SVG-local Y at the bubble-edge endpoint (= bubble title row baseline). */
  readonly endY: number;
}

/** Horizontal-tangent tension for the "settle" leader (bundle MarginFrame.svelte:30). */
const SETTLE_K = 0.62;

/**
 * Build the SVG path `d` attribute for one bezier "settle" leader. Mirrors the
 * bundle's `settlePath` (MarginFrame.svelte:43-49): both control points sit a
 * proportional `SETTLE_K` of the horizontal span inward, sharing the endpoint Y,
 * so the curve leaves the anchor and meets the card both horizontally with one
 * gentle symmetric bend between — the "settle" lay-in that replaced the old
 * fixed 10/8px asymmetric offsets (C4 canon decision 1, #798).
 *
 * Side-agnostic: `dx = endX − startX` is naturally signed (right-side bubble →
 * dx > 0, left-side → dx < 0), so the control points mirror without a `side`
 * flag. Because `SETTLE_K > 0.5` the control points cross in X — this is the
 * intended settle shape, and X(t) stays strictly monotonic (no kink). Degrades
 * to a clean horizontal line when the card is level with its anchor (all Y
 * equal) and to a vertical line when the columns share an X (dx = 0).
 *
 * Coordinate values are rounded to 1 decimal (`toFixed(1)`) — stable across
 * float-arithmetic jitter for snapshot tests. Comma-separated, matching the
 * production format (NOT the bundle's space separators).
 */
export function bezierLeaderPath(e: LeaderEndpoints): string {
  const dx = e.endX - e.startX;
  const cx1 = e.startX + dx * SETTLE_K;
  const cx2 = e.endX - dx * SETTLE_K;
  return (
    `M ${e.startX.toFixed(1)},${e.startY.toFixed(1)} ` +
    `C ${cx1.toFixed(1)},${e.startY.toFixed(1)} ` +
    `${cx2.toFixed(1)},${e.endY.toFixed(1)} ` +
    `${e.endX.toFixed(1)},${e.endY.toFixed(1)}`
  );
}

function assertNever(value: never): never {
  throw new Error(`unhandled annotation author: ${String(value)}`);
}

/**
 * Per-annotation stroke + dot color, keyed on annotation `author`. Matches
 * `MarginFrame.svelte:135-137`. Imports get the neutral fg-subtle tone so a
 * Word-comment-derived annotation reads distinct from a Claude comment at a
 * glance. Returned strings are CSS `color` values (custom-property refs),
 * used directly on `stroke` / `fill` attributes.
 *
 * The `default` branch is unreachable under TS; `assertNever` exists so a
 * future fourth `Annotation.author` value breaks the build rather than
 * silently bucketing into the import treatment (which would be the wrong
 * default for whatever the new value would mean).
 */
export function leaderColorForAuthor(author: Annotation["author"]): string {
  switch (author) {
    case "claude":
      return "var(--tandem-author-claude)";
    case "user":
      return "var(--tandem-author-user)";
    case "import":
      return "var(--tandem-fg-subtle)";
    default:
      return assertNever(author);
  }
}
