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
  /**
   * #651: render an inline typing-dot indicator when Claude is executing an
   * MCP tool targeting this annotation. Subscribed once at the YjsSync layer
   * and forwarded as a plain boolean so each card doesn't observe the
   * awareness Y.Map itself.
   */
  claudeTyping?: boolean;
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
  claudeTyping = false,
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
  class="tandem-annotation-card"
  onclick={onClick}
  data-testid="annotation-card-{annotation.id}"
  data-annotation-type={annotation.type}
  data-claude-typing={claudeTyping ? "true" : undefined}
  role="listitem"
  aria-label={cardLabel}
  aria-current={isReviewTarget ? "true" : undefined}
  style="position: relative; padding: var(--tandem-space-3); margin-bottom: var(--tandem-space-2); border: 1px solid var(--tandem-border); border-left: 3px solid {borderColor}; background: {cardBg}; border-radius: var(--tandem-r-3); font-size: var(--tandem-text-base); opacity: {isPending
    ? 1
    : 0.6}; cursor: {onClick
    ? 'pointer'
    : 'default'}; box-shadow: {isReviewTarget
    ? '0 0 0 3px var(--tandem-accent-bg)'
    : 'none'}; transition: background 0.15s, box-shadow 0.15s, border-color 0.15s;"
>
  {#if claudeTyping}
    <!--
      #651: Claude typing-presence indicator. Renders as a three-dot pulse in
      the top-right corner of the card while the targeting MCP tool runs.
      `aria-live="polite"` so screen readers announce the transition without
      interrupting; `role="status"` keeps it out of the listitem accessibility
      tree as a child semantic region.
    -->
    <div
      data-testid="claude-typing-indicator-{annotation.id}"
      class="tandem-claude-typing"
      role="status"
      aria-live="polite"
      aria-label="Claude is working on this annotation"
      title="Claude is working on this annotation"
    >
      <span class="tandem-claude-typing-dot"></span>
      <span class="tandem-claude-typing-dot"></span>
      <span class="tandem-claude-typing-dot"></span>
    </div>
  {/if}
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
  /* #651 Claude typing-presence indicator: three pulsing dots in the
     card's top-right corner, colored with the Claude authorship token so
     the affordance reads as "Claude is here" at a glance. */
  .tandem-claude-typing {
    position: absolute;
    top: var(--tandem-space-2);
    right: var(--tandem-space-2);
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 6px;
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-claude-focus-bg);
    pointer-events: none;
  }
  .tandem-claude-typing-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--tandem-author-claude);
    animation: tandem-claude-typing-pulse 1.2s ease-in-out infinite;
  }
  .tandem-claude-typing-dot:nth-child(2) {
    animation-delay: 0.15s;
  }
  .tandem-claude-typing-dot:nth-child(3) {
    animation-delay: 0.3s;
  }
  @keyframes tandem-claude-typing-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.85); }
    40% { opacity: 1; transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .tandem-claude-typing-dot {
      animation: none;
      opacity: 0.7;
    }
  }
  @media (forced-colors: active) {
    .tandem-claude-typing-dot {
      outline: 1px solid ButtonText;
      outline-offset: 1px;
    }
  }
</style>
