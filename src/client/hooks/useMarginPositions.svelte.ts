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
 *   - Effect depth: the last-value guard (`mapsEqual`) prevents floating-point
 *     jitter from re-triggering `$effect`s downstream.
 */
export function createMarginPositions(opts: CreateMarginPositionsOpts): MarginPositions {
  let byId = $state<Map<string, number>>(new Map());
  let scheduled = false;

  function recompute(): void {
    scheduled = false;
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

    const layerTop = layer.getBoundingClientRect().top;
    const next = new Map<string, number>();
    for (const ann of opts.getAnnotations()) {
      const range = annotationToPmRange(ann, editor.state.doc, ydoc);
      if (!range) continue;
      try {
        const coords = editor.view.coordsAtPos(range.from);
        next.set(ann.id, coords.top - layerTop);
      } catch {
        // Stale or mid-transaction position — skip this annotation for now.
        // Next transaction or layout change will retry.
      }
    }

    if (mapsEqual(byId, next)) return;
    byId = next;
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(recompute);
  }

  // Wire/teardown listeners when editor or layer becomes available (or disabled flips).
  $effect(() => {
    if (!opts.getEnabled()) return;
    const editor = opts.getEditor();
    const layer = opts.getLayerEl();
    if (!editor || !layer) return;

    const onTx = (): void => schedule();
    editor.on("transaction", onTx);

    const ro = new ResizeObserver(() => schedule());
    ro.observe(layer);

    schedule();

    return () => {
      editor.off("transaction", onTx);
      ro.disconnect();
    };
  });

  // Recompute when the annotation set changes (additions, deletions, edits).
  $effect(() => {
    // Touch the annotations array so this effect tracks its identity.
    void opts.getAnnotations();
    schedule();
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
