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

const borderColor = $derived.by(() => {
  if (annotation.type === "highlight") return getHighlightBorder(annotation);
  if (annotation.suggestedText !== undefined) return "var(--tandem-suggestion)";
  if (annotation.type === "note") return "var(--tandem-warning)";
  return "var(--tandem-author-user)";
});

const cardBg = $derived(isReviewTarget ? "var(--tandem-accent-bg)" : "var(--tandem-surface)");

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
  onclick={onClick}
  data-testid="annotation-card-{annotation.id}"
  role="listitem"
  aria-label={cardLabel}
  aria-current={isReviewTarget ? "true" : undefined}
  style="padding: var(--tandem-space-3); margin-bottom: var(--tandem-space-2); border: 1px solid var(--tandem-border); border-left: 3px solid {borderColor}; background: {cardBg}; border-radius: var(--tandem-r-3); font-size: var(--tandem-text-base); opacity: {isPending
    ? 1
    : 0.6}; cursor: {onClick
    ? 'pointer'
    : 'default'}; box-shadow: {isReviewTarget
    ? '0 0 0 3px var(--tandem-accent-bg)'
    : 'none'}; transition: background 0.15s, box-shadow 0.15s, border-color 0.15s;"
>
  {#if annotation.author === "import"}
    <ImportedCard
      annotation={annotation as Annotation & { author: "import" }}
      {isPending}
      {isReviewTarget}
      {isEditing}
      {canEdit}
      onEnterEdit={enterEditMode}
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
    annotationId={annotation.id}
    {replies}
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
      style="margin-top: 4px; padding: 1px 4px; font-size: var(--tandem-text-xs); border: none; background: none; color: var(--tandem-fg-subtle); cursor: pointer;"
    >
      Expand thread
    </button>
  {/if}
</div>
<ReplyThreadOverlay
  open={isThreadOverlayOpen}
  {annotation}
  {replies}
  {onReply}
  onClose={() => (isThreadOverlayOpen = false)}
/>
