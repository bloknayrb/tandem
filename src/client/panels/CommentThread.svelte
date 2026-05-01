<script lang="ts">
  import type { AnnotationReply } from "../../shared/types";

  interface Props {
    replies: AnnotationReply[];
  }

  let { replies }: Props = $props();

  function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return date.toLocaleDateString();
  }
</script>

{#if replies.length > 0}
  <div
    data-testid="comment-thread"
    style="margin-top: 6px; padding-left: 8px; border-left: 2px solid var(--tandem-border);"
  >
    {#each replies as reply (reply.id)}
      <div
        data-testid="reply-{reply.id}"
        style="padding: 4px 0; font-size: 12px; line-height: 1.4;"
      >
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
          <span
            style="font-weight: 600; font-size: 11px; color: {reply.author === 'claude'
              ? 'var(--tandem-accent)'
              : 'var(--tandem-fg-muted)'};"
          >
            {reply.author === "claude" ? "Claude" : "You"}
          </span>
          <span style="font-size: 10px; color: var(--tandem-fg-subtle);">
            {#if reply.editedAt}
              <span style="font-style: italic; margin-right: 4px;">(edited)</span>
            {/if}
            {formatTime(reply.timestamp)}
          </span>
        </div>
        <p style="margin: 0; color: var(--tandem-fg);">{reply.text}</p>
      </div>
    {/each}
  </div>
{/if}
