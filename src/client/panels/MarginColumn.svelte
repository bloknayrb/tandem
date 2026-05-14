<script lang="ts">
import type { Annotation, AnnotationReply } from "../../shared/types";
import AnnotationCard from "./AnnotationCard.svelte";

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
  repliesById: Map<string, AnnotationReply[]>;
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
</script>

<div
  data-testid="margin-column-{side}"
  aria-label={side === "left" ? "Note bubbles" : "Comment bubbles"}
  style="position: absolute; top: 0; {side}: {edgeInset}px; width: {width}px; pointer-events: none;"
>
  {#each placeable as ann (ann.id)}
    {@const top = positions.get(ann.id) ?? 0}
    <div
      data-testid="margin-bubble-{ann.id}"
      style="position: absolute; top: {top}px; {side}: 0; width: {width}px; pointer-events: auto;"
    >
      <AnnotationCard
        annotation={ann}
        replies={repliesById.get(ann.id) ?? []}
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
