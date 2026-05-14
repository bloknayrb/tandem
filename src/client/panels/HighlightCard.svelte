<script lang="ts">
import type { Annotation } from "../../shared/types";
import AnnotationCardHeader from "./AnnotationCardHeader.svelte";
import AnnotationSnippet from "./AnnotationSnippet.svelte";

interface Props {
  annotation: Annotation & { type: "highlight" };
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
  badgeBg="var(--tandem-surface-sunk)"
  badgeFg="var(--tandem-fg-muted)"
  {onEnterEdit}
/>

<AnnotationSnippet annotationId={annotation.id} text={annotation.textSnapshot} />

{#if !isEditing}
  <div style="margin: 0; color: var(--tandem-fg); line-height: 1.45;">
    <p style="margin: 0;">{annotation.content || "(no note)"}</p>
  </div>
{/if}
