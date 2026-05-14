<script lang="ts">
import type { Annotation } from "../../shared/types";
import AnnotationCardHeader from "./AnnotationCardHeader.svelte";
import AnnotationSnippet from "./AnnotationSnippet.svelte";

interface Props {
  /** Any annotation authored by import (Word comments). */
  annotation: Annotation & { author: "import" };
  isPending: boolean;
  isReviewTarget?: boolean;
  isEditing: boolean;
  canEdit: boolean;
  onEnterEdit: () => void;
}

let { annotation, isPending, isReviewTarget, isEditing, canEdit, onEnterEdit }: Props = $props();

// TODO(AR6): render importSource.author
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
