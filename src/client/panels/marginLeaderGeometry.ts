/**
 * Cubic-bezier leader geometry for margin-view annotation connectors.
 *
 * Endpoints + control-point placement match `MarginFrame.svelte` from the C4
 * design bundle: horizontal tangents at both endpoints, control points offset
 * 10px / 8px inward from the endpoint columns. Smooth "lays into" curve even
 * at large vertical deltas (collision-pushed bubbles).
 *
 * Endpoints are GEOMETRIC column-X, not glyph-X. The leader runs from the
 * text-track edge to the margin-column edge; the anchor dot sits at the
 * bezier's text-edge endpoint (same X as the bezier start).
 *
 * Sibling pattern matches `marginCollision.ts` — pure module, importable from
 * both `.svelte` template and vitest.
 */

import type { Annotation } from "../../shared/types.js";

export type LeaderSide = "left" | "right";

export interface LeaderEndpoints {
  /** SVG-local X at the text-edge endpoint (= dot center X). */
  readonly startX: number;
  /** SVG-local Y at the text-edge endpoint (= dot center Y = raw anchor top). */
  readonly startY: number;
  /** SVG-local X at the bubble-edge endpoint. */
  readonly endX: number;
  /** SVG-local Y at the bubble-edge endpoint (= bubble title row baseline). */
  readonly endY: number;
  /** Which side the bubble column sits on — flips control-point sign. */
  readonly side: LeaderSide;
}

/**
 * Build the SVG path `d` attribute for one bezier leader. Mirrors the bundle's
 * `M ax,ay C cx1,ay cx2,by bx,by` shape (MarginFrame.svelte:151-156).
 *
 * Control points sit 10px inward from startX and 8px inward from endX along
 * the X axis, sharing the endpoint Y. "Inward" flips with side: for a
 * right-side bubble the leader runs left→right, so cx1 = startX + 10 and
 * cx2 = endX − 8. For a left-side bubble it's mirrored.
 *
 * Coordinate values are rounded to 1 decimal (`toFixed(1)`) — matching the
 * bundle, and stable across float-arithmetic jitter for snapshot tests.
 */
export function bezierLeaderPath(e: LeaderEndpoints): string {
  const inward = e.side === "right" ? 1 : -1;
  const cx1 = e.startX + 10 * inward;
  const cx2 = e.endX - 8 * inward;
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
