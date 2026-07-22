<script lang="ts">
import type { AnnotationReply } from "../../shared/types";
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import { agentTintColor } from "../utils/agent-color";
import { formatRelativeTime } from "./annotation-card-helpers";

interface Props {
  replies: AnnotationReply[];
}

let { replies }: Props = $props();

const agentLabel = createAgentLabel();
</script>

{#if replies.length > 0}
  <div class="ct-root" data-testid="comment-thread">
    {#each replies as reply (reply.id)}
      {@const kind =
        reply.author === "claude" ? "claude" : reply.author === "import" ? "import" : "user"}
      <!-- #1123 M4: per-agent color override, applied ONLY when a local-model
           reply carries an agentIdentity. Absent (dark / real-Claude) ⇒ no inline
           style ⇒ the CSS class's --tandem-author-claude renders unchanged. -->
      {@const agentTint = agentTintColor(reply.agentIdentity)}
      <div class="ct-reply" data-testid="reply-{reply.id}">
        <div class="ct-reply-head">
          <span
            class="ct-author"
            class:is-claude={kind === "claude"}
            class:is-import={kind === "import"}
            class:is-user={kind === "user"}
            style={kind === "claude" && agentTint ? `color: ${agentTint};` : undefined}
          >
            {#if kind === "claude"}
              <span
                class="ct-author-dot ct-author-dot--claude"
                style={agentTint ? `background: ${agentTint};` : undefined}
                aria-hidden="true"
              ></span>
              <!-- #1123 M3: a local-model reply bylines with its specific model
                   name, matching the card + chat surfaces; else the active
                   family label. Dark ⇒ agentIdentity absent ⇒ family label. -->
              {reply.agentIdentity?.displayName ?? agentLabel.family}
            {:else if kind === "import"}
              <span data-testid="reply-import-byline-{reply.id}">
                {reply.importAuthor ?? "Imported"}
              </span>
            {:else}
              <span class="ct-author-dot ct-author-dot--user" aria-hidden="true"></span>
              You
            {/if}
          </span>
          <span class="ct-time">
            {#if reply.editedAt}
              <span class="ct-edited">(edited)</span>
            {/if}
            {formatRelativeTime(reply.timestamp)}
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
  /* Imports carry no authorship color/dot — matches AnnotationCardHeader and the
     ImportedCard byline (neutral subtle foreground). #1000. */
  .ct-author.is-import {
    color: var(--tandem-fg-subtle);
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
