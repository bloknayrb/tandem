<script lang="ts">
import type { Annotation } from "../../shared/types";
import AnnotationCardHeader from "./AnnotationCardHeader.svelte";
import AnnotationSnippet from "./AnnotationSnippet.svelte";

interface Props {
  annotation: Annotation & { type: "note" };
  isPending: boolean;
  isReviewTarget?: boolean;
  isEditing: boolean;
  canEdit: boolean;
  onEnterEdit: () => void;
}

let { annotation, isPending, isReviewTarget, isEditing, canEdit, onEnterEdit }: Props = $props();
</script>

<AnnotationCardHeader
  {annotation}
  {isPending}
  {isReviewTarget}
  {isEditing}
  {canEdit}
  badgeBg="var(--tandem-warning-bg)"
  badgeFg="var(--tandem-warning-fg-strong)"
  {onEnterEdit}
>
  {#snippet extraPill()}
    <span
      data-testid="annotation-private-pill"
      aria-hidden="true"
      title="Private note"
      style="padding: 1px 6px; font-size: var(--tandem-text-2xs); font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; color: var(--tandem-warning-fg); background: var(--tandem-warning); border-radius: var(--tandem-r-2); line-height: 1;"
    >
      Private
    </span>
  {/snippet}
</AnnotationCardHeader>

<AnnotationSnippet annotationId={annotation.id} text={annotation.textSnapshot} />

{#if !isEditing}
  <div class="aca-body" style="margin: 0; color: var(--tandem-fg); line-height: 1.45;">
    <p style="margin: 0;">{annotation.content || "(no note)"}</p>
  </div>
{/if}
