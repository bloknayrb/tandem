/**
 * Vertical-pressure resolution for margin bubbles — the pure helper behind the
 * crowd-minimize behaviour (#917, the "Stage E" idea that was filed *not
 * planned* until now). Sibling to `marginCollision.ts` / `cardDensity.ts`.
 *
 * ## The problem
 *
 * `resolveCollisions` pushes overlapping bubbles down without bound, so a
 * cluster of tall cards drifts hundreds of pixels away from the text it
 * annotates. This module decides which cards should render at reduced density
 * so the stack fits closer to its anchors.
 *
 * ## The cycle, and why this signature closes it
 *
 * Density changes a card's rendered height. If the crowding verdict were
 * computed from *measured* heights, we would have
 * `density → height → collision → density` — a live reactive cycle. That is
 * exactly what the PR #909 review rejected and what `cardDensity.ts` and
 * `MarginColumn.svelte` both warn about.
 *
 * So every input here is either a RAW anchor top (from `coordsAtPos`, which
 * depends only on editor content) or the annotation MODEL (type, content
 * length, reply count) or track geometry. **Never a measured card height.**
 * Note that #917's own sketch — `pressure(positions, heights, columnHeight)` —
 * would have reopened the cycle, because `heights` is measured density output;
 * its later bullet only forbids `adjustedPositions`, which is insufficient.
 *
 * The regression to guard against is a future "use the real measured height for
 * a better verdict" edit. `tests/client/marginPressure.test.ts` asserts the
 * signature for that reason; declaration order in the component is
 * documentation, not enforcement.
 *
 * There is one live feedback path worth knowing about: absolutely positioned
 * bubbles DO contribute to `.editor-scroll`'s scrollable overflow, so a
 * vertical scrollbar appearing as the stack's extent changes would narrow the
 * content box → rewrap → new raw tops → new verdict. That loop is closed only
 * because `scroll-fade.css` hides the editor scrollbar — and that rule sits
 * behind an `@supports (mask-image: …)` gate whose fallback restores it. Under
 * the fallback branch, the hysteresis bands below are what keep it from
 * oscillating.
 *
 * ## Why hysteresis is required
 *
 * `useMarginPositions`' `mapsEqual` 0.5px tolerance is an *equality guard*, not
 * a Schmitt trigger — it suppresses sub-pixel updates but neither quantizes nor
 * damps. Raw tops shift by a whole line-height (~24px) whenever a line rewraps,
 * so without a band a single keystroke near the threshold flips the verdict at
 * full amplitude, and measured heights then lag a frame, making every flip cost
 * a visible settle. `docs/plans/2026-05-28-stage-c-cleave-locks.md` §"Resolved
 * forks" is explicit that the presence-collapse input is band-free *because* it
 * is a stable binary; a thresholded continuous metric fails that test by
 * construction.
 */
import { DEFAULT_GAP } from "./marginCollision.js";

/**
 * Enter the crowded state above this much drift (px), leave it below
 * `CROWD_EXIT_PX`. Roughly ±one line-height around a ~40px intent, so a single
 * rewrap cannot round-trip the verdict.
 *
 * Visual-taste values in the vein of `MARGIN_TRACK_GEOMETRY`'s estimates —
 * tunable, but keep `EXIT < ENTER` or the band inverts and the damping is lost.
 */
export const CROWD_ENTER_PX = 48;
export const CROWD_EXIT_PX = 24;

/** Vertical space a card's own chrome costs regardless of body content. */
const CARD_CHROME_PX = 24 /* padding */ + 2 /* border */ + 8 /* margin-bottom */;
const HEADER_ROW_PX = 20;
const SNIPPET_PX = 34;
const ACTION_ROW_PX = 30;
const REPLY_TOGGLE_PX = 22;
/** Extra box a suggestion's word-level diff renders above its reason text. */
const SUGGESTION_DIFF_PX = 44;
/** Body line box at 13px / 1.45 leading. */
const BODY_LINE_PX = 19;
/** Approximate glyph advance for the 13px card body font. */
const BODY_CHAR_PX = 6.6;

/**
 * The shape `estimateHeightPx` needs. A structural subset of `Annotation` so
 * tests can build inputs without a full annotation, and so it is obvious at the
 * call site that no measurement is involved.
 */
export interface CardModel {
  /** `annotation.content.length`. */
  contentLength: number;
  /** Whether `textSnapshot` will render an `AnnotationSnippet`. */
  hasSnippet: boolean;
  /** Whether `suggestedText` will render the word-diff box. */
  hasSuggestion: boolean;
  /** Count of ADR-027-visible replies. */
  replyCount: number;
  /** Whether the card will render an action row (accept/dismiss/remove). */
  hasActions: boolean;
}

export interface PressureInput {
  id: string;
  /** Raw anchor top from `useMarginPositions` — never a collision-adjusted top. */
  top: number;
  model: CardModel;
}

export interface PressureOptions {
  /**
   * MEASURED bubble column width (px). Drives the body line-wrapping estimate,
   * which dominates a full card's height.
   *
   * This must be the *resolved* width, not the mode's base `column` value: the
   * grid track is elastic (240→400px at `full`), so budgeting against the base
   * would compute ~40% too many body lines whenever the track has grown, and the
   * pass would over-fire — minimizing cards that had room to stay full, defeating
   * the elastic feature's whole purpose.
   *
   * Measuring a WIDTH does not reopen the density cycle: track width is a
   * function of stage width, the reading measure, and the mode — never of card
   * heights (bubbles are absolutely positioned, so they cannot size their track).
   * The forbidden input is a density-DEPENDENT measurement, not any measurement.
   */
  columnWidthPx?: number;
  gap?: number;
}

const DEFAULT_COLUMN_PX = 240;
/**
 * Card chrome is estimated at the `cozy` spacing scale. The density setting
 * swaps `--tandem-space-3` between 10/12/16px, so compact/spacious skew the
 * chrome term by ~6px per card. Left unparameterized deliberately: the dominant
 * term is body wrapping (content length ÷ column width), which IS parameterized,
 * and a ~6px skew is well inside the 24px hysteresis band.
 */
const CARD_PADDING_X_PX = 24;

/**
 * Estimated rendered height of a card at a given density, from the annotation
 * MODEL only. Exported for unit testing and for the caller's own diagnostics.
 *
 * A single constant was tried first and is wrong: real full cards run roughly
 * 115–260px, so a floor-of-the-range constant computes zero drift for anchors
 * ~130px apart while reality drifts ~50px per step — it under-fires on exactly
 * the clustered-tall-cards case this feature targets.
 *
 * `compact` keeps the action row (Bryan's call — minimizing should not cost an
 * extra click to reach Accept/Reject); `clamped` drops it, because a 160px
 * `narrow` column cannot fit it.
 */
export function estimateHeightPx(
  model: CardModel,
  density: "full" | "compact",
  columnWidthPx: number = DEFAULT_COLUMN_PX,
): number {
  let h = CARD_CHROME_PX + HEADER_ROW_PX;

  if (density === "compact") {
    // Body clamped to one line, snippet + replies hidden, action row KEPT —
    // that last part is what distinguishes `compact` from `clamped`.
    h += BODY_LINE_PX;
    if (model.hasActions) h += ACTION_ROW_PX;
    return h;
  }

  const charsPerLine = Math.max(1, Math.floor((columnWidthPx - CARD_PADDING_X_PX) / BODY_CHAR_PX));
  const bodyLines = Math.max(1, Math.ceil(model.contentLength / charsPerLine));

  if (model.hasSnippet) h += SNIPPET_PX;
  if (model.hasSuggestion) h += SUGGESTION_DIFF_PX;
  h += bodyLines * BODY_LINE_PX;
  if (model.replyCount > 0) h += REPLY_TOGGLE_PX;
  if (model.hasActions) h += ACTION_ROW_PX;
  return h;
}

/**
 * Decide which bubbles should render minimized so the stack sits near its
 * anchors.
 *
 * Simulate placement with every card at its estimated FULL height, then run a
 * bounded greedy relief loop: while some card's own drift exceeds the enter
 * threshold, minimize the tallest not-yet-minimized card at or above the
 * violation and re-simulate. Halts at no-violation or all-minimized, capped at
 * `bubbles.length` iterations so it is deterministic and always terminates.
 *
 * Marking the whole overlapping *run* was the first design and is wrong: drift
 * is monotone within a run, so ten anchors 100px apart would mark all ten when
 * minimizing the last three suffices — in a normally-annotated document nearly
 * everything lands in one run and the column collapses wholesale.
 *
 * `prevCrowded` supplies the hysteresis band: a card already minimized stays
 * minimized until its drift falls below `exitPx`.
 */
export function resolveCrowding(
  bubbles: readonly PressureInput[],
  prevCrowded: ReadonlySet<string> = new Set(),
  options: PressureOptions = {},
): Set<string> {
  const gap = options.gap ?? DEFAULT_GAP;
  const columnWidthPx = options.columnWidthPx ?? DEFAULT_COLUMN_PX;

  const crowded = new Set<string>();
  if (bubbles.length === 0) return crowded;

  // Stable ordering identical to `resolveCollisions` so both passes agree on who
  // pushes whom. NOTE: that agreement is a comment-level coupling, not an
  // enforced one — if `resolveCollisions`' sort or cursor recurrence ever
  // changes, this must change with it or the verdict silently disagrees with the
  // real layout. (The two walks deliberately do NOT share an implementation: the
  // sweep below runs up to n times and uses index-keyed typed arrays to stay
  // O(n²), whereas `resolveCollisions` runs once and returns an id-keyed Map.)
  const ordered = bubbles
    .map((b, idx) => ({ ...b, idx }))
    .filter((b) => Number.isFinite(b.top))
    .sort((a, b) => a.top - b.top || a.idx - b.idx);
  const n = ordered.length;
  if (n === 0) return crowded;

  // Index-keyed typed arrays rather than per-iteration Maps: `simulate` runs up
  // to n+1 times, so Map churn here dominated the whole pass (measured 15.5ms at
  // n=200 before this; 0.3ms after).
  const tops = new Float64Array(n);
  const fullH = new Float64Array(n);
  const compactH = new Float64Array(n);
  const drift = new Float64Array(n);
  const minimized = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    tops[i] = ordered[i].top;
    fullH[i] = estimateHeightPx(ordered[i].model, "full", columnWidthPx);
    compactH[i] = estimateHeightPx(ordered[i].model, "compact", columnWidthPx);
  }

  /** Recompute `drift` in place for the current `minimized` set. */
  const simulate = (): void => {
    let cursor = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const place = Math.max(tops[i], cursor);
      drift[i] = place - tops[i];
      cursor = place + (minimized[i] ? compactH[i] : fullH[i]) + gap;
    }
  };

  /**
   * Tallest bubble at or above `upto` that is not yet minimized AND would
   * actually shrink. Ties keep the HIGHEST such index — i.e. the one closest to
   * the violation — so relief stays local. Returns -1 when nothing above `upto`
   * can help. (Do not "simplify" `>=` to `>`: that inverts the locality.)
   *
   * Scans from `firstRelievable`, not 0: every index below the watermark is
   * PERMANENTLY either already minimized or zero-gain (see the watermark
   * comment below), so re-scanning it here can never change the result — it
   * would just re-pay a provably-null scan on every call. This is load-bearing
   * for the O(n²) bound, not a redundant optimization on top of it: without it,
   * this O(n) scan can run up to n times per outer iteration (once per
   * violation walked in the loop below) for up to n outer iterations, i.e. the
   * O(n³) this module claims to have fixed.
   */
  const bestCandidate = (upto: number): number => {
    let best = -1;
    let bestGain = 0;
    for (let i = firstRelievable; i <= upto; i++) {
      if (minimized[i]) continue;
      const gain = fullH[i] - compactH[i];
      // Skip zero-gain cards: minimizing one is a visible density change that
      // relieves nothing and burns an iteration.
      if (gain <= 0) continue;
      if (gain >= bestGain) {
        best = i;
        bestGain = gain;
      }
    }
    return best;
  };

  simulate();

  // Monotone watermark: `minimized` only grows, so once every relievable card at
  // or above `firstRelievable` is minimized the index can only move forward.
  // `bestCandidate(v)` returns -1 for exactly `v < firstRelievable`, so skipping
  // those is behaviour-preserving — and it's what drops the loop from O(n³) to
  // O(n²) (it otherwise re-pays a provably-null scan on every iteration).
  let firstRelievable = 0;
  const advanceWatermark = (): void => {
    while (
      firstRelievable < n &&
      (minimized[firstRelievable] || fullH[firstRelievable] - compactH[firstRelievable] <= 0)
    ) {
      firstRelievable++;
    }
  };
  advanceWatermark();

  // Each iteration minimizes exactly one bubble, so n iterations is a hard
  // ceiling — the loop always terminates.
  for (let iter = 0; iter < n; iter++) {
    if (firstRelievable >= n) break; // nothing left that could shrink

    // Walk every violation, not just the first. A violation whose contributors
    // are ALL already minimized is unsatisfiable (you cannot fit three cards into
    // 40px of anchor space), but abandoning the scan there would leave every
    // bubble BELOW it rendering full while badly drifted — measured: 5 bubbles
    // 40px apart minimized only 2 and left a 458px residual drift. Skipping to
    // the next relievable violation compresses the rest as far as it can go.
    let chosen = -1;
    for (let v = firstRelievable; v < n; v++) {
      if (drift[v] <= CROWD_ENTER_PX) continue;
      chosen = bestCandidate(v);
      if (chosen >= 0) break;
    }
    if (chosen < 0) break; // no relievable violation anywhere → settled

    minimized[chosen] = 1;
    advanceWatermark();
    simulate();
  }

  // Apply the hysteresis band against the previous verdict.
  for (let i = 0; i < n; i++) {
    const id = ordered[i].id;
    if (minimized[i]) {
      crowded.add(id);
    } else if (prevCrowded.has(id) && drift[i] >= CROWD_EXIT_PX) {
      // Inside the band — hold the previous verdict rather than flapping.
      crowded.add(id);
    }
  }

  return crowded;
}
