import type { TransitionConfig } from "svelte/transition";
import { measureTabFloor } from "../tabs/tab-floor.js";

/**
 * Rail + chrome motion (Phase 4 / #798). Custom Svelte transitions for the
 * annotation list (`cardEnter`/`cardExit` — A4/A1/A10), the rail toolbars
 * (`barIn`/`barOut` — A24/A25), and the tab strip (`tabExit` — s3). Each measures
 * the element's real border-box size on the relevant axis at transition start, so
 * siblings reflow continuously as it grows in / collapses out — no `animate:flip`
 * and no magic `max-height`/`max-width` that would clip a tall/wide element.
 *
 * The easing matches the `--tandem-ease-out` token exactly
 * (`cubic-bezier(0.2, 0.8, 0.2, 1)`) via the solver below, so JS-driven motion
 * reads identically to the CSS-driven motion in the rest of the re-skin.
 */

type ExitMode = "accept" | "dismiss";

interface CardEnterParams {
  /** Only the pending list opts in; resolved/margin cards pass false → no-op. */
  enabled?: boolean;
  /** App `reduceMotion` setting; OR-ed with the OS `prefers-reduced-motion`. */
  reduceMotion?: boolean;
}

interface CardExitParams extends CardEnterParams {
  /** Annotation id — the key into `modes`. */
  id: string;
  /**
   * Exit-direction ledger owned by SidePanel. Read *and cleared* here (inside
   * the outro, at execution time) so the value is fresh even if Svelte captured
   * the param while the card was still "pending", and so the Map never grows
   * unbounded or leaves a stale stamp behind after an undo.
   */
  modes?: Map<string, ExitMode>;
}

/** cubic-bezier(x1,y1,x2,y2) → easing fn, matching the CSS timing function. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = (x: number) => {
    // Newton-Raphson, then bisection fallback for flat-derivative regions.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) return t;
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 20; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) break;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveX(t));
  };
}

/**
 * Exact `--tandem-ease-out`. Exported because `animate:flip` needs an easing
 * FUNCTION — a CSS `cubic-bezier(...)` string throws inside its apply() — and
 * without it the tab-strip FLIP silently runs on Svelte's `cubicOut` default
 * instead of the Tandem curve.
 */
export const easeOut = cubicBezier(0.2, 0.8, 0.2, 1);
/** Exact `--tandem-ease-standard` — the snappier exit curve for chrome bars. */
const easeStandard = cubicBezier(0.4, 0, 0.2, 1);
/**
 * A14 `rowOut` only. Deliberately NOT a `--tandem-ease-*` token: an ease-in curve
 * (accelerates away, never settles) has no CSS consumer in the app, so adding it
 * to `index.html`'s `:root` would ship a permanently dead custom property into the
 * one block whose comment enumerates the curves and what each is for. The two
 * tokens don't fit here — `easeOut` settles and `easeStandard` decelerates at the
 * end, both of which read as "arriving" on a row that is leaving.
 */
const easeIn = cubicBezier(0.4, 0, 1, 1);

const ENTER_MS = 260;
const EXIT_MS = 260;

/** A24 batch / A25 bulk toolbar enter; exit ms is per-bar (200 batch / 180 bulk). */
const BAR_ENTER_MS = 280;

export function motionOff(reduceMotion?: boolean): boolean {
  if (reduceMotion) return true;
  // JS transitions escape the CSS `@media (prefers-reduced-motion)` / the
  // `body.tandem-reduce-motion` class, so check the OS preference here too.
  return (
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function geometry(node: HTMLElement): { h: number; mb: number } {
  return {
    h: node.offsetHeight,
    mb: Number.parseFloat(getComputedStyle(node).marginBottom) || 0,
  };
}

/** A4 — new pending card slots in: height 0→h, fade up. */
export function cardEnter(
  node: HTMLElement,
  { enabled, reduceMotion }: CardEnterParams,
): TransitionConfig {
  if (!enabled || motionOff(reduceMotion)) return { duration: 0 };
  const { h, mb } = geometry(node);
  return {
    duration: ENTER_MS,
    easing: easeOut,
    // t: 0→1 (present), u = 1−t.
    css: (t, u) =>
      `opacity:${t}; transform:translateY(${-6 * u}px); height:${t * h}px; margin-bottom:${t * mb}px; overflow:clip; box-sizing:border-box;`,
  };
}

/**
 * A1/A10 — pending card leaves the list. Direction is read from `modes`:
 *   accept  → settles up (translateY −)         [absorbed]
 *   dismiss → slides right + scales down         [discarded]
 *   neither → neutral fade (e.g. filtered out)   [not a resolution]
 * All three collapse height→0 so the siblings below glide up to fill.
 */
export function cardExit(
  node: HTMLElement,
  { enabled, reduceMotion, id, modes }: CardExitParams,
): TransitionConfig {
  const mode = modes?.get(id);
  modes?.delete(id);
  if (!enabled || motionOff(reduceMotion)) return { duration: 0 };
  const { h, mb } = geometry(node);
  const transform = (u: number) => {
    if (mode === "accept") return `translateY(${-8 * u}px)`;
    if (mode === "dismiss") return `translateX(${40 * u}px) scale(${1 - 0.04 * u})`;
    return "none";
  };
  return {
    duration: EXIT_MS,
    easing: easeOut,
    // t: 1→0 (collapsing), u = 1−t.
    css: (t, u) =>
      `opacity:${t}; height:${t * h}px; margin-bottom:${t * mb}px; transform:${transform(u)}; overflow:clip; box-sizing:border-box;`,
  };
}

interface BarInParams {
  /** App `reduceMotion` setting; OR-ed with the OS `prefers-reduced-motion`. */
  reduceMotion?: boolean;
}
interface BarOutParams extends BarInParams {
  /** Exit duration: 200ms for the batch-promote bar, 180ms (snappier) for bulk. */
  exitMs?: number;
}

/**
 * A24 / A25 — chrome toolbar (batch-promote bar, bulk-actions bar) enters as it
 * mounts: slides down into place from `-8px` + fades + grows its height so the
 * annotation list below reflows continuously instead of snapping (the height
 * measure mirrors `cardEnter`; BulkActions is not sticky, so the snap would
 * otherwise be visible). Used as a Svelte `in:` directive on the bar's `{#if}`
 * root, so it runs exactly once on appearance and never re-fires on the bar's
 * other re-renders (count/label changes) — the persistent-identity form of the
 * canon's "class-toggled transition, never a re-firing animation".
 */
export function barIn(node: HTMLElement, { reduceMotion }: BarInParams): TransitionConfig {
  if (motionOff(reduceMotion)) return { duration: 0 };
  const { h, mb } = geometry(node);
  return {
    duration: BAR_ENTER_MS,
    easing: easeOut,
    // t: 0→1 (present), u = 1−t.
    css: (t, u) =>
      `opacity:${t}; transform:translateY(${-8 * u}px); height:${t * h}px; margin-bottom:${t * mb}px; overflow:clip; box-sizing:border-box;`,
  };
}

/** A24 / A25 — the bar slides up + fades + collapses height on the snappier
 * `--tandem-ease-standard` curve when its data clears (`out:` directive). */
export function barOut(
  node: HTMLElement,
  { reduceMotion, exitMs = 200 }: BarOutParams,
): TransitionConfig {
  if (motionOff(reduceMotion)) return { duration: 0 };
  const { h, mb } = geometry(node);
  return {
    duration: exitMs,
    easing: easeStandard,
    // t: 1→0 (collapsing), u = 1−t.
    css: (t, u) =>
      `opacity:${t}; transform:translateY(${-8 * u}px); height:${t * h}px; margin-bottom:${t * mb}px; overflow:clip; box-sizing:border-box;`,
  };
}

/**
 * A27 — annotation fly-to-margin (#798). When the user submits a new annotation
 * from the selection popover, the new margin card launches from the closing
 * popover's on-screen footprint and glides into its slot (a FLIP).
 *
 * Producer (Toolbar's submit handlers) and consumer (MarginColumn's bubble
 * `in:` transition) share no prop path, so the popover's source rect crosses to
 * the transition through this module-level singleton ledger. It mirrors the
 * `exitModes` *delete-on-read discipline* (read + clear inside the transition so
 * the value is fresh and never accumulates), but NOT its scope — `exitModes` is
 * a component-instance Map threaded as a prop; this must be module-level because
 * there is no shared channel between the two components. It is deliberately a
 * plain Map, not `$state`: a cross-component reactive write would be an
 * effect-graph hazard, and nothing needs to re-render when it changes.
 */
const flySources = new Map<string, DOMRect>();

const FLY_MS = 480;
/**
 * Backstop so a registered-but-never-consumed source can't strand: if the card
 * never mounts (margins off, annotation instantly filtered) its source is GC'd.
 * The transition's delete-on-read makes this a no-op on the happy path. If a
 * mount is so slow it exceeds this window the card simply snaps instead of
 * flying — graceful degradation, never a leak or a broken card.
 */
const FLY_SOURCE_TTL_MS = 1000;

/** Stash the popover's footprint for the just-submitted annotation id. */
export function registerFlySource(id: string, rect: DOMRect): void {
  flySources.set(id, rect);
  setTimeout(() => flySources.delete(id), FLY_SOURCE_TTL_MS);
}

interface FlyToMarginParams {
  /** Annotation id — the key into `flySources`. */
  id: string;
  /** App `reduceMotion` setting; OR-ed with the OS `prefers-reduced-motion`. */
  reduceMotion?: boolean;
}

/**
 * A27 — `in:` transition on the `margin-bubble-{id}` wrapper. Translates the
 * card FROM the captured popover footprint TO its resolved slot (identity) +
 * fades in. **Map-presence IS the gate:** only a submit registers a source, so
 * every other mount (initial load, tab switch, scroll/filter re-render) finds no
 * source and no-ops — the just-submitted card is the only one that flies. The
 * source is consumed (deleted) BEFORE the reduced-motion gate so it can never
 * strand. Translate-only (no scale): a full-rect scale would blur the card's
 * text for the duration; the dominant motion is the translate anyway.
 */
export function cardFlyToMargin(
  node: HTMLElement,
  { id, reduceMotion }: FlyToMarginParams,
): TransitionConfig {
  const source = flySources.get(id);
  flySources.delete(id);
  if (!source || motionOff(reduceMotion)) return { duration: 0 };
  const dest = node.getBoundingClientRect();
  const dx = source.left - dest.left;
  const dy = source.top - dest.top;
  return {
    duration: FLY_MS,
    easing: easeOut,
    // t: 0→1 (settled); u = 1−t. At u=1 the card sits over the popover
    // footprint; at t=1 it rests at identity in its slot.
    css: (t, u) => `transform:translate(${dx * u}px, ${dy * u}px); opacity:${0.2 + 0.8 * t};`,
  };
}

const TAB_EXIT_MS = 200;

/**
 * s3 — a closing tab collapses on the INLINE axis (width w→0) + fades, so the
 * adjacent tabs glide left to fill (`out:` directive on the `.tab-flip` wrapper
 * in DocumentTabs — NOT the TabItem pill inside it). The `min-width:0` is what
 * makes the collapse reach zero: `.tab-flip` carries the tab strip's width
 * floor (142px under `uniformTabWidth`, a smaller measured per-tab value
 * otherwise), and a transition can only style its own node, so hosting this on
 * the pill would leave the wrapper pinned at its floor and the neighbours would
 * jump. Svelte emits these as keyframes, which outrank the inline `min-width`
 * the adaptive pass writes — but only while that inline value is not
 * `!important`, which is why it never is. `overflow:clip` clips the name without becoming a focus-stealing
 * scroll box.
 * `pointer-events:none` makes the leaving node inert for its ~200ms in the DOM:
 * the id is already gone from `tabsState` (that removal is what fired this outro),
 * so a click on the collapsing tab would `setActiveTabId` a dead id → null active
 * tab → wiped editor; it also drops the node out of `elementFromPoint`, hardening
 * the drag-reorder drop-target path. Reduced motion → instant removal (motion.md:
 * "collapse immediately, no slide").
 */
export function tabExit(node: HTMLElement, { reduceMotion }: BarInParams): TransitionConfig {
  if (motionOff(reduceMotion)) return { duration: 0 };
  const w = node.offsetWidth;
  return {
    duration: TAB_EXIT_MS,
    easing: easeOut,
    // t: 1→0 (collapsing).
    css: (t) =>
      `opacity:${t}; width:${t * w}px; min-width:0; overflow:clip; box-sizing:border-box; pointer-events:none;`,
  };
}

const TAB_ENTER_MS = 220;

interface TabEnterParams extends BarInParams {
  /** `tandem:settings.uniformTabWidth`. Decides the enter target: the
   * CSS-pinned `TAB_FLOOR_PX` in uniform mode (where `node.offsetWidth` is
   * already correct — `.tab-flip.uniform` sets both `min-width` AND
   * `max-width`, so the wrapper is exactly that width the instant it's
   * inserted, independently of effect timing), or the measured adaptive
   * floor in adaptive mode (see below). */
  uniformTabWidth?: boolean;
}

/**
 * s3 (enter) — the mirror of `tabExit`: a newly-opened tab unrolls on the INLINE
 * axis (width 0→w) + fades in, so the adjacent tabs glide right to make room
 * instead of snapping (`in:` directive on the `.tab-flip` wrapper, for the
 * reason spelled out in `tabExit`). A touch longer than the 200ms exit (220ms)
 * so the unroll reads as settling in rather than snapping shut. `min-width:0`
 * clears that wrapper's width floor so the unroll starts from 0. Svelte skips intros on the
 * initial render, so existing tabs don't all animate on app load — only a tab
 * opened after mount unrolls. Reduced motion → instant.
 *
 * TARGET WIDTH, adaptive mode (`uniformTabWidth: false`): Svelte's transition
 * SETUP runs during the render/DOM-patch pass — strictly BEFORE `$effect`s
 * flush. DocumentTabs' adaptive-floor `$effect` (which writes each wrapper's
 * measured `min-width`) hasn't run yet at this point, so `node.offsetWidth`
 * would read only the base `.tab-flip{min-width:142px}` CSS rule — the
 * un-floored width, not this tab's real (usually smaller) adaptive floor. A
 * short-named tab would then unroll 0→142px and SNAP to its real floor the
 * instant the effect runs moments later — the open-path twin of the close-path
 * bug already documented above tabExit ("collapsed 257→142 and then snapped to
 * 0"). Fix: compute the SAME floor `measureTabFloor` gives the effect,
 * synchronously, right here — the wrapper's DOM subtree (TabItem's pill + name
 * span) is already fully mounted by the time an `in:` transition's setup runs,
 * so the measurement is accurate even though the effect hasn't written it yet.
 */
export function tabEnter(
  node: HTMLElement,
  { reduceMotion, uniformTabWidth }: TabEnterParams,
): TransitionConfig {
  if (motionOff(reduceMotion)) return { duration: 0 };
  const w = uniformTabWidth ? node.offsetWidth : measureTabFloor(node);
  return {
    duration: TAB_ENTER_MS,
    easing: easeOut,
    // t: 0→1 (present).
    css: (t) =>
      `opacity:${t}; width:${t * w}px; min-width:0; overflow:clip; box-sizing:border-box;`,
  };
}

/** A28 popup-entrance duration. Exported so Toolbar's width-freeze window
 *  (`entering`) matches the transition exactly — no two-literals drift. */
export const ENTER_POPUP_MS = 440;

/**
 * A28 — the selection popup's entrance (#798). A fresh `{#if}` mount, so a real
 * Svelte `in:` transition (unlike A26's class-toggle morph). CURSOR-ORIGIN UNROLL
 * (Bryan, 2026-06-03): the popup is left-anchored at the cursor and its
 * cursor-side corner is pinned by the scoped style — `left` always, plus `top`
 * (below placement) or `bottom` (above placement). Animating WIDTH and HEIGHT
 * from 0 therefore unrolls the box away from that corner: rightward in both
 * cases, and downward (below, top pinned) or upward (above, bottom pinned). No
 * `transform` here — the popup is no longer centered, so there's nothing to
 * preserve, and a transform would un-pin the corner. `overflow:clip` reveals the
 * pills as the box grows (animate width/height, never clip-path — clip-path would
 * cut the pill's shadow). The caller freezes width-feedback positioning during
 * the run (an `entering` flag gating the ResizeObserver) so the left-anchor clamp
 * can't jitter as the width grows. Reduced motion → instant.
 */
export function popupEnter(node: HTMLElement, { reduceMotion }: BarInParams): TransitionConfig {
  if (motionOff(reduceMotion)) return { duration: 0 };
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  return {
    duration: ENTER_POPUP_MS,
    easing: easeOut,
    // t: 0→1 (present). Corner is pinned by the scoped style's left + top/bottom;
    // growing width+height from 0 unrolls away from it. No transform.
    css: (t) =>
      `opacity:${t}; width:${t * w}px; height:${t * h}px; overflow:clip; box-sizing:border-box;`,
  };
}

const DISCLOSE_MS = 380;

/**
 * A13 — reply-thread disclosure unfold. A single `transition:` on the `{#if open}`
 * replies block (plays BOTH directions, since the morph is symmetric). Measures
 * the block's real border-box height at transition start (like `cardEnter`) so
 * the card grows in / collapses out continuously — no magic `max-height` to clip
 * a long thread. `overflow:clip` keeps the full-height inner thread from spilling
 * below the animating container while it grows (the per-reply cascade is a
 * separate CSS `@keyframes` on the freshly-mounted `.ct-reply` items). Reduced
 * motion → `{duration:0}`: the thread shows/hides instantly, no unfold.
 */
export function discloseUnfold(node: HTMLElement, { reduceMotion }: BarInParams): TransitionConfig {
  if (motionOff(reduceMotion)) return { duration: 0 };
  const { h, mb } = geometry(node);
  return {
    duration: DISCLOSE_MS,
    easing: easeOut,
    // t: 0→1 (present), shared by intro (open) and reversed outro (close).
    css: (t) =>
      `opacity:${t}; height:${t * h}px; margin-bottom:${t * mb}px; overflow:clip; box-sizing:border-box;`,
  };
}

const ROW_ENTER_MS = 240;
const ROW_EXIT_MS = 200;

/**
 * A14 — an activity row that arrives while the tray is ALREADY open (`in:` on the
 * keyed `{#each}` row in ActivityTray). Slides down from +10px while its height
 * unfolds from 0, so the rows below are pushed by the row's own growth rather than
 * by a separate layout jump.
 *
 * Deliberately ungated. Svelte skips a local intro while its nearest block
 * ancestor is initializing, so the rows that mount when the tray opens do NOT run
 * this — A23's `rowSlideUp` cascade owns that case. Only a row appended to an
 * already-rendered each block intros, which is exactly A14's trigger. This is why
 * `.tray-list` must NOT live in an `{:else}`: a branch swap re-creates the each
 * block, and the first event arriving into an open-but-empty tray would silently
 * lose its entrance.
 *
 * Height is measured, not a magic `max-height` — a `save-error` row carries a
 * Retry button plus a wrapping message and has no fixed height. Padding is NOT
 * animated: `.toast-row`'s padding is horizontal as well as vertical, so scaling
 * it would shrink the row's available inline width mid-flight, and text-wrapping
 * is a step function of width — the message would re-wrap partway through. The
 * vertical component is already accounted for by animating the border-box height.
 */
export function rowEnter(node: HTMLElement, { reduceMotion }: BarInParams): TransitionConfig {
  if (motionOff(reduceMotion)) return { duration: 0 };
  const { h, mb } = geometry(node);
  return {
    duration: ROW_ENTER_MS,
    easing: easeOut,
    // t: 0→1 (present), u = 1−t.
    css: (t, u) =>
      `opacity:${t}; transform:translateY(${10 * u}px); height:${t * h}px; margin-bottom:${t * mb}px; overflow:clip; box-sizing:border-box;`,
  };
}

/**
 * A14 — an activity row leaves (`out:`). Asymmetric to `rowEnter` on purpose:
 * horizontal for removal, vertical for arrival, so the two are never mistaken for
 * each other at a glance (the same convention `cardExit` uses for a dismissed
 * annotation). Collapses height + margin in the same transition so the gap closes
 * continuously instead of snapping when Svelte splices the node.
 *
 * Being LOCAL (no `|global`) is load-bearing, not an omission. It fires per removed
 * each-item — dismiss, clear-all, info-TTL expiry and cap eviction all take that
 * path — but NOT when an ancestor block is torn down, which is precisely what we
 * want on tray close: the rows should vanish with the collapsing panel, not swipe
 * sideways inside it.
 */
export function rowOut(node: HTMLElement, { reduceMotion }: BarInParams): TransitionConfig {
  if (motionOff(reduceMotion)) return { duration: 0 };
  const { h, mb } = geometry(node);
  return {
    duration: ROW_EXIT_MS,
    easing: easeIn,
    // t: 1→0 (collapsing), u = 1−t.
    css: (t, u) =>
      `opacity:${t}; transform:translateX(${8 * u}px); height:${t * h}px; margin-bottom:${t * mb}px; overflow:clip; box-sizing:border-box; pointer-events:none;`,
  };
}

const EMPTY_UNFOLD_MS = 220;
/** Lets the rows' 200ms `rowOut` finish before the empty state claims the space. */
const EMPTY_UNFOLD_DELAY_MS = ROW_EXIT_MS;

/**
 * A14 companion — the activity tray's empty state unfolding after the last row
 * leaves. Svelte mounts an incoming branch BEFORE outroing the outgoing one, so
 * without this "Nothing to report." (~80px of padding + two lines) pops in at full
 * height underneath rows that are still collapsing, growing the tray and then
 * snapping — the exact artifact this work exists to remove. Delaying past the row
 * exit and unfolding height (not just opacity) makes the panel settle once.
 *
 * Correctly does NOT run on the tray's first open with an empty list: its `{#if}`
 * block is initializing then, so the local intro is skipped and the empty state
 * simply is there.
 */
export function emptyUnfold(node: HTMLElement, { reduceMotion }: BarInParams): TransitionConfig {
  if (motionOff(reduceMotion)) return { duration: 0 };
  const { h } = geometry(node);
  return {
    duration: EMPTY_UNFOLD_MS,
    delay: EMPTY_UNFOLD_DELAY_MS,
    easing: easeOut,
    // t: 0→1 (present).
    css: (t) => `opacity:${t}; height:${t * h}px; overflow:clip; box-sizing:border-box;`,
  };
}
