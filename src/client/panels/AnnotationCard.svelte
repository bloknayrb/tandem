<script lang="ts">
import type { Annotation, AnnotationReply } from "../../shared/types";
import { getVisibleReplies } from "../annotations/replies";
import AnnotationCardActions from "./AnnotationCardActions.svelte";
import AnnotationEditForm from "./AnnotationEditForm.svelte";
import { getCardLabel, getHighlightBorder } from "./annotation-card-helpers";
import CommentCard from "./CommentCard.svelte";
import HighlightCard from "./HighlightCard.svelte";
import ImportedCard from "./ImportedCard.svelte";
import NoteCard from "./NoteCard.svelte";
import ReplyThread from "./ReplyThread.svelte";
import ReplyThreadOverlay from "./ReplyThreadOverlay.svelte";
import SuggestionCard from "./SuggestionCard.svelte";

interface Props {
  annotation: Annotation;
  replies?: AnnotationReply[];
  isReviewTarget?: boolean;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => boolean;
  onEdit?: (id: string, newContent: string) => void;
  onReply?: (id: string, text: string) => Promise<boolean>;
  onRemove?: (id: string) => void;
  onSendToClaude?: (id: string) => void;
  /** Whether this annotation was recently resolved and can be undone */
  undoable?: boolean;
  onClick?: () => void;
  /** Batch-selection state — forwarded to ImportedCard only. */
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

let {
  annotation,
  replies = [],
  isReviewTarget,
  onAccept,
  onDismiss,
  onUndo,
  onEdit,
  onReply,
  onRemove,
  onSendToClaude,
  undoable,
  onClick,
  selected = false,
  onToggleSelect,
}: Props = $props();

// Shared edit-mode state owned by the dispatcher; variants are presentational
// and never own state. The edit form replaces the variant body when isEditing.
let isEditing = $state(false);
let editText = $state("");
let editNewText = $state("");
let editReason = $state("");

const isPending = $derived(annotation.status === "pending");
const hasSuggestedText = $derived(annotation.suggestedText !== undefined);
const canEdit = $derived(onEdit !== undefined);
const cardLabel = $derived(getCardLabel(annotation));
// Privacy: getVisibleReplies returns [] for non-comment annotations,
// so note/highlight cards never surface the expand affordance.
const visibleReplies = $derived(getVisibleReplies(annotation, replies));
const canExpandThread = $derived(visibleReplies.length >= 1);
let isThreadOverlayOpen = $state(false);

// Per-type body tint replaces the old 3px left-edge border (Conflict #8
// "lift color" interpretation, sub-PR 1.5 — full-taxonomy tints so every type
// stays differentiated, not just the two the bundle tints). getHighlightBorder
// is called inside the derivation so the highlight tint re-tracks annotation.color.
const cardTint = $derived.by(() => {
  if (annotation.author === "import") return "var(--tandem-surface-muted)";
  if (annotation.type === "highlight")
    return `color-mix(in srgb, ${getHighlightBorder(annotation)} 18%, var(--tandem-surface))`;
  if (annotation.type === "note") return "var(--tandem-warning-bg)";
  if (annotation.suggestedText !== undefined) return "var(--tandem-suggestion-bg)";
  if (annotation.author === "claude") return "var(--tandem-author-claude-bg)";
  return "var(--tandem-author-user-bg)";
});

// Review-target override wins over the type tint; the accent ring is applied
// via the .is-review-target class (see <style>) so it composes with :hover.
const cardBg = $derived(isReviewTarget ? "var(--tandem-accent-bg)" : cardTint);

function enterEditMode() {
  if (hasSuggestedText) {
    editNewText = annotation.suggestedText ?? "";
    editReason = annotation.content;
  } else {
    editText = annotation.content;
  }
  isEditing = true;
}

function handleSave() {
  const newContent = hasSuggestedText
    ? JSON.stringify({ suggestedText: editNewText, content: editReason })
    : editText;
  onEdit?.(annotation.id, newContent);
  isEditing = false;
}

function handleCancel() {
  isEditing = false;
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    handleCancel();
  }
}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="tandem-annotation-card"
  class:is-review-target={isReviewTarget}
  onclick={onClick}
  data-testid="annotation-card-{annotation.id}"
  data-annotation-type={annotation.type}
  role="listitem"
  aria-label={cardLabel}
  aria-current={isReviewTarget ? "true" : undefined}
  style="background: {cardBg}; opacity: {isPending ? 1 : 0.6}; cursor: {onClick
    ? 'pointer'
    : 'default'};"
>
  {#if annotation.author === "import"}
    <ImportedCard
      annotation={annotation as Annotation & { author: "import" }}
      {isPending}
      {isReviewTarget}
      {isEditing}
      {canEdit}
      onEnterEdit={enterEditMode}
      {selected}
      {onToggleSelect}
    />
  {:else if annotation.type === "highlight"}
    <HighlightCard
      {annotation}
      {isPending}
      {isReviewTarget}
      {isEditing}
      {canEdit}
      onEnterEdit={enterEditMode}
    />
  {:else if annotation.type === "note"}
    <NoteCard
      {annotation}
      {isPending}
      {isReviewTarget}
      {isEditing}
      {canEdit}
      onEnterEdit={enterEditMode}
    />
  {:else if annotation.suggestedText !== undefined}
    <SuggestionCard
      annotation={annotation as Annotation & { type: "comment"; suggestedText: string }}
      {isPending}
      {isReviewTarget}
      {isEditing}
      {canEdit}
      onEnterEdit={enterEditMode}
    />
  {:else}
    <CommentCard
      annotation={annotation as Annotation & { type: "comment"; suggestedText?: undefined }}
      {isPending}
      {isReviewTarget}
      {isEditing}
      {canEdit}
      onEnterEdit={enterEditMode}
    />
  {/if}

  {#if isEditing}
    <AnnotationEditForm
      annotationId={annotation.id}
      {hasSuggestedText}
      {editText}
      {editNewText}
      {editReason}
      onChangeEditText={(v) => (editText = v)}
      onChangeEditNewText={(v) => (editNewText = v)}
      onChangeEditReason={(v) => (editReason = v)}
      onKeyDown={handleKeyDown}
      onSave={handleSave}
      onCancel={handleCancel}
    />
  {/if}

  <AnnotationCardActions
    annotationId={annotation.id}
    annotationType={annotation.type}
    {isPending}
    {isEditing}
    {undoable}
    {onAccept}
    {onDismiss}
    {onUndo}
    {onRemove}
    {onSendToClaude}
  />
  <ReplyThread
    {annotation}
    replies={visibleReplies}
    {isPending}
    {isEditing}
    {onReply}
  />
  {#if canExpandThread}
    <button
      type="button"
      data-testid="reply-thread-expand-{annotation.id}"
      onclick={(e) => {
        e.stopPropagation();
        isThreadOverlayOpen = true;
      }}
      style="margin-top: var(--tandem-space-1); padding: var(--tandem-space-1) var(--tandem-space-2); font-size: var(--tandem-text-xs); border: none; background: none; color: var(--tandem-fg-subtle); cursor: pointer;"
    >
      Expand thread
    </button>
  {/if}
</div>
<!-- Conditional mount: only instantiate the overlay when there's something
     to show OR it's currently open. The `|| isThreadOverlayOpen` clause
     keeps the overlay mounted across the open→close transition even if
     visibleReplies drops to zero (last reply deleted) so the close
     animation / focus restoration completes cleanly. -->
{#if canExpandThread || isThreadOverlayOpen}
  <ReplyThreadOverlay
    open={isThreadOverlayOpen}
    {annotation}
    replies={visibleReplies}
    {onReply}
    onClose={() => (isThreadOverlayOpen = false)}
  />
{/if}

<style>
  /* Static chrome lives here (not inline) so :hover can raise the shadow —
     an inline style= attribute would beat a class-based :hover on box-shadow.
     The dynamic background tint / opacity / cursor stay inline on the element. */
  .tandem-annotation-card {
    padding: var(--tandem-space-3);
    margin-bottom: var(--tandem-space-2);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-5);
    font-size: var(--tandem-text-base);
    box-shadow: var(--tandem-shadow-1);
    transition: background 0.15s ease, box-shadow 0.15s ease;
  }
  .tandem-annotation-card:hover {
    box-shadow: var(--tandem-shadow-2);
  }
  /* Placed after :hover so the focused-card ring wins at equal specificity. */
  .tandem-annotation-card.is-review-target {
    box-shadow: 0 0 0 3px var(--tandem-accent-bg), var(--tandem-shadow-2);
  }
</style>
