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
 * preset (ch widths, or `100%` for "full"); the narrow → stub continuum +
 * animated tracks land in Stages C/D.
 *
 * Factory invoked ONCE in App.svelte's `<script>` scope, mirroring
 * `createLayoutModel` (./model.svelte.ts). Returns getters so consumers see
 * reactivity through the settings/layout stores underneath. NOT a module-level
 * singleton — the internal `$effect` (narrow hysteresis) must run inside a
 * component effect root.
 */

import { untrack } from "svelte";
import { EDITOR_MEASURE_CH, type EditorMeasure } from "../hooks/useTandemSettings";

// Margin-view layout constants. A margin track reserves a fixed-width bubble
// column (COLUMN_WIDTH) + an edge inset (EDGE_INSET — breathing room against
// the stage's outer edge) + a gap (GAP — the zone where leader lines connect
// anchor text to bubbles). MarginColumn consumes all three via its
// width/edgeInset/gap props, so RESERVE_PER_SIDE_PX is exactly the grid track
// width that lets MarginColumn's existing absolute geometry land unchanged
// inside a `position: relative` cell.
export const MARGIN_VIEW_COLUMN_WIDTH_PX = 240;
export const MARGIN_VIEW_EDGE_INSET_PX = 8;
export const MARGIN_VIEW_GAP_PX = 24;
export const MARGIN_VIEW_RESERVE_PER_SIDE_PX =
  MARGIN_VIEW_COLUMN_WIDTH_PX + MARGIN_VIEW_EDGE_INSET_PX + MARGIN_VIEW_GAP_PX; // 272

// Below this readable content width the margin tracks auto-hide rather than
// squeeze the editor into an unreadable strip. A hysteresis band keeps a
// viewport drag through the threshold from flickering the tracks at 60fps.
// Stage A preserves the single-band full↔off behavior of the old `narrowSticky`
// flag; the full → narrow → stub → off continuum + re-quantified bands are
// Stage C.
export const MIN_EDITOR_WIDTH_PX = 480;
export const MARGIN_VIEW_HYSTERESIS_PX = 32;

/**
 * Width below which both margin tracks auto-hide. Reserves BOTH sides (worst
 * case) plus the open rails so the editor never drops under
 * `MIN_EDITOR_WIDTH_PX` with margins on. Pure for unit-testability.
 */
export function narrowThresholdPx(railsWidthPx: number): number {
  return 2 * MARGIN_VIEW_RESERVE_PER_SIDE_PX + railsWidthPx + MIN_EDITOR_WIDTH_PX;
}

/**
 * Hysteresis-debounced narrow flag transition. Sticky entry at `< threshold`,
 * sticky exit at `> threshold + hysteresis`; inside the deadband the previous
 * value holds. A plain `width < threshold` boundary flickers when a user drags
 * across it because each side re-evaluates every frame. Pure for testability.
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

export interface StageLayerStyleInput {
  /** The grid stage is non-docx only; docx keeps its own (relative/contents) path. */
  isDocx: boolean;
  /** marginView setting AND not auto-hidden by the narrow threshold. */
  effectivelyOn: boolean;
  /** A margin renders on the left (= effectivelyOn; rail-independent since #892). */
  leftVisible: boolean;
  /** A margin renders on the right (= effectivelyOn; rail-independent since #892). */
  rightVisible: boolean;
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
 *   animatable (Stage D).
 *
 * INVARIANT: the stage carries NO padding/border. `useMarginPositions` reads
 * `layer.getBoundingClientRect().top` (border-box top) as the bubble origin;
 * any padding-/border-top would push the grid row below that origin and offset
 * every bubble by that amount. Keep spacing on `.editor-scroll` (the parent),
 * never here. The `.margin-track` cells carry the same no-padding/border rule.
 *
 * Pure (no runes) so it can be unit-tested across the format × visibility
 * matrix — the cheapest way to lock the per-side-reserve fix.
 */
export function stageLayerStyle(input: StageLayerStyleInput): string {
  if (input.isDocx) {
    return input.effectivelyOn ? "position: relative;" : "display: contents;";
  }
  const ml = input.leftVisible ? `${MARGIN_VIEW_RESERVE_PER_SIDE_PX}px` : "0px";
  const mr = input.rightVisible ? `${MARGIN_VIEW_RESERVE_PER_SIDE_PX}px` : "0px";
  return (
    `--editor-measure: ${input.measure}; ` +
    `--margin-left-track: ${ml}; ` +
    `--margin-right-track: ${mr}; ` +
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
  /** Rail visibility per side. Feeds the narrow-threshold width budget only
   *  (open rails shrink the editor); since #892 it no longer hides the margin
   *  on that side. */
  getLeftRailVisible: () => boolean;
  getRightRailVisible: () => boolean;
  /** Live viewport width (drives the narrow auto-hide threshold). */
  getViewportWidth: () => number;
  /** Persisted-at-mount rail widths (stable; NOT the live drag width — see #683). */
  leftRailWidthPx: number;
  rightRailWidthPx: number;
}

export interface EditorStageModel {
  /** marginView on AND not auto-hidden by the narrow threshold. */
  readonly effectivelyOn: boolean;
  /** A margin renders on the left. Tracks `effectivelyOn` (decoupled from rail
   *  state since #892); kept per-side for Stage C + the docx path. */
  readonly leftVisible: boolean;
  /** A margin renders on the right. See `leftVisible`. */
  readonly rightVisible: boolean;
  /** Format-aware inline style for the `marginLayerEl` stage container. */
  readonly layerStyle: string;
}

export function createEditorStageModel(opts: CreateEditorStageModelOpts): EditorStageModel {
  const railsWidthPx = $derived(
    (opts.getLeftRailVisible() ? opts.leftRailWidthPx : 0) +
      (opts.getRightRailVisible() ? opts.rightRailWidthPx : 0),
  );
  const thresholdPx = $derived(narrowThresholdPx(railsWidthPx));

  // Auto-hide flag. The hysteresis read needs the prior value (deadband), so
  // this is `$state` written from a guarded `$effect` keyed on width — NOT a
  // pure `$derived`. A one-way rail→width→flag flow that never writes back to
  // rail/settings state (PR3 invariant: narrow-collapse must not clobber the
  // user's persisted panel visibility).
  let narrowSticky = $state(false);
  $effect(() => {
    const w = opts.getViewportWidth();
    const t = thresholdPx;
    // Read the prior value via `untrack` so `narrowSticky` is NOT a tracked
    // dependency of this effect; otherwise the write below would re-trigger
    // the effect (the deadband converges, but it's a wasted run). Tracked
    // deps stay exactly {viewport width, threshold}, matching the original
    // App.svelte hysteresis block.
    const prev = untrack(() => narrowSticky);
    narrowSticky = nextNarrowSticky(prev, w, t, MARGIN_VIEW_HYSTERESIS_PX);
  });

  const effectivelyOn = $derived(opts.getMarginView() && !narrowSticky);
  // Margin visibility is DECOUPLED from rail state (#892 discussion). A rail
  // opening no longer hides that side's margin: the old per-side coupling was a
  // geometric hack from the absolute-positioning layout, where an open rail
  // literally stole the horizontal space the margin needed. In the grid model
  // the `1fr` gutters + the narrow auto-hide threshold handle "is there room?"
  // — and the threshold already accounts for open-rail width (`railsWidthPx`),
  // so when a rail opens the margins hide globally IF space runs out, rather
  // than the (semantically arbitrary) "outline rail hides my private notes".
  // Both sides therefore track `effectivelyOn` together; the per-side split is
  // retained in the API/grid for Stage C + the docx path.
  // INVARIANT (Stages A/B): `leftVisible === rightVisible === effectivelyOn`.
  // The per-side getters are kept in the API surface because Stage C re-splits
  // them (full → narrow → stub → off can differ side-to-side based on
  // collision pressure). App.svelte must NOT assume they can diverge today —
  // any code that fans out behavior per side is premature; collapse it back to
  // `effectivelyOn` until Stage C lands the real split.
  const leftVisible = $derived(effectivelyOn);
  const rightVisible = $derived(effectivelyOn);

  // Per-session breadcrumb set: each bogus value warns once, not per-frame.
  // The lookup runs inside a `$derived` that re-evaluates on viewport / rail
  // / settings changes; a hot-path warn loop would drown other signals.
  const warnedMeasures = new Set<string>();
  const layerStyle = $derived(
    stageLayerStyle({
      isDocx: opts.getFormat() === "docx",
      effectivelyOn,
      leftVisible,
      rightVisible,
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
    get layerStyle() {
      return layerStyle;
    },
  };
}
