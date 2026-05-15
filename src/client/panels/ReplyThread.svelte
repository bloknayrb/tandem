<script lang="ts">
import type { Annotation, AnnotationReply } from "../../shared/types";
import { getVisibleReplies } from "../annotations/replies";
import CommentThread from "./CommentThread.svelte";
import { TEXTAREA_STYLE } from "./panel-styles";

interface Props {
  annotation: Annotation;
  replies: AnnotationReply[];
  isPending: boolean;
  isEditing: boolean;
  onReply?: (id: string, text: string) => Promise<boolean>;
}

let { annotation, replies, isPending, isEditing, onReply }: Props = $props();

// ADR-027 single fan-out point: even if a caller passes raw replies,
// note/highlight annotations render zero replies + zero count badge.
// Claude must not be able to infer that a note has replies — even from
// a count number.
const visibleReplies = $derived(getVisibleReplies(annotation, replies));
const annotationId = $derived(annotation.id);

let isReplying = $state(false);
let replyText = $state("");
let isSendingReply = $state(false);
let replyTextareaEl: HTMLTextAreaElement | null = $state(null);

const hasText = $derived(Boolean(replyText.trim()));

$effect(() => {
  if (isReplying) replyTextareaEl?.focus();
});

function handleReplyKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    isReplying = false;
    replyText = "";
  }
}

async function handleSendReply() {
  const trimmed = replyText.trim();
  if (!trimmed || isSendingReply) return;
  isSendingReply = true;
  try {
    const ok = await onReply?.(annotationId, trimmed);
    if (ok !== false) {
      replyText = "";
      isReplying = false;
    }
  } finally {
    isSendingReply = false;
  }
}
</script>

<CommentThread replies={visibleReplies} />

{#if isPending && onReply && !isEditing}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div style="margin-top: 6px;" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    {#if isReplying}
      <div>
        <textarea
          bind:this={replyTextareaEl}
          data-testid="reply-input-{annotationId}"
          value={replyText}
          oninput={(e) => (replyText = (e.target as HTMLTextAreaElement).value)}
          onkeydown={handleReplyKeyDown}
          placeholder="Write a reply..."
          style={TEXTAREA_STYLE}
        ></textarea>
        <div style="display: flex; gap: 2px; margin-top: 2px;">
          <button
            data-testid="reply-send-btn-{annotationId}"
            onclick={handleSendReply}
            disabled={!hasText || isSendingReply}
            style="padding: 2px 8px; font-size: var(--tandem-text-xs); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-1); background: {hasText
              ? 'var(--tandem-accent-bg)'
              : 'var(--tandem-surface-muted)'}; color: {hasText
              ? 'var(--tandem-accent-fg-strong)'
              : 'var(--tandem-fg-subtle)'}; cursor: {hasText ? 'pointer' : 'default'};"
          >
            Send
          </button>
          <button
            data-testid="reply-cancel-btn-{annotationId}"
            onclick={() => {
              isReplying = false;
              replyText = "";
            }}
            style="padding: 2px 8px; font-size: var(--tandem-text-xs); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-1); background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: pointer;"
          >
            Cancel
          </button>
        </div>
      </div>
    {:else}
      <button
        data-testid="reply-btn-{annotationId}"
        onclick={() => (isReplying = true)}
        style="padding: 1px 4px; font-size: var(--tandem-text-xs); border: none; background: none; color: var(--tandem-fg-subtle); cursor: pointer;"
      >
        Reply{visibleReplies.length > 0 ? ` (${visibleReplies.length})` : ""}
      </button>
    {/if}
  </div>
{/if}

{#if !isPending && visibleReplies.length > 0 && !onReply}
  <div style="margin-top: 4px; font-size: var(--tandem-text-xs); color: var(--tandem-fg-subtle);">
    {visibleReplies.length}
    {visibleReplies.length === 1 ? "reply" : "replies"}
  </div>
{/if}
