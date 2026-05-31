<script lang="ts">
import type { AnnotationReply } from "../../shared/types";
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import { createTandemSettings } from "../hooks/useTandemSettings.svelte";

interface Props {
  replies: AnnotationReply[];
}

let { replies }: Props = $props();

const agentLabel = createAgentLabel(createTandemSettings());

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
  <div class="ct-root" data-testid="comment-thread">
    {#each replies as reply (reply.id)}
      <div class="ct-reply" data-testid="reply-{reply.id}">
        <div class="ct-reply-head">
          <span
            class="ct-author"
            class:is-claude={reply.author === "claude"}
            class:is-user={reply.author !== "claude"}
          >
            {#if reply.author === "claude"}
              <span class="ct-author-dot ct-author-dot--claude" aria-hidden="true"></span>
              {agentLabel.family}
            {:else}
              <span class="ct-author-dot ct-author-dot--user" aria-hidden="true"></span>
              You
            {/if}
          </span>
          <span class="ct-time">
            {#if reply.editedAt}
              <span class="ct-edited">(edited)</span>
            {/if}
            {formatTime(reply.timestamp)}
          </span>
        </div>
        <p class="ct-body">{reply.text}</p>
      </div>
    {/each}
  </div>
{/if}

<style>
  /* Reply thread — left-border timeline. Author labels carry the
     --tandem-author-{claude|user} tokens (cluster 3.3 decision #6) so they
     rhyme with the 6px author dot in the card header. The 4px author dot
     before each name reinforces the same visual without crowding the
     11px label. */
  .ct-root {
    margin-top: 6px;
    padding-left: 8px;
    border-left: 2px solid var(--tandem-border);
  }
  .ct-reply {
    padding: 4px 0;
    font-size: 12px;
    line-height: 1.4;
  }
  .ct-reply-head {
    display: flex;
    justify-content: space-between;
    margin-bottom: 2px;
  }
  .ct-author {
    font-weight: 600;
    font-size: 11px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .ct-author.is-claude {
    color: var(--tandem-author-claude);
  }
  .ct-author.is-user {
    color: var(--tandem-author-user);
  }
  .ct-author-dot {
    width: 4px;
    height: 4px;
    border-radius: var(--tandem-r-circle);
    flex-shrink: 0;
  }
  .ct-author-dot--claude {
    background: var(--tandem-author-claude);
  }
  .ct-author-dot--user {
    background: var(--tandem-author-user);
  }
  .ct-time {
    font-size: 10px;
    color: var(--tandem-fg-subtle);
  }
  .ct-edited {
    font-style: italic;
    margin-right: 4px;
  }
  .ct-body {
    margin: 0;
    color: var(--tandem-fg);
  }
</style>
