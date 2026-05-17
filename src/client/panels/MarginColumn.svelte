<script lang="ts">
import { untrack } from "svelte";
import type { Annotation, AnnotationReply } from "../../shared/types";
import { getVisibleReplies } from "../annotations/replies";
import AnnotationCard from "./AnnotationCard.svelte";
import { prunePlaceableHeights, resolveCollisions } from "./marginCollision";

interface Props {
  /** Annotations destined for this side. Caller filters by type/author. */
  annotations: readonly Annotation[];
  /** Computed top offset in pixels (relative to the positioning layer), keyed by annotation id. */
  positions: ReadonlyMap<string, number>;
  side: "left" | "right";
  /** Column width in pixels. */
  width: number;
  /** Distance from the column edge to the nearest scroll-container edge. */
  edgeInset: number;
  /** Horizontal gap between the editor's text edge and the near edge of this
   *  column. Also defines the horizontal zone occupied by leader lines that
   *  visually connect anchor text in the editor to the corresponding bubble. */
  gap: number;
  activeAnnotationId: string | null;
  /** Raw replies grouped by annotation id. The component applies the
   *  `getVisibleReplies()` ADR-027 filter at the lookup site so notes /
   *  highlights never expose replies in the bubble. */
  repliesById: ReadonlyMap<string, AnnotationReply[]>;
  onClick: (annotation: Annotation) => void;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onRemove?: (id: string) => void;
  onEdit?: (id: string, content: string) => void;
  onReply?: (id: string, text: string) => Promise<boolean>;
  onSendToClaude?: (id: string) => void;
}

let {
  annotations,
  positions,
  side,
  width,
  edgeInset,
  gap,
  activeAnnotationId,
  repliesById,
  onClick,
  onAccept,
  onDismiss,
  onRemove,
  onEdit,
  onReply,
  onSendToClaude,
}: Props = $props();

// Vertical inset from the bubble's top edge to its padded content row. The
// leader line endpoint is shifted down by this amount so a collision-pushed
// bubble's connector lands near the title row rather than the empty corner.
const LEADER_BUBBLE_INSET_PX = 12;

// Only render annotations whose position is known this frame; without a top
// offset there is nowhere to place the bubble.
const placeable = $derived(
  annotations.filter((a) => positions.has(a.id) && a.status === "pending"),
);

// Measured bubble heights, keyed by annotation id. Reassigned to a fresh Map
// on each update so Svelte 5 $state notices the change (Map mutation is
// invisible to identity tracking). Heights feed `adjustedPositions` (a
// SEPARATE $derived layer from `positions`) so the collision sweep never
// writes back into the `useMarginPositions` $state — that would re-enter
// the layout effect and trip the effect-depth guard
// (`feedback_svelte_effect_depth_guard`).
let heights = $state<Map<string, number>>(new Map());

// Collision-resolved tops. Sweep input is built from `placeable` + `positions`
// + `heights`; the result is a brand-new Map. Reads from `positions` happen
// synchronously inside this $derived, so dependency tracking is automatic and
// we don't need `untrack` here.
const adjustedPositions = $derived.by(() => {
  const input = placeable.map((a) => ({
    id: a.id,
    top: positions.get(a.id) ?? 0,
    height: heights.get(a.id),
  }));
  return resolveCollisions(input);
});

// Prune entries from `heights` whose annotation is no longer in `placeable`.
// Without this, every accepted/dismissed/removed annotation leaves a stale
// height entry behind — the Map grows unboundedly across a long session.
//
// The effect's TRACKED dependency is `placeable` only. We read `heights.keys()`
// and mutate `heights` inside `untrack(...)` so the prune step never re-enters
// itself when we reassign `heights = new Map(heights)` (which would otherwise
// risk an effect-depth loop documented in `feedback_svelte_effect_depth_guard`).
// Pruning safety: we only delete ids NOT in `placeable`, so a concurrent
// `recordHeight` write for a still-placeable id cannot be stranded.
$effect(() => {
  const placeableIds = new Set(placeable.map((a) => a.id));
  untrack(() => {
    const removed = prunePlaceableHeights(heights, placeableIds);
    if (removed > 0) {
      // Reassign to a fresh Map so $state identity tracking matches the
      // contract established by `recordHeight`.
      heights = new Map(heights);
    }
  });
});

/**
 * Record a measured height for `id`. Skips writes that would only move the
 * value by < 0.5px (subpixel jitter from layout reflow), mirroring the
 * tolerance check in `useMarginPositions` so the same kind of re-render
 * storm cannot start here either. Re-assigns to a fresh Map to trigger
 * $state reactivity.
 */
function recordHeight(id: string, h: number): void {
  if (!Number.isFinite(h) || h <= 0) return;
  const prev = heights.get(id);
  if (prev !== undefined && Math.abs(prev - h) < 0.5) return;
  const next = new Map(heights);
  next.set(id, h);
  heights = next;
}
</script>

<!-- Leader-line SVG sits in the gap zone between the editor's text edge and
     the column's near edge. Top/bottom stretch makes it cover the full layer
     height so absolute Y coords (relative to the margin layer) line up with
     `useMarginPositions` output. SVG default user units = pixels (no viewBox),
     so we render lines directly at the computed Y offsets. Decorative only:
     pointer-events: none, aria-hidden.

     Stroke is tinted by side (left = notes / user, right = comments / Claude)
     to mirror the authorship decoration convention (ADR-026). Default uses
     stroke-opacity to stay subtle; active review target ramps opacity + width
     so the focused annotation's connector reads as the dominant line on the
     page. -->
<svg
  data-testid="margin-leaders-{side}"
  class="tandem-margin-leaders"
  aria-hidden="true"
  style="position: absolute; top: 0; bottom: 0; {side === 'right'
    ? 'right'
    : 'left'}: {edgeInset + width}px; width: {gap}px; pointer-events: none; color: var(--tandem-author-{side === 'right' ? 'claude' : 'user'});"
>
  {#each placeable as ann (ann.id)}
    {@const rawTop = positions.get(ann.id)}
    {@const adjTop = adjustedPositions.get(ann.id)}
    {#if rawTop !== undefined && adjTop !== undefined}
      {@const editorX = side === "right" ? 0 : gap}
      {@const columnX = side === "right" ? gap : 0}
      {@const isActive = ann.id === activeAnnotationId}
      <!-- LEADER_BUBBLE_INSET_PX shifts the bubble endpoint down from the
           bubble's top edge into its padded content area, so a
           collision-pushed bubble's connector lands near the title row
           instead of pointing at the empty corner above it. -->
      <line
        data-annotation-id={ann.id}
        x1={editorX}
        y1={rawTop}
        x2={columnX}
        y2={adjTop + LEADER_BUBBLE_INSET_PX}
        stroke="currentColor"
        stroke-width={isActive ? 1.75 : 1}
        stroke-opacity={isActive ? 0.9 : 0.4}
        stroke-linecap="round"
        fill="none"
      />
    {/if}
  {/each}
</svg>

<div
  data-testid="margin-column-{side}"
  aria-label={side === "left" ? "Note bubbles" : "Comment bubbles"}
  style="position: absolute; top: 0; {side}: {edgeInset}px; width: {width}px; pointer-events: none;"
>
  {#each placeable as ann (ann.id)}
    {@const top = adjustedPositions.get(ann.id) ?? positions.get(ann.id) ?? 0}
    {@const visibleReplies = getVisibleReplies(ann, repliesById.get(ann.id))}
    <!-- Svelte 5 function-binding form on `bind:clientHeight` below
         (`bind:prop={getter, setter}`) — the only form that supports
         per-key dispatch into a Map. A plain `bind:clientHeight={x}`
         requires a scalar L-value; we have a Map<id, height>, so the
         setter routes each measurement through `recordHeight(ann.id, ...)`.
         We use Svelte's built-in `bind:clientHeight` instead of an ad-hoc
         ResizeObserver to avoid wiring one observer per bubble; Svelte
         already shares a single ResizeObserver internally.
         Docs: https://svelte.dev/docs/svelte/bind#Function-bindings
         and https://svelte.dev/docs/svelte/bind#dimensions -->
    <div
      data-testid="margin-bubble-{ann.id}"
      data-margin-bubble-reply-count={visibleReplies.length}
      style="position: absolute; top: {top}px; {side}: 0; width: {width}px; pointer-events: auto;"
      bind:clientHeight={
        () => heights.get(ann.id) ?? 0,
        (h: number) => recordHeight(ann.id, h)
      }
    >
      <AnnotationCard
        annotation={ann}
        replies={visibleReplies}
        isReviewTarget={ann.id === activeAnnotationId}
        onClick={() => onClick(ann)}
        onAccept={ann.author !== "user" ? onAccept : undefined}
        onDismiss={ann.author !== "user" ? onDismiss : undefined}
        onRemove={ann.author === "user" ? onRemove : undefined}
        onSendToClaude={ann.type === "note" ? onSendToClaude : undefined}
        {onEdit}
        {onReply}
      />
    </div>
  {/each}
</div>
