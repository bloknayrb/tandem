/**
 * Editor stage model (Phase 3.5).
 *
 * Owns the horizontal editor layout: a CSS Grid "stage" holding the editor
 * content track (reading-measure width) flanked by per-side margin-annotation
 * tracks, with `1fr` gutters centering the assembled block.
 *
 * Replaces the App.svelte width cascade (the old `editorMaxWidth` +
 * `MARGIN_VIEW_RESERVE_PX` global subtraction). The correctness fix over that
 * cascade: reserve is taken PER SIDE — only where a margin actually renders —
 * so opening a rail (which hides the margin on that side) no longer subtracts
 * phantom width from the content. With both rails open and margin view on, the
 * old code still subtracted the full both-sides reserve even though zero
 * margins rendered; the grid gives those cases their full content width.
 *
 * Stage B drives `--editor-measure` from the `editorMeasure` reading-measure
 * preset (ch widths, or `100%` for "full"). Stage C-1 adds the
 * full → narrow → stub → off width continuum (`widthMode`, a single global
 * `$state`) plus a per-side presence-collapse (a side with no pending
 * annotation hides while the other stays on); animated tracks land in Stage D.
 *
 * Factory invoked ONCE in App.svelte's `<script>` scope, mirroring
 * `createLayoutModel` (./model.svelte.ts). Returns getters so consumers see
 * reactivity through the settings/layout stores underneath. NOT a module-level
 * singleton — the internal `$effect` (width-mode hysteresis) must run inside a
 * component effect root.
 */

import { untrack } from "svelte";
import { EDITOR_MEASURE_CH, type EditorMeasure } from "../hooks/useTandemSettings";

/**
 * The four margin-track density modes along the width continuum. The shrink
 * ladder is driven GLOBALLY by viewport width (`widthMode`); the model layers a
 * per-side presence-collapse to `off` on top (a side with no pending annotation
 * to render). Genuine per-side WIDTH divergence (different sizes per side) is
 * deferred to Stage E / #917 — see
 * docs/plans/2026-05-28-stage-c-cleave-locks.md §"Resolved forks" F1.
 */
export type MarginMode = "full" | "narrow" | "stub" | "off";

export interface MarginTrackGeometry {
  /** Bubble column width (px). */
  readonly column: number;
  /** Edge inset between the column and the stage's outer edge (px). */
  readonly inset: number;
  /** Leader-line gap zone between the text edge and the column's near edge (px). */
  readonly gap: number;
}

/**
 * Per-mode track geometry — the single source of truth for column widths.
 * `full` is the shipped 240/8/24 (Stage A+B). `off` is all-zero: the grid track
 * collapses and the `1fr` gutters reabsorb it (the per-side presence/visibility
 * collapse lands here). The `narrow` (160) and `stub` (28) column widths are
 * visual-taste ESTIMATES landed pending a dogfood pass (Bryan greenlit landing
 * with estimates, 2026-05-28). `t2` in `marginModeThresholds` is sensitive to
 * `narrow.column`; re-assert the band-gap test if these widths change.
 */
export const MARGIN_TRACK_GEOMETRY: Record<MarginMode, MarginTrackGeometry> = {
  full: { column: 240, inset: 8, gap: 24 },
  narrow: { column: 160, inset: 8, gap: 24 },
  stub: { column: 28, inset: 8, gap: 24 },
  off: { column: 0, inset: 0, gap: 0 },
};

/** Total horizontal width a margin track reserves for a mode's geometry. */
export function marginReservePx(geometry: MarginTrackGeometry): number {
  return geometry.column + geometry.inset + geometry.gap;
}

// Full-mode layout constants, derived from `MARGIN_TRACK_GEOMETRY.full` so the
// table above is the single source of truth (a future tweak to full-mode
// geometry flows to every consumer). MarginColumn now reads per-side geometry
// from the model's `leftGeometry`/`rightGeometry` getters, not these constants;
// `RESERVE_PER_SIDE_PX` is the full-mode grid track (used by the threshold math).
export const MARGIN_VIEW_COLUMN_WIDTH_PX = MARGIN_TRACK_GEOMETRY.full.column; // 240
export const MARGIN_VIEW_RESERVE_PER_SIDE_PX = marginReservePx(MARGIN_TRACK_GEOMETRY.full); // 272

// Below this readable content width the margin tracks step down (and ultimately
// auto-hide) rather than squeeze the editor into an unreadable strip. A
// hysteresis band keeps a viewport drag through a boundary from flickering the
// tracks at 60fps. Stage C-1 turns the single full↔off `narrowSticky` cliff
// into the full → narrow → stub → off ladder via `marginModeThresholds` /
// `nextMarginMode`; animated track widths are Stage D.
export const MIN_EDITOR_WIDTH_PX = 480;
export const MARGIN_VIEW_HYSTERESIS_PX = 32;

/**
 * Width below which FULL margins (both sides) stop fitting above the min-editor
 * floor — the legacy full↔off auto-hide threshold. Retained as the `t1`
 * boundary of `marginModeThresholds` (below it, non-docx steps to `narrow`
 * instead of off; docx keeps the off cliff). Pure for unit-testability.
 */
export function narrowThresholdPx(railsWidthPx: number): number {
  return 2 * MARGIN_VIEW_RESERVE_PER_SIDE_PX + railsWidthPx + MIN_EDITOR_WIDTH_PX;
}

/**
 * Hysteresis-debounced 2-way narrow flag transition. Retained as the reference
 * for the docx full↔off equivalence and as a regression anchor; the model now
 * drives the 4-way continuum through `nextMarginMode`. Sticky entry at
 * `< threshold`, sticky exit at `> threshold + hysteresis`; inside the deadband
 * the previous value holds. Pure for testability.
 */
export function nextNarrowSticky(
  prev: boolean,
  viewportWidth: number,
  thresholdPx: number,
  hysteresisPx: number,
): boolean {
  if (viewportWidth < thresholdPx) return true;
  if (viewportWidth > thresholdPx + hysteresisPx) return false;
  return prev;
}

export interface MarginModeThresholds {
  /** Min viewport width for `full` margins both sides — the legacy auto-hide
   *  threshold (`=== narrowThresholdPx`). Below it: step to `narrow`. */
  readonly t1: number;
  /** Min viewport width for `narrow` margins. Below it: step to `stub`. */
  readonly t2: number;
  /** Min viewport width for `stub` margins. Below it: `off`. */
  readonly t3: number;
}

/**
 * Width thresholds for the mode continuum, parameterized by open-rail width.
 * Each `tN` = both-sides reserve at that mode + open rails + the min-editor
 * floor; below `tN` the margins can't hold that mode without squeezing the
 * editor under `MIN_EDITOR_WIDTH_PX`, so they step down. `t1` delegates to the
 * preserved `narrowThresholdPx` (full-mode reserve), keeping the legacy
 * full↔off boundary intact. With the shipped estimates (rails 0): t1=1024,
 * t2=864, t3=600 — band gaps 160 / 264, both wider than the 32px hysteresis so
 * adjacent deadbands never overlap. Pure for unit-testability.
 */
export function marginModeThresholds(railsWidthPx: number): MarginModeThresholds {
  const floor = railsWidthPx + MIN_EDITOR_WIDTH_PX;
  return {
    t1: narrowThresholdPx(railsWidthPx),
    t2: 2 * marginReservePx(MARGIN_TRACK_GEOMETRY.narrow) + floor,
    t3: 2 * marginReservePx(MARGIN_TRACK_GEOMETRY.stub) + floor,
  };
}

const MODE_RANK: Record<MarginMode, number> = { off: 0, stub: 1, narrow: 2, full: 3 };

/**
 * Hysteresis-damped transition along the full → narrow → stub → off continuum.
 * Generalizes `nextNarrowSticky`'s sticky-band logic to four modes:
 *  - `shrink` = the WIDEST mode the raw thresholds permit at `w` (narrowing is
 *    immediate at `< tN`);
 *  - `widen`  = the widest mode permitted only after clearing `tN + hysteresis`
 *    (widening is sticky);
 *  - inside the deadband `[widen, shrink]` the previous mode holds.
 * Clamps on multi-band jumps in BOTH directions (a viewport snapped huge→tiny
 * lands at `off`, not one step down; tiny→huge lands at `full`). Pure for
 * testability.
 */
export function nextMarginMode(
  prev: MarginMode,
  viewportWidth: number,
  thresholds: MarginModeThresholds,
  hysteresisPx: number,
): MarginMode {
  const { t1, t2, t3 } = thresholds;
  const w = viewportWidth;
  const h = hysteresisPx;
  const shrink: MarginMode = w < t3 ? "off" : w < t2 ? "stub" : w < t1 ? "narrow" : "full";
  const widen: MarginMode =
    w > t1 + h ? "full" : w > t2 + h ? "narrow" : w > t3 + h ? "stub" : "off";
  // shrink rank >= widen rank always (widen uses higher thresholds), so the
  // deadband [widen, shrink] is well-formed.
  if (MODE_RANK[prev] > MODE_RANK[shrink]) return shrink; // too wide for width → clamp down
  if (MODE_RANK[prev] < MODE_RANK[widen]) return widen; // width cleared widen band → step up
  return prev; // inside the deadband
}

/**
 * Base (pre-presence) per-tab mode. docx clamps to the legacy `full | off`
 * cliff keyed on whether the width permits full margins (`widthMode === "full"`,
 * which flips at the same `narrowThresholdPx` boundary the old `narrowSticky`
 * used — so docx never receives narrow/stub geometry). non-docx passes the
 * width continuum through. Pure for unit-testability.
 */
export function resolveBaseMode(
  isDocx: boolean,
  marginOn: boolean,
  widthMode: MarginMode,
): MarginMode {
  if (isDocx) return marginOn && widthMode === "full" ? "full" : "off";
  return marginOn ? widthMode : "off";
}

/**
 * Per-side mode after presence-collapse: a non-docx side with no pending
 * annotation to render collapses to `off` while the other keeps `baseMode`.
 * docx is exempt (legacy both-sides-together). Pure for unit-testability —
 * presence is a stable binary input, never derived from the track width it
 * produces, so this never closes a feedback loop. See cleave-locks F1 amendment.
 */
export function resolveSideMode(
  baseMode: MarginMode,
  isDocx: boolean,
  hasPending: boolean,
): MarginMode {
  return !isDocx && !hasPending ? "off" : baseMode;
}

export interface StageLayerStyleInput {
  /** The grid stage is non-docx only; docx keeps its own (relative/contents) path. */
  isDocx: boolean;
  /** docx branch only: margins on (→ `position: relative`) vs off
   *  (→ `display: contents`). */
  effectivelyOn: boolean;
  /** non-docx left grid-track width (px) = the left side's mode geometry total
   *  (`marginReservePx`); 0 when that side is `off` (hidden or empty-collapsed). */
  leftReservePx: number;
  /** non-docx right grid-track width (px). See `leftReservePx`. */
  rightReservePx: number;
  /** Content reading measure as a CSS length: a ch width (`58ch`/`68ch`/`82ch`)
   *  or `"100%"` for the "full" preset, mapped via `EDITOR_MEASURE_CH`. */
  measure: string;
}

/**
 * Inline style for the `marginLayerEl` stage container — format-aware.
 *
 * - docx: today's behavior. `position: relative` (so margin siblings can
 *   absolutely position against the layer) when on, else `display: contents`.
 * - non-docx: a CSS Grid. The grid is present even with margins off (tracks
 *   collapse to 0), so toggling margins is a track-width change rather than a
 *   display-mode swap — content centering stays put and track widths become
 *   animatable (Stage D). Each track's width is its side's `marginReservePx`,
 *   so a `narrow`/`stub`/empty-collapsed side renders the right (or zero) width.
 *
 * INVARIANT: the stage carries NO padding/border. `useMarginPositions` reads
 * `layer.getBoundingClientRect().top` (border-box top) as the bubble origin;
 * any padding-/border-top would push the grid row below that origin and offset
 * every bubble by that amount. Keep spacing on `.editor-scroll` (the parent),
 * never here. The `.margin-track` cells carry the same no-padding/border rule.
 *
 * Pure (no runes) so it can be unit-tested across the format × geometry matrix.
 */
export function stageLayerStyle(input: StageLayerStyleInput): string {
  if (input.isDocx) {
    return input.effectivelyOn ? "position: relative;" : "display: contents;";
  }
  return (
    `--editor-measure: ${input.measure}; ` +
    `--margin-left-track: ${input.leftReservePx}px; ` +
    `--margin-right-track: ${input.rightReservePx}px; ` +
    "display: grid; align-items: stretch; " +
    "grid-template-columns: minmax(0, 1fr) var(--margin-left-track) " +
    "minmax(0, var(--editor-measure)) var(--margin-right-track) minmax(0, 1fr);"
  );
}

export interface CreateEditorStageModelOpts {
  /** Active document format; the grid stage is non-docx only. */
  getFormat: () => string | undefined;
  /** `settings.marginView` — the user's on/off intent. */
  getMarginView: () => boolean;
  /** `settings.editorMeasure` — the reading-measure preset (→ ch width / `100%`). */
  getEditorMeasure: () => EditorMeasure;
  /** Rail visibility per side. Feeds the mode-threshold width budget only
   *  (open rails shrink the editor); since #892 it no longer hides the margin
   *  on that side. */
  getLeftRailVisible: () => boolean;
  getRightRailVisible: () => boolean;
  /** Live viewport width (drives the mode continuum thresholds). */
  getViewportWidth: () => number;
  /** Whether the LEFT margin side (private notes) has any PENDING annotation to
   *  render. Drives presence-collapse: an empty side's track goes to `off`.
   *  MUST read the UNGATED annotation source (e.g. `visibleAnnotations`),
   *  applying the same type/author split + `status === "pending"` predicate the
   *  column renders — NEVER the `effectivelyOn`-gated render arrays, which would
   *  close a `$derived` cycle through `effectivelyOn`. Excludes the column's
   *  `positions.has` gate (also `effectivelyOn`-gated). See stage-c1 plan
   *  [MF-11]. */
  getLeftHasPending: () => boolean;
  /** Whether the RIGHT margin side (outbound comments + imports) has any PENDING
   *  annotation to render. See `getLeftHasPending`. */
  getRightHasPending: () => boolean;
  /** Persisted-at-mount rail widths (stable; NOT the live drag width — see #683). */
  leftRailWidthPx: number;
  rightRailWidthPx: number;
}

export interface EditorStageModel {
  /** Some margin renders (either side on). docx: `marginView && fits-full`. */
  readonly effectivelyOn: boolean;
  /** A margin renders on the left (`leftMode !== "off"`). */
  readonly leftVisible: boolean;
  /** A margin renders on the right (`rightMode !== "off"`). */
  readonly rightVisible: boolean;
  /** Resolved LEFT-side mode (width continuum, presence- and format-clamped).
   *  `off` when hidden or empty-collapsed. */
  readonly leftMode: MarginMode;
  /** Resolved RIGHT-side mode. See `leftMode`. */
  readonly rightMode: MarginMode;
  /** Track geometry for the LEFT side = `MARGIN_TRACK_GEOMETRY[leftMode]`. */
  readonly leftGeometry: MarginTrackGeometry;
  /** Track geometry for the RIGHT side. */
  readonly rightGeometry: MarginTrackGeometry;
  /** Format-aware inline style for the `marginLayerEl` stage container. */
  readonly layerStyle: string;
}

export function createEditorStageModel(opts: CreateEditorStageModelOpts): EditorStageModel {
  const railsWidthPx = $derived(
    (opts.getLeftRailVisible() ? opts.leftRailWidthPx : 0) +
      (opts.getRightRailVisible() ? opts.rightRailWidthPx : 0),
  );
  const thresholds = $derived(marginModeThresholds(railsWidthPx));

  // Global width-driven mode. Like the old `narrowSticky`, the hysteresis read
  // needs the prior value, so this is `$state` written from a SINGLE guarded
  // `$effect` keyed on width — NOT a pure `$derived`. A one-way
  // rail→width→mode flow that never writes back to rail/settings state (the
  // narrow-collapse must not clobber the user's persisted panel visibility).
  // This is the ONLY loop-prone part of the model (cleave-locks F2: one
  // `$state`, one `$effect`); the per-side modes below are pure `$derived`.
  let widthMode = $state<MarginMode>("full");
  $effect(() => {
    const w = opts.getViewportWidth();
    const t = thresholds;
    // Read the prior value via `untrack` so `widthMode` is NOT a tracked
    // dependency of this effect; otherwise the write below would re-trigger it.
    // Tracked deps stay exactly {viewport width, thresholds}.
    const prev = untrack(() => widthMode);
    const next = nextMarginMode(prev, w, t, MARGIN_VIEW_HYSTERESIS_PX);
    // Literal last-value guard (`feedback_svelte_effect_depth_guard`): without
    // it the write re-enters under ResizeObserver chatter even though the value
    // has settled, tripping `effect_update_depth_exceeded`.
    if (next === prev) return;
    widthMode = next;
  });

  const isDocx = $derived(opts.getFormat() === "docx");

  // docx keeps the legacy full↔off cliff; non-docx gets the width continuum.
  const baseMode = $derived(resolveBaseMode(isDocx, opts.getMarginView(), widthMode));

  // Presence-collapse (non-docx only; cleave-locks F1 amendment, Bryan
  // 2026-05-28): a side with no pending annotation to render collapses to `off`
  // while the other keeps `baseMode`. Pure `$derived` over the helper — presence
  // is a stable binary input (it cannot be changed by the track width it
  // produces), so no feedback loop and no hysteresis. CONSEQUENCE: the per-side
  // getters NO LONGER satisfy `leftVisible === rightVisible` — that A/B-era
  // invariant is retired here. Genuine per-side WIDTH divergence stays deferred
  // to Stage E / #917.
  const leftMode = $derived(resolveSideMode(baseMode, isDocx, opts.getLeftHasPending()));
  const rightMode = $derived(resolveSideMode(baseMode, isDocx, opts.getRightHasPending()));

  const leftVisible = $derived(leftMode !== "off");
  const rightVisible = $derived(rightMode !== "off");
  const effectivelyOn = $derived(leftVisible || rightVisible);
  const leftGeometry = $derived(MARGIN_TRACK_GEOMETRY[leftMode]);
  const rightGeometry = $derived(MARGIN_TRACK_GEOMETRY[rightMode]);

  // Per-session breadcrumb set: each bogus value warns once, not per-frame.
  // The lookup runs inside a `$derived` that re-evaluates on viewport / rail
  // / settings changes; a hot-path warn loop would drown other signals.
  const warnedMeasures = new Set<string>();
  const layerStyle = $derived(
    stageLayerStyle({
      isDocx,
      effectivelyOn,
      leftReservePx: marginReservePx(leftGeometry),
      rightReservePx: marginReservePx(rightGeometry),
      // Belt-and-suspenders fallback. The on-load + on-write validators in
      // useTandemSettings already coerce a bogus value to DEFAULTS, so this
      // `??` only triggers if a TS-violating cast slips one through. Without
      // the fallback the grid track would render `--editor-measure: undefined`
      // — invalid CSS the browser silently ignores, producing a broken layout
      // with no console signal. The warn below is the tripwire: reaching here
      // means an `as EditorMeasure` cast bypassed both validators, which is a
      // real bug worth flagging, not silently patching over.
      measure: (() => {
        const m = opts.getEditorMeasure();
        const ch = EDITOR_MEASURE_CH[m];
        if (ch === undefined && !warnedMeasures.has(m as string)) {
          warnedMeasures.add(m as string);
          console.warn(
            `[tandem] editorMeasure=${JSON.stringify(m)} not in EDITOR_MEASURE_CH; falling back to comfortable. Both useTandemSettings validators should have coerced this upstream — a TS-violating cast slipped past them.`,
          );
        }
        return ch ?? EDITOR_MEASURE_CH.comfortable;
      })(),
    }),
  );

  return {
    get effectivelyOn() {
      return effectivelyOn;
    },
    get leftVisible() {
      return leftVisible;
    },
    get rightVisible() {
      return rightVisible;
    },
    get leftMode() {
      return leftMode;
    },
    get rightMode() {
      return rightMode;
    },
    get leftGeometry() {
      return leftGeometry;
    },
    get rightGeometry() {
      return rightGeometry;
    },
    get layerStyle() {
      return layerStyle;
    },
  };
}
