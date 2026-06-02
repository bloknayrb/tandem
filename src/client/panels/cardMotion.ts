import type { TransitionConfig } from "svelte/transition";

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

/** Exact `--tandem-ease-out`. */
const easeOut = cubicBezier(0.2, 0.8, 0.2, 1);
/** Exact `--tandem-ease-standard` — the snappier exit curve for chrome bars. */
const easeStandard = cubicBezier(0.4, 0, 0.2, 1);

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

const TAB_EXIT_MS = 200;

/**
 * s3 — a closing tab collapses on the INLINE axis (width w→0) + fades, so the
 * adjacent tabs glide left to fill (`out:` directive on the TabItem root). The
 * `min-width:0` defeats the tab's content min-width (the name span's 80px floor),
 * which otherwise wins over an explicit `width` and would stop the collapse short;
 * `overflow:clip` clips the name without becoming a focus-stealing scroll box.
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

/** A28 popup-entrance duration. Exported so Toolbar's width-freeze window
 *  (`entering`) matches the transition exactly — no two-literals drift. */
export const ENTER_POPUP_MS = 360;

/**
 * A28 — the selection popup's entrance (#798). A fresh `{#if}` mount, so a real
 * Svelte `in:` transition (unlike A26's class-toggle morph): the popup unrolls
 * its measured natural WIDTH (the width-unroll deferred from M1) + fades + lifts
 * 6px, on `--tandem-ease-out`. `overflow:clip` hides the content while the box is
 * narrower than natural (animate width, never clip-path — clip-path would cut the
 * pill's shadow). The caller freezes width-feedback positioning during the run
 * (an `entering` flag gating the ResizeObserver) so the left-clamp can't jitter
 * as the width grows. **The popup is centered via `transform: translateX(-50%)`
 * in its scoped style; a transition `transform` REPLACES that, so we MUST
 * re-include `translateX(-50%)` here or the popup jumps right by half its width
 * during the entrance.** Reduced motion → instant (no width-unroll, no lift).
 */
export function popupEnter(node: HTMLElement, { reduceMotion }: BarInParams): TransitionConfig {
  if (motionOff(reduceMotion)) return { duration: 0 };
  const w = node.offsetWidth;
  return {
    duration: ENTER_POPUP_MS,
    easing: easeOut,
    // t: 0→1 (present), u = 1−t. translateX(-50%) preserves the centering.
    css: (t, u) =>
      `opacity:${t}; width:${t * w}px; transform:translateX(-50%) translateY(${-6 * u}px); overflow:clip; box-sizing:border-box;`,
  };
}
