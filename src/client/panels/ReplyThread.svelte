<script lang="ts">
import { untrack } from "svelte";
import type { Annotation, AnnotationReply } from "../../shared/types";
import { getVisibleReplies } from "../annotations/replies";
import CommentThread from "./CommentThread.svelte";
import { discloseUnfold } from "./cardMotion";
import { TEXTAREA_STYLE } from "./panel-styles";

interface Props {
  annotation: Annotation;
  replies: AnnotationReply[];
  isPending: boolean;
  isEditing: boolean;
  onReply?: (id: string, text: string) => Promise<boolean>;
  /** App reduce-motion setting; threaded from AnnotationCard (#798 A13). */
  reduceMotion?: boolean;
  /**
   * #999: monotonic nonce from the native context menu's Reply… item (via
   * AnnotationCard). A bump opens the composer; the mount value is ignored.
   */
  openNonce?: number;
}

let {
  annotation,
  replies,
  isPending,
  isEditing,
  onReply,
  reduceMotion = false,
  openNonce = 0,
}: Props = $props();

// Single client-display fan-out point. Notes show their (private) reply
// threads to the owning user (#1000); highlights never show replies. This is
// NOT the Claude privacy boundary — that is enforced server-side (the channel
// observer + `channelVisibleReplies` on the MCP read paths), so a note's
// private replies never reach Claude regardless of what is displayed here.
const visibleReplies = $derived(getVisibleReplies(annotation, replies));
const annotationId = $derived(annotation.id);
// Notes: always-visible thread (no collapse toggle); comments: A13 disclosure.
const isNote = $derived(annotation.type === "note");

// A13 (#798): the existing replies are a collapse-by-default disclosure (was an
// always-visible inline thread). Replaces the former portaled "Expand thread"
// overlay as the reply reader (Bryan decision 2026-06-01). Local view state
// only — never persisted, never read by Claude.
let open = $state(false);

let isReplying = $state(false);
let replyText = $state("");
let isSendingReply = $state(false);
let replyTextareaEl: HTMLTextAreaElement | null = $state(null);

const hasText = $derived(Boolean(replyText.trim()));

$effect(() => {
  if (isReplying) replyTextareaEl?.focus();
});

// #999: open the composer when the context-menu Reply… nonce bumps. Seeded from
// the mount value via untrack so it never auto-opens on mount; the existing
// focus effect above follows once isReplying flips true. A stale request while
// the composer can't render (resolved card / mid-edit) is a harmless no-op — the
// `{#if isPending && onReply && !isEditing}` guard simply won't mount it.
let lastOpenNonce = untrack(() => openNonce);
$effect(() => {
  if (openNonce === lastOpenNonce) return;
  lastOpenNonce = openNonce;
  isReplying = true;
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
  {#if isNote && visibleReplies.length > 0}
    <!-- Notes: always-visible thread (no toggle). Private from Claude, not from
         the owning user (#1000 / ADR-027). -->
    <div class="art-replies">
      <CommentThread replies={visibleReplies} />
    </div>
    {#if !isPending || !onReply}
      <!-- Read-only count badge when there's no reply affordance. -->
      <span class="art-note-count">
        {visibleReplies.length === 1 ? "1 reply" : `${visibleReplies.length} replies`}
      </span>
    {/if}
  {/if}

  {#if !isNote && visibleReplies.length > 0}
    <!-- A13 disclosure toggle: chevron rotates, replies unfold + cascade. -->
    <button
      type="button"
      data-testid="reply-toggle-{annotationId}"
      class="art-toggle"
      class:open
      aria-expanded={open}
      onclick={(e) => {
        e.stopPropagation();
        open = !open;
      }}
    >
      <span class="art-arrow" aria-hidden="true">›</span>
      {visibleReplies.length === 1 ? "1 reply" : `${visibleReplies.length} replies`}
    </button>
    <!-- Nesting the replies block inside the outer guard means `transition:discloseUnfold`
         only fires when `open` changes (user gesture), not when `visibleReplies.length`
         changes (data update). Without this structure, deleting the last reply while the
         disclosure is open would trigger an uninvited closing animation. -->
    {#if open}
      <div class="art-replies" transition:discloseUnfold={{ reduceMotion }}>
        <CommentThread replies={visibleReplies} />
      </div>
    {/if}
  {/if}

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
        <!-- For comments: count lives on the disclosure toggle above.
             For notes: embed count in the button since there's no toggle. -->
        <button
          data-testid="reply-btn-{annotationId}"
          onclick={() => (isReplying = true)}
          style="padding: 1px 4px; font-size: var(--tandem-text-xs); border: none; background: none; color: var(--tandem-fg-subtle); cursor: pointer;"
        >
          {isNote && visibleReplies.length > 0 ? `Reply (${visibleReplies.length})` : "Reply"}
        </button>
      {/if}
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

  /* Note read-only count badge — shown when there's no reply affordance. */
  .art-note-count {
    display: inline-block;
    margin-top: 4px;
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-subtle);
  }

  /* A13 disclosure toggle + rotating chevron (#798). */
  .art-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: 6px;
    padding: 1px 4px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-subtle);
  }
  .art-toggle:hover {
    color: var(--tandem-fg-muted);
  }
  .art-arrow {
    display: inline-block;
    transition: transform 220ms var(--tandem-ease-out);
  }
  .art-toggle.open .art-arrow {
    transform: rotate(90deg);
  }

  /* Per-reply cascade — fires on mount (the `{#if open}` block remounts
     CommentThread on every expand, so the @keyframes re-fires each time).
     Scoped under the local `.art-replies`, which exists only here, so the
     :global(.ct-reply) target can't leak to another surface. Stagger caps at
     the 4th reply so a long thread doesn't cascade for seconds. */
  .art-replies :global(.ct-reply) {
    animation: art-reply-cascade 220ms var(--tandem-ease-out) both;
  }
  .art-replies :global(.ct-reply:nth-child(2)) {
    animation-delay: 120ms;
  }
  .art-replies :global(.ct-reply:nth-child(3)) {
    animation-delay: 240ms;
  }
  .art-replies :global(.ct-reply:nth-child(n + 4)) {
    animation-delay: 360ms;
  }
  @keyframes art-reply-cascade {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }

  /* Dual reduced-motion guard. The arrow is a local element (media query +
     :global body-class ancestor); the cascade targets a child-component element
     so its body-class guard is a fully-global selector (a scoped `body.…` would
     be hashed and silently fail — the A9/A5 bite). `discloseUnfold` honors
     reduce-motion on the JS side (returns {duration:0}). End states stay intact
     under reduce-motion — the thread still shows when open, just instantly. */
  @media (prefers-reduced-motion: reduce) {
    .art-arrow {
      transition: none;
    }
    .art-replies :global(.ct-reply) {
      animation: none;
    }
  }
  :global(body.tandem-reduce-motion) .art-arrow {
    transition: none;
  }
  :global(body.tandem-reduce-motion .art-replies .ct-reply) {
    animation: none;
  }
</style>
