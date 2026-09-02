<script lang="ts">
import type { Annotation } from "../../shared/types";
import AnnotationCardHeader from "./AnnotationCardHeader.svelte";
import AnnotationSnippet from "./AnnotationSnippet.svelte";

interface Props {
  /**
   * A genuine, unpromoted import — `author === "import"`, which the one dispatch
   * site in `AnnotationCard.svelte` enforces.
   *
   * The reviewer byline used to live here and moved to `AnnotationCardHeader`
   * in #1714. It had to: a PROMOTED import keeps the reviewer's name but is an
   * ordinary editable comment, so it renders as `CommentCard`/`SuggestionCard`
   * and would otherwise have shown no byline at all. Keeping the byline here
   * and routing promoted records in was the alternative, and it costs them
   * markdown rendering and the suggestion diff, neither of which this card has.
   *
   * The type stays plain `Annotation` rather than `& { author: "import" }`: the
   * intersection was never load-bearing (`importSource` is optional on the base
   * type, so it narrowed nothing that is read here) and only forced a cast at
   * the call site.
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

    <AnnotationSnippet annotationId={annotation.id} text={annotation.textSnapshot} />

    {#if !isEditing}
      <div class="aca-body" style="margin: 0; color: var(--tandem-fg); line-height: 1.45;">
        <p style="margin: 0;">{annotation.content || "(no note)"}</p>
      </div>
    {/if}
  </div>
</div>
