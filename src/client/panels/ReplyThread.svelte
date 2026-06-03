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

// Single client-display fan-out point. Notes show their (private) reply
// threads to the owning user (#1000); highlights never show replies. This is
// NOT the Claude privacy boundary — that is enforced server-side (the channel
// observer + `channelVisibleReplies` on the MCP read paths), so a note's
// private replies never reach Claude regardless of what is displayed here.
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

<!-- `art-root` is the density-collapse hook: the card dispatcher hides the
     whole reply region in clamped/stub via `:global(.art-root)`. Plain block
     wrapper, so full-density vertical flow is unchanged. -->
<div class="art-root">
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
</div>

<style>
  /* Layout-transparent in full density (no box) so the reply region keeps its
     exact vertical flow; the dispatcher's clamped/stub `display:none` override
     wins on specificity. */
  .art-root {
    display: contents;
  }
</style>
