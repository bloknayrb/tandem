<script lang="ts">
import type { Annotation } from "../../shared/types";
import AnnotationCardHeader from "./AnnotationCardHeader.svelte";
import AnnotationSnippet from "./AnnotationSnippet.svelte";

interface Props {
  /** Comment with suggestedText. */
  annotation: Annotation & { type: "comment"; suggestedText: string };
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
  badgeBg="var(--tandem-suggestion-bg)"
  badgeFg="var(--tandem-suggestion-fg-strong)"
  {onEnterEdit}
/>

<AnnotationSnippet annotationId={annotation.id} text={annotation.textSnapshot} />

{#if !isEditing}
<div style="margin: 0; color: var(--tandem-fg); line-height: 1.45;">
  <div
    data-testid="suggestion-diff-{annotation.id}"
    style="padding: 4px 8px; margin-bottom: {annotation.content
      ? '4px'
      : '0'}; background-color: var(--tandem-surface-muted); border-radius: var(--tandem-r-2); font-size: 12px; line-height: 1.5;"
  >
    {#if annotation.textSnapshot}
      <span
        style="text-decoration: line-through; color: var(--tandem-error); background-color: var(--tandem-error-bg); padding: 0 2px; border-radius: var(--tandem-r-1);"
      >
        {annotation.textSnapshot}
      </span>
      {" → "}
    {/if}
    <span
      style="color: var(--tandem-success-fg-strong); background-color: var(--tandem-success-bg); padding: 0 2px; border-radius: var(--tandem-r-1);"
    >
      {annotation.suggestedText}
    </span>
  </div>
  {#if annotation.content}
    <p style="margin: 0; font-size: 12px; color: var(--tandem-fg-muted);">
      {annotation.content}
    </p>
  {/if}
</div>
{/if}
