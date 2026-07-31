/**
 * A30 "Tab reorder drag" — the pure geometry behind the lift/part/drop motion.
 *
 * No DOM, no Svelte, no measurement. Everything here reads a `TabStripSnapshot`
 * captured ONCE, when the gesture crosses its movement threshold.
 *
 * ## Why a snapshot rather than live hit-testing
 *
 * The shipped drag resolves its drop target with `document.elementFromPoint`.
 * That is incompatible with parting siblings: translating a neighbour aside
 * opens a void *exactly where the pointer is*, so the hit-test returns the
 * scroller, the target goes null, the siblings close back up — and re-open on
 * the next pixel (a shimmy). Worse, a pointer that comes to rest inside that
 * gap commits nothing on release. The escape condition is
 * `width(dragged) + gap <= width(neighbour) / 2`, which a 142px floor and
 * 150–260px tabs never satisfy, so it is the DEFAULT path, not an edge case.
 *
 * Midpoints taken from a snapshot don't move when the tabs do, which makes
 * parting idempotent and deletes the dead zone by construction.
 *
 * DocumentTabs keeps the `elementFromPoint` path behind one explicit "no usable
 * geometry" flag (degraded mode), which is also what lets the component suite
 * run under happy-dom, where there is no layout at all.
 */

import { applyReorder } from "../hooks/useTabOrder.js";

/** Layout of the tab strip at the instant the drag was recognised. */
export interface TabStripSnapshot {
  /** Rendered tab ids, left to right. Parallel to `lefts` / `widths`. */
  ids: string[];
  /** Viewport-relative left edge of each tab's `.tab-flip` wrapper. */
  lefts: number[];
  /** Border-box width of each wrapper. */
  widths: number[];
  /**
   * Inter-tab gap. Derived from the rects, NEVER `getComputedStyle` — happy-dom
   * resolves `.gap` to "6px" but leaves `.columnGap` empty, so a computed-style
   * read would silently produce a plausible number in an environment with no
   * layout (or `NaN`), and the degenerate guard would never fire.
   */
  gap: number;
}

export interface DropTarget {
  toId: string;
  side: "left" | "right";
}

/**
 * Gap between adjacent tabs, measured off the first pair. `flex-shrink: 1`
 * makes widths fractional but the gap is a fixed 6px, so one pair is enough.
 */
export function gapFromRects(lefts: number[], widths: number[]): number {
  if (lefts.length < 2) return 0;
  return Math.max(0, lefts[1] - (lefts[0] + widths[0]));
}

/**
 * Index the dragged tab would occupy in the FINAL order, given where the
 * pointer is now.
 *
 * The dragged tab's own midpoint is deliberately EXCLUDED. Including it would
 * make the trigger to swap with a neighbour "the pointer passed your own
 * midpoint" (~71px of travel at the compression floor) instead of "the pointer
 * passed the neighbour's midpoint" (~`w_self/2 + gap + w_neighbour/2`) — a
 * hair-trigger that fires before the tab has visibly reached anything.
 *
 * `pointerX` is in SNAPSHOT coordinates: viewport clientX plus however far the
 * strip has scrolled since capture (the snapshot's lefts are frozen viewport
 * values, the tabs underneath are not).
 */
export function slotIndexFor(snap: TabStripSnapshot, pointerX: number, draggedId: string): number {
  let slot = 0;
  for (let i = 0; i < snap.ids.length; i++) {
    if (snap.ids[i] === draggedId) continue;
    if (pointerX > snap.lefts[i] + snap.widths[i] / 2) slot++;
  }
  return slot;
}

/**
 * Map a slot index onto the `(toId, side)` pair the `reorder` prop takes.
 * Returns null when the slot is the one the dragged tab already occupies.
 *
 * This is the one place an inverse of `applyReorder` is unavoidable, so it is
 * pinned by a round-trip test rather than by reading: for every
 * `(ids, draggedId, slot)`, feeding this output through the REAL `applyReorder`
 * must land the dragged id at exactly `slot`.
 *
 * The returned `toId` can never be `draggedId` (it is drawn from `others`),
 * which matters more than it looks: `applyReorder` has no `fromId === toId`
 * guard of its own — that lives in the `useTabOrder` wrapper this path bypasses
 * — and `applyReorder(['a','b','c'], 'a', 'a', …, 'left')` silently returns
 * `['b','a','c']`. Hovering your own slot is the modal state of the gesture.
 */
export function slotToTarget(
  ids: string[],
  draggedId: string,
  slotIndex: number,
): DropTarget | null {
  const fromIdx = ids.indexOf(draggedId);
  if (fromIdx === -1) return null;
  const others = ids.filter((id) => id !== draggedId);
  const slot = Math.min(Math.max(slotIndex, 0), others.length);
  if (slot === fromIdx) return null;
  // Moving left: land immediately before whoever currently holds that slot.
  // Moving right: land immediately after whoever we displaced getting there.
  return slot < fromIdx
    ? { toId: others[slot], side: "left" }
    : { toId: others[slot - 1], side: "right" };
}

/**
 * How far each tab must translate, in snapshot order, for the strip to *look*
 * like `nextIds` while the DOM still says `snap.ids`.
 *
 * Derived by rebuilding the post-reorder layout from the snapshot: the first
 * slot doesn't move, and every later slot is the running sum of the widths
 * ahead of it. Reordering never changes a tab's own width (same set of tabs,
 * same container), so these are the exact lefts the browser will lay out on
 * commit — which is the whole point. `animate:flip` measures a sibling with its
 * transform still applied, gets `from === to`, and creates no animation at all;
 * the parting IS the settle, for free.
 *
 * `nextIds` must come from the real `applyReorder` over `snap.ids`, never from
 * a local re-implementation of it. A mirrored index function would run on a
 * different array than the one `applyReorder` mutates (`localOrder`, which can
 * diverge from the rendered `orderedTabs` by a `newIds` suffix whenever a tab
 * was opened but the sync effect hasn't flushed), open a gap for a drop that
 * then silently no-ops, and pass a unit test that shared one array between both.
 */
export function computeShift(snap: TabStripSnapshot, nextIds: string[]): number[] {
  const { ids, lefts, widths, gap } = snap;
  const noShift = ids.map(() => 0);
  if (nextIds.length !== ids.length || ids.length === 0) return noShift;

  const widthOf = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) widthOf.set(ids[i], widths[i]);

  const nextLeft = new Map<string, number>();
  let x = lefts[0];
  for (const id of nextIds) {
    const w = widthOf.get(id);
    if (w === undefined) return noShift; // nextIds isn't a permutation of ids
    nextLeft.set(id, x);
    x += w + gap;
  }
  return ids.map((id, i) => (nextLeft.get(id) as number) - lefts[i]);
}

/**
 * The full per-frame decision: where the pointer is → what the strip should
 * look like. `target` is what a release would commit; `shifts` is what the
 * siblings should be showing right now. Kept together so the two can never
 * disagree — the gap the user sees is computed from the same reorder that
 * `pointerup` will call.
 */
export function resolveDragFrame(
  snap: TabStripSnapshot,
  pointerX: number,
  draggedId: string,
): { slot: number; target: DropTarget | null; shifts: number[] } {
  const slot = slotIndexFor(snap, pointerX, draggedId);
  const target = slotToTarget(snap.ids, draggedId, slot);
  if (!target) return { slot, target: null, shifts: snap.ids.map(() => 0) };
  const nextIds = applyReorder(snap.ids, draggedId, target.toId, new Set(snap.ids), target.side);
  return { slot, target, shifts: computeShift(snap, nextIds) };
}
