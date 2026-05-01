<script lang="ts">
import type { AnnotationReply } from "../../shared/types";
import CommentThread from "./CommentThread.svelte";
import { TEXTAREA_STYLE } from "./panel-styles";

interface Props {
  annotationId: string;
  replies: AnnotationReply[];
  isPending: boolean;
  isEditing: boolean;
  onReply?: (id: string, text: string) => Promise<boolean>;
}

let { annotationId, replies, isPending, isEditing, onReply }: Props = $props();

let isReplying = $state(false);
let replyText = $state("");
let isSendingReply = $state(false);

const hasText = $derived(Boolean(replyText.trim()));

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

<CommentThread {replies} />

{#if isPending && onReply && !isEditing}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div style="margin-top: 6px;" onclick={(e) => e.stopPropagation()}>
    {#if isReplying}
      <div>
        <textarea
          data-testid="reply-input-{annotationId}"
          value={replyText}
          oninput={(e) => (replyText = (e.target as HTMLTextAreaElement).value)}
          onkeydown={handleReplyKeyDown}
          placeholder="Write a reply..."
          style={TEXTAREA_STYLE}
          autofocus
        ></textarea>
        <div style="display: flex; gap: 6px; margin-top: 4px;">
          <button
            data-testid="reply-send-btn-{annotationId}"
            onclick={handleSendReply}
            disabled={!hasText || isSendingReply}
            style="padding: 2px 8px; font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: 3px; background: {hasText
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
            style="padding: 2px 8px; font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: 3px; background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: pointer;"
          >
            Cancel
          </button>
        </div>
      </div>
    {:else}
      <button
        data-testid="reply-btn-{annotationId}"
        onclick={() => (isReplying = true)}
        style="padding: 1px 4px; font-size: 11px; border: none; background: none; color: var(--tandem-fg-subtle); cursor: pointer;"
      >
        Reply{replies.length > 0 ? ` (${replies.length})` : ""}
      </button>
    {/if}
  </div>
{/if}

{#if !isPending && replies.length > 0 && !onReply}
  <div style="margin-top: 4px; font-size: 11px; color: var(--tandem-fg-subtle);">
    {replies.length}
    {replies.length === 1 ? "reply" : "replies"}
  </div>
{/if}
