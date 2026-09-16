<script lang="ts">
import type { Annotation, AnnotationReply } from "../../shared/types";
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import { agentTintColor } from "../utils/agent-color";
import AnnotationBody from "./AnnotationBody.svelte";
import { formatRelativeTime } from "./annotation-card-helpers";

interface Props {
  replies: AnnotationReply[];
  /**
   * The parent. #1626 needs it for two things: the `type === "comment"` gate on
   * the suggestion box, and the id the accept callback takes (a reply's
   * proposal is over the PARENT's range).
   */
  annotation: Annotation;
  isPending: boolean;
  /** Whether this card's accept affordance is offered at all (SidePanel's gate). */
  canAccept: boolean;
  onAcceptReplySuggestion?: (annotationId: string, replyId: string) => void;
}

let { replies, annotation, isPending, canAccept, onAcceptReplySuggestion }: Props = $props();

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
        <div class="ct-body"><AnnotationBody text={reply.text} author={reply.author} /></div>
        <!--
          #1626: a reply may carry a refined replacement proposal over the
          PARENT's range. Gated on `type === "comment"` in ADDITION to the field
          being present: `getVisibleReplies` empties only highlights, so this
          component is the shared renderer for NOTE threads too. No reply written
          through today's guarded seam can be a note's, but reply records arrive
          over a Y.Map any connected client can write — without the gate a future
          writer would surface an Accept button inside a private note thread.
        -->
        {#if annotation.type === "comment" && reply.suggestedText !== undefined}
          <div class="ct-suggestion" data-testid="reply-suggestion-{reply.id}">
            {reply.suggestedText}
          </div>
          {#if isPending && canAccept && onAcceptReplySuggestion}
            <button
              type="button"
              class="ct-accept"
              data-testid="accept-reply-btn-{reply.id}"
              onclick={(e) => {
                e.stopPropagation();
                onAcceptReplySuggestion?.(annotation.id, reply.id);
              }}
            >
              Accept replacement
            </button>
          {/if}
        {/if}
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
  /* #1626: the proposed replacement, shown as text rather than a word-diff.
     Sharing SuggestionCard's diff box would mean extracting it, and a
     prop-built testid prefix there collapses two snapshot entries into one —
     a Critical Rule 7 removal. The parent card already shows the original span
     via AnnotationSnippet. */
  .ct-suggestion {
    margin-top: 4px;
    padding: 4px 8px;
    border-radius: var(--tandem-r-2);
    background: var(--tandem-suggestion-bg);
    border: 1px solid var(--tandem-suggestion-border);
    color: var(--tandem-suggestion-fg-strong);
    white-space: pre-wrap;
  }
  .ct-accept {
    margin-top: 4px;
    padding: 2px 8px;
    font-size: var(--tandem-text-xs);
    border: 1px solid var(--tandem-border-strong);
    border-radius: var(--tandem-r-1);
    background: var(--tandem-accent-bg);
    color: var(--tandem-accent-fg-strong);
    cursor: pointer;
  }
</style>
