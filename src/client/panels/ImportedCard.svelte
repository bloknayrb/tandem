<script lang="ts">
import type { Annotation } from "../../shared/types";
import AnnotationCardHeader from "./AnnotationCardHeader.svelte";
import AnnotationSnippet from "./AnnotationSnippet.svelte";

interface Props {
  /**
   * Any annotation that PRESENTS as an import — `getDisplayAuthor(ann) ===
   * "import"`, which the one dispatch site in `AnnotationCard.svelte` enforces.
   *
   * Deliberately not `Annotation & { author: "import" }` any more: since #1714
   * a promoted import renders here with `author: "user"`, so that intersection
   * was a lie the call site papered over with a cast. The `importSource?.`
   * accesses below were already optional-chained, so nothing here relied on it.
   */
  annotation: Annotation;
  isPending: boolean;
  isReviewTarget?: boolean;
  isEditing: boolean;
  canEdit: boolean;
  onEnterEdit: () => void;
  /** When provided, render an always-visible selection checkbox. */
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

let {
  annotation,
  isPending,
  isReviewTarget,
  isEditing,
  canEdit,
  onEnterEdit,
  selected = false,
  onToggleSelect,
}: Props = $props();
</script>

<div style="display: flex; align-items: flex-start; gap: var(--tandem-space-2);">
  {#if onToggleSelect}
    <input
      type="checkbox"
      data-testid="annotation-select-checkbox-{annotation.id}"
      checked={selected}
      onclick={(e) => e.stopPropagation()}
      onchange={() => onToggleSelect?.(annotation.id)}
      aria-label={`Select ${annotation.importSource?.author ?? "import"} comment for batch promote`}
      style="margin-top: 4px; flex-shrink: 0; cursor: pointer;"
    />
  {/if}

  <div style="flex: 1; min-width: 0;">
    <AnnotationCardHeader
      {annotation}
      {isPending}
      {isReviewTarget}
      {isEditing}
      {canEdit}
      {onEnterEdit}
    />

    {#if annotation.importSource?.author}
      <!-- Reviewer attribution byline. Imports carry the original Word
           commenter's name; surfacing it lets the user decide which
           reviewer's comments to promote without opening the source file. -->
      <div
        data-testid="annotation-import-byline-{annotation.id}"
        style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-bottom: 4px;"
      >
        From: <span style="font-weight: 500;">{annotation.importSource.author}</span>
      </div>
    {/if}

    <AnnotationSnippet annotationId={annotation.id} text={annotation.textSnapshot} />

    {#if !isEditing}
      <div class="aca-body" style="margin: 0; color: var(--tandem-fg); line-height: 1.45;">
        <p style="margin: 0;">{annotation.content || "(no note)"}</p>
      </div>
    {/if}
  </div>
</div>
