<script lang="ts">
import { HIGHLIGHT_COLORS } from "../../shared/constants";
import type { Annotation, AnnotationReply } from "../../shared/types";
import AnnotationCardActions from "./AnnotationCardActions.svelte";
import AnnotationEditForm from "./AnnotationEditForm.svelte";
import ReplyThread from "./ReplyThread.svelte";

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

let isEditing = $state(false);
let editText = $state("");
let editNewText = $state("");
let editReason = $state("");

const isPending = $derived(annotation.status === "pending");
const hasSuggestedText = $derived(annotation.suggestedText !== undefined);

function getDisplayType(ann: Annotation): string {
  if (ann.suggestedText !== undefined) return "replacement";
  return ann.type;
}

function getAuthorLabel(author: Annotation["author"]): string {
  if (author === "claude") return "Claude";
  if (author === "import") return "Imported";
  return "You";
}

function getBorderColor(ann: Annotation): string {
  if (ann.color) {
    return HIGHLIGHT_COLORS[ann.color] || "var(--tandem-border)";
  }
  if (ann.suggestedText !== undefined) return "var(--tandem-suggestion)";
  if (ann.type === "note") return "var(--tandem-warning)";
  return "var(--tandem-author-user)";
}

function getCardBackground(ann: Annotation, reviewTarget?: boolean): string {
  if (reviewTarget) return "var(--tandem-accent-bg)";
  if (ann.type === "note") return "var(--tandem-warning-bg)";
  return "var(--tandem-surface)";
}

const displayType = $derived(getDisplayType(annotation));
const borderColor = $derived(getBorderColor(annotation));
const cardBg = $derived(getCardBackground(annotation, isReviewTarget));
const isPrivateNote = $derived(annotation.type === "note");

const truncatedContent = $derived(
  annotation.content
    ? annotation.content.length > 60
      ? annotation.content.slice(0, 57) + "..."
      : annotation.content
    : "",
);

const cardLabel = $derived(
  `${isPrivateNote ? "private " : ""}${displayType} annotation${truncatedContent ? ": " + truncatedContent : ""}, ${annotation.status}`,
);

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
  style="padding: var(--tandem-space-2) 10px; margin-bottom: var(--tandem-space-2); border-left: 3px solid {borderColor}; background: {cardBg}; border-radius: 0 4px 4px 0; font-size: 13px; opacity: {isPending
    ? 1
    : 0.6}; cursor: {onClick
    ? 'pointer'
    : 'default'}; outline: {isReviewTarget
    ? '2px solid var(--tandem-accent)'
    : 'none'}; transition: background 0.15s, outline 0.15s;"
>
  <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
    <span
      style="font-weight: 500; text-transform: capitalize; display: flex; align-items: center; gap: 4px;"
    >
      {displayType}
      {#if isPrivateNote}
        <span
          data-testid="annotation-private-pill"
          aria-hidden="true"
          title="Private note"
          style="padding: 1px 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; color: var(--tandem-warning-fg); background: var(--tandem-warning); border-radius: 3px; line-height: 1;"
        >
          Private
        </span>
      {/if}
      {#if !isPending}
        <span
          style="margin-left: 6px; font-size: 10px; color: {annotation.status === 'accepted'
            ? 'var(--tandem-success)'
            : 'var(--tandem-error)'}; font-weight: 600;"
        >
          {annotation.status}
        </span>
      {/if}
      {#if isPending && onEdit && !isReviewTarget && !isEditing}
        <button
          data-testid="edit-btn-{annotation.id}"
          onclick={(e) => {
            e.stopPropagation();
            enterEditMode();
          }}
          style="padding: 1px 4px; font-size: 11px; border: none; background: none; color: var(--tandem-fg-subtle); cursor: pointer; line-height: 1;"
          title="Edit this annotation's content"
        >
          ✎ Edit
        </button>
      {/if}
    </span>
    <span
      style="font-size: 11px; color: var(--tandem-fg-subtle); display: flex; align-items: center; gap: 4px;"
    >
      {#if annotation.editedAt}
        <span style="font-style: italic; font-size: 10px; color: var(--tandem-fg-subtle);">
          (edited)
        </span>
      {/if}
      {getAuthorLabel(annotation.author)}
    </span>
  </div>

  {#if annotation.textSnapshot}
    <div
      data-testid="annotation-snippet-{annotation.id}"
      style="padding: 4px 8px; margin-bottom: 6px; border-left: 3px solid var(--tandem-border-strong); color: var(--tandem-fg-muted); font-size: 12px; font-style: italic; background-color: var(--tandem-surface-muted); border-radius: 2px;"
    >
      {annotation.textSnapshot.length > 80
        ? annotation.textSnapshot.slice(0, 77) + "..."
        : annotation.textSnapshot}
    </div>
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
  {:else}
    <div style="margin: 0; color: var(--tandem-fg); line-height: 1.4;">
      {#if hasSuggestedText}
        <div
          data-testid="suggestion-diff-{annotation.id}"
          style="padding: 4px 8px; margin-bottom: {annotation.content
            ? '4px'
            : '0'}; background-color: var(--tandem-surface-muted); border-radius: 3px; font-size: 12px; line-height: 1.5;"
        >
          {#if annotation.textSnapshot}
            <span
              style="text-decoration: line-through; color: var(--tandem-error); background-color: var(--tandem-error-bg); padding: 0 2px; border-radius: 2px;"
            >
              {annotation.textSnapshot}
            </span>
          {/if}
          {#if annotation.textSnapshot}
            {" → "}
          {/if}
          <span
            style="color: var(--tandem-success-fg-strong); background-color: var(--tandem-success-bg); padding: 0 2px; border-radius: 2px;"
          >
            {annotation.suggestedText}
          </span>
        </div>
        {#if annotation.content}
          <p style="margin: 0; font-size: 12px; color: var(--tandem-fg-muted);">
            {annotation.content}
          </p>
        {/if}
      {:else}
        <p style="margin: 0;">{annotation.content || "(no note)"}</p>
      {/if}
    </div>
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
</div>
