<script lang="ts">
import type { Annotation, AnnotationReply } from "../../shared/types";
import { getVisibleReplies } from "../annotations/replies";
import AnnotationCard from "./AnnotationCard.svelte";
import { resolveCollisions } from "./marginCollision";

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

<div
  data-testid="margin-column-{side}"
  aria-label={side === "left" ? "Note bubbles" : "Comment bubbles"}
  style="position: absolute; top: 0; {side}: {edgeInset}px; width: {width}px; pointer-events: none;"
>
  {#each placeable as ann (ann.id)}
    {@const top = adjustedPositions.get(ann.id) ?? positions.get(ann.id) ?? 0}
    {@const visibleReplies = getVisibleReplies(ann, repliesById.get(ann.id))}
    <!-- Svelte 5 getter/setter bind form on `bind:clientHeight` below —
         do not refactor to plain `bind:clientHeight={varName}` without
         verifying state shape: heights is a Map keyed by ann.id, not a
         scalar variable. -->
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
