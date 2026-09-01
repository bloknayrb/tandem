<script lang="ts">
import type { Annotation } from "../../shared/types";
import AnnotationBody from "./AnnotationBody.svelte";
import AnnotationCardHeader from "./AnnotationCardHeader.svelte";
import AnnotationSnippet from "./AnnotationSnippet.svelte";

interface Props {
  /** Comment without suggestedText (user- or claude-authored). */
  annotation: Annotation & { type: "comment"; suggestedText?: undefined };
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
  {onEnterEdit}
/>

<AnnotationSnippet annotationId={annotation.id} text={annotation.textSnapshot} />

{#if !isEditing}
  <div class="aca-body" style="margin: 0; color: var(--tandem-fg); line-height: 1.45;">
    <AnnotationBody
      text={annotation.content}
      author={annotation.author}
      placeholder="(no note)"
    />
  </div>
{/if}
