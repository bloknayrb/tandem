<script lang="ts">
import type { Annotation } from "../../shared/types";
import { diffWords } from "../utils/word-diff";
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

// Word-level diff (B1): only the changed words are highlighted instead of
// striking the whole snapshot + inserting the whole suggestion. `null` means
// "no snapshot" or "too large to diff" — callers fall back to the legacy
// whole-text rendering below.
const segments = $derived(
  annotation.textSnapshot ? diffWords(annotation.textSnapshot, annotation.suggestedText) : null,
);
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
<div class="aca-body" style="margin: 0; color: var(--tandem-fg); line-height: 1.45;">
  <div
    data-testid="suggestion-diff-{annotation.id}"
    style="padding: 4px 8px; margin-bottom: {annotation.content
      ? '4px'
      : '0'}; background-color: var(--tandem-surface-muted); border-radius: var(--tandem-r-2); font-size: 12px; line-height: 1.5; white-space: pre-wrap;"
  >
    {#if segments}
      {#each segments as segment, i (i)}
        {#if segment.type === "equal"}
          <span>{segment.text}</span>
        {:else if segment.type === "del"}
          <span
            style="text-decoration: line-through; color: var(--tandem-error); background-color: var(--tandem-error-bg); border-radius: var(--tandem-r-1);"
          >{segment.text}</span>
        {:else}
          <span
            style="color: var(--tandem-success-fg-strong); background-color: var(--tandem-success-bg); border-radius: var(--tandem-r-1);"
          >{segment.text}</span>
        {/if}
      {/each}
    {:else}
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
    {/if}
  </div>
  {#if annotation.content}
    <p style="margin: 0; font-size: 12px; color: var(--tandem-fg-muted);">
      {annotation.content}
    </p>
  {/if}
</div>
{/if}
