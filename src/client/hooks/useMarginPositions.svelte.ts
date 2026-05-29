import type { Editor as TiptapEditor } from "@tiptap/core";
import type * as Y from "yjs";
import type { Annotation } from "../../shared/types.js";
import { annotationToPmRange } from "../positions.js";

export interface MarginPositions {
  /** Vertical offset in pixels from the positioning layer's top, keyed by annotation id. */
  readonly byId: ReadonlyMap<string, number>;
}

export interface CreateMarginPositionsOpts {
  getEditor: () => TiptapEditor | null;
  getYdoc: () => Y.Doc | null;
  getAnnotations: () => readonly Annotation[];
  getLayerEl: () => HTMLElement | null;
  /** When false, the composable parks itself: no listeners, no recompute. */
  getEnabled: () => boolean;
}

export interface ComputeResult {
  positions: Map<string, number>;
  /** Annotations whose range resolved (i.e. we tried to read coords). */
  attempted: number;
  /** Of those attempted, how many threw from coordsAtPos. */
  thrown: number;
}

/**
 * Pure helper: compute per-annotation top offsets relative to a layer.
 *
 * Extracted from `createMarginPositions` so the loop body is unit-testable
 * without a live Tiptap view or Svelte effect root.
 *
 * - Annotations whose range fails to resolve are silently skipped (not counted
 *   as attempted — they're not anchor-staleness signals).
 * - `coordsAtPos` throws on stale/mid-transaction positions → counted as
 *   `thrown` so the caller can detect systemic failure (e.g. detached view).
 * - Non-finite `coords.top` (NaN/Infinity from degenerate layout, e.g.
 *   `display: none` ancestor) is skipped — it would render as `top: NaNpx`
 *   and defeat the `mapsEqual` tolerance check (NaN-vs-anything is always
 *   "unequal", causing per-frame re-render storms).
 *
 * `getLayerTop` is read per iteration (not once before the loop) so the layer
 * rect and each annotation's `coordsAtPos` read always observe the same layout.
 * Today this is defensive, not load-bearing: the loop is synchronous (JS
 * run-to-completion) and `coordsAtPos` is a read-only call (it may force a
 * layout reflow, but writes nothing), so nothing invalidates layout mid-loop
 * and a read-once `layerTop` would be identical. The per-call read future-proofs
 * the invariant against a DOM write ever being introduced *between* iterations
 * (it does not guard a write placed before `coordsAtPos` within one iteration),
 * and makes the read-consistency contract explicit.
 */
export function _computeNextPositionsForTesting(
  annotations: readonly Annotation[],
  resolveRange: (ann: Annotation) => { from: number; to: number } | null,
  coordsAtPos: (pos: number) => { top: number },
  getLayerTop: () => number,
): ComputeResult {
  const positions = new Map<string, number>();
  let attempted = 0;
  let thrown = 0;
  for (const ann of annotations) {
    const range = resolveRange(ann);
    if (!range) continue;
    attempted++;
    try {
      const coords = coordsAtPos(range.from);
      if (!Number.isFinite(coords.top)) continue;
      positions.set(ann.id, coords.top - getLayerTop());
    } catch {
      thrown++;
    }
  }
  return { positions, attempted, thrown };
}

export interface Scheduler {
  schedule: () => void;
  cancel: () => void;
}

/**
 * rAF-throttled callback runner. One pending frame at a time; `cancel`
 * aborts the pending frame without running the callback.
 *
 * Extracted for unit-testability — `vi.useFakeTimers({ toFake:
 * ['requestAnimationFrame', 'cancelAnimationFrame'] })` can drive it.
 */
export function createScheduler(fn: () => void): Scheduler {
  let rafId: number | null = null;
  return {
    schedule(): void {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        fn();
      });
    },
    cancel(): void {
      if (rafId === null) return;
      cancelAnimationFrame(rafId);
      rafId = null;
    },
  };
}

/**
 * Computes vertical offsets for margin-view annotation bubbles.
 *
 * Each offset is the bubble's `top` relative to a positioning layer that wraps
 * the editor. Because the layer scrolls together with the editor content,
 * scroll position is NOT a recompute trigger — only doc transactions and
 * layout reflows are.
 *
 * Failure modes handled:
 *   - `coordsAtPos` throws on positions inside deleted/mid-transaction nodes →
 *     that annotation is skipped for the frame, others still render.
 *   - 100% of attempted anchors throwing → systemic (detached view, post-reload
 *     Y.Doc swap); emit a single warn per recompute.
 *   - Non-finite coords → skipped before the mapsEqual tolerance can be
 *     defeated by NaN comparisons.
 *   - Effect depth: the last-value guard (`mapsEqual`) prevents floating-point
 *     jitter from re-triggering `$effect`s downstream.
 */
export function createMarginPositions(opts: CreateMarginPositionsOpts): MarginPositions {
  let byId = $state<Map<string, number>>(new Map());

  function recompute(): void {
    if (!opts.getEnabled()) {
      if (byId.size > 0) byId = new Map();
      return;
    }
    const editor = opts.getEditor();
    const layer = opts.getLayerEl();
    const ydoc = opts.getYdoc();
    if (!editor || !layer || !ydoc) {
      if (byId.size > 0) byId = new Map();
      return;
    }

    const annotations = opts.getAnnotations();
    const { positions, attempted, thrown } = _computeNextPositionsForTesting(
      annotations,
      (ann) => annotationToPmRange(ann, editor.state.doc, ydoc),
      (pos) => editor.view.coordsAtPos(pos),
      () => layer.getBoundingClientRect().top,
    );

    if (attempted > 0 && thrown === attempted) {
      console.warn(
        `[margin] coordsAtPos threw for all ${attempted} annotations — view may be detached`,
      );
    }

    if (mapsEqual(byId, positions)) return;
    byId = positions;
  }

  const scheduler = createScheduler(recompute);

  // Wire/teardown listeners when editor or layer becomes available (or disabled flips).
  $effect(() => {
    if (!opts.getEnabled()) return;
    const editor = opts.getEditor();
    const layer = opts.getLayerEl();
    if (!editor || !layer) return;

    const onTx = (): void => scheduler.schedule();
    editor.on("transaction", onTx);

    const ro = new ResizeObserver(() => scheduler.schedule());
    ro.observe(layer);

    scheduler.schedule();

    return () => {
      editor.off("transaction", onTx);
      ro.disconnect();
      scheduler.cancel();
    };
  });

  // Recompute when the annotation set changes (additions, deletions, edits).
  $effect(() => {
    void opts.getAnnotations();
    scheduler.schedule();
  });

  return {
    get byId() {
      return byId;
    },
  };
}

/**
 * Equal within a 0.5px tolerance. Subpixel jitter from layout reflow should
 * NOT trigger downstream re-renders.
 *
 * Exported for unit testing only.
 */
export function _mapsEqualForTesting(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): boolean {
  return mapsEqual(a, b);
}

function mapsEqual(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (bv === undefined || Math.abs(bv - v) > 0.5) return false;
  }
  return true;
}
