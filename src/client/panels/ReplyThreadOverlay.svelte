<script lang="ts">
import { untrack } from "svelte";
import type { Annotation, AnnotationReply } from "../../shared/types";
import { getVisibleReplies } from "../annotations/replies";
import { portal } from "../utils/portal.js";
import CommentThread from "./CommentThread.svelte";
import { SECONDARY_BUTTON_STYLE, TEXTAREA_STYLE } from "./panel-styles";

interface Props {
  open: boolean;
  annotation: Annotation;
  replies: AnnotationReply[];
  /** Reuse the existing reply write path; never create a new one. */
  onReply?: (id: string, text: string) => Promise<boolean>;
  onClose: () => void;
}

let { open, annotation, replies, onReply, onClose }: Props = $props();

// Single source of truth for visibility — note/highlight return []
// so the overlay never renders content for private annotations even if
// callers pass non-empty `replies` by accident.
const visibleReplies = $derived(getVisibleReplies(annotation, replies));

let dialogEl: HTMLElement | null = $state(null);
let replyTextareaEl: HTMLTextAreaElement | null = $state(null);
let prevFocus: Element | null = null;

let isReplying = $state(false);
let replyText = $state("");
let isSendingReply = $state(false);

const hasText = $derived(Boolean(replyText.trim()));

// Focus trap mirrored from HelpModal.svelte — untrack `dialogEl` so the
// bind:this write doesn't re-run this effect and restore focus mid-open.
$effect(() => {
  if (!open) return;
  const el = untrack(() => dialogEl);
  if (!el) return;
  prevFocus = document.activeElement;
  el.focus();
  const onFocusIn = (e: FocusEvent) => {
    if (el && !el.contains(e.target as Node)) el.focus();
  };
  document.addEventListener("focusin", onFocusIn);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    if (prevFocus instanceof HTMLElement && document.contains(prevFocus)) prevFocus.focus();
  };
});

// ESC handling is dialog-scoped via `handleTabTrap` on the dialog element.
// A second window-level listener fired twice on ESC and caused noisy
// behavior in nested dialogs; the dialog has focus while open (focus trap
// above) so dialog-scoped capture is sufficient.

// Reset internal reply-composer state on close so a stale draft doesn't
// reappear next time the overlay opens.
$effect(() => {
  if (!open) {
    isReplying = false;
    replyText = "";
    isSendingReply = false;
  }
});

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
  if (!trimmed || isSendingReply || !onReply) return;
  isSendingReply = true;
  try {
    const ok = await onReply(annotation.id, trimmed);
    if (ok !== false) {
      replyText = "";
      isReplying = false;
    }
  } finally {
    isSendingReply = false;
  }
}

function handleTabTrap(e: KeyboardEvent) {
  if (e.key === "Escape") {
    onClose();
    return;
  }
  e.stopPropagation();
  if (e.key !== "Tab" || !dialogEl) return;
  const focusable = Array.from(
    dialogEl.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.closest("[hidden]"));
  if (focusable.length === 0) {
    e.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
</script>

{#if open}
  <!-- Backdrop. role="presentation" + click-outside dismiss. Per
       feedback_click_outside_exempt_menu: dialog stops propagation,
       so clicks inside the overlay container never reach the backdrop.
       use:portal moves the overlay to <body>: this component renders inside the
       right-rail wrapper (position: relative; z-index: 1; overflow: hidden), so
       a fixed descendant's z-index would resolve within that z:1 context and
       still stack below the title bar's lift. Portaling to the root context lets
       --tandem-z-above-titlebar actually cover the title bar. Dismiss is
       backdrop-target/propagation based (not el.contains), so the move is safe. -->
  <div
    use:portal
    role="presentation"
    data-testid="reply-thread-overlay"
    onclick={onClose}
    onkeydown={() => {}}
    style="position: fixed; inset: 0; background-color: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; z-index: var(--tandem-z-above-titlebar);"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reply thread"
      tabindex="-1"
      bind:this={dialogEl}
      onclick={(e) => e.stopPropagation()}
      onkeydown={handleTabTrap}
      style="background-color: var(--tandem-surface); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-4); box-shadow: var(--tandem-shadow-3); padding: var(--tandem-space-4) var(--tandem-space-5); width: 520px; max-width: 90vw; max-height: 80vh; overflow-y: auto; display: flex; flex-direction: column; gap: var(--tandem-space-3);"
    >
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <h2 style="margin: 0; font-size: var(--tandem-text-lg); font-weight: 600; color: var(--tandem-fg);">
          Reply thread
          <span style="font-weight: 400; color: var(--tandem-fg-subtle); font-size: var(--tandem-text-sm); margin-left: var(--tandem-space-2);">
            ({visibleReplies.length}
            {visibleReplies.length === 1 ? "reply" : "replies"})
          </span>
        </h2>
        <button
          type="button"
          data-testid="reply-thread-overlay-close"
          onclick={onClose}
          aria-label="Close reply thread"
          style="background: none; border: none; cursor: pointer; font-size: 18px; color: var(--tandem-fg-muted); line-height: 1; padding: 2px 6px; border-radius: var(--tandem-r-2);"
        >
          ✕
        </button>
      </div>

      <!-- Original comment context -->
      <div
        style="padding: var(--tandem-space-2) var(--tandem-space-3); background: var(--tandem-surface-muted); border-radius: var(--tandem-r-2); border-left: 3px solid var(--tandem-author-claude); font-size: var(--tandem-text-sm); color: var(--tandem-fg-muted); white-space: pre-wrap;"
      >
        {annotation.content}
      </div>

      <!-- Thread body -->
      {#if visibleReplies.length === 0}
        <p style="margin: 0; font-size: var(--tandem-text-sm); color: var(--tandem-fg-subtle);">
          No replies yet.
        </p>
      {:else}
        <CommentThread replies={visibleReplies} />
      {/if}

      <!-- Reply composer (reuses the same onReply write path; no new HTTP/MCP) -->
      {#if onReply}
        <div style="border-top: 1px solid var(--tandem-border); padding-top: var(--tandem-space-3);">
          {#if isReplying}
            <textarea
              bind:this={replyTextareaEl}
              bind:value={replyText}
              data-testid="reply-thread-overlay-input"
              onkeydown={handleReplyKeyDown}
              placeholder="Write a reply..."
              style={TEXTAREA_STYLE}
            ></textarea>
            <div style="display: flex; gap: var(--tandem-space-2); margin-top: var(--tandem-space-2);">
              <button
                type="button"
                data-testid="reply-thread-overlay-send"
                onclick={handleSendReply}
                disabled={!hasText || isSendingReply}
                style="padding: 4px 10px; font-size: var(--tandem-text-xs); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-1); background: {hasText
                  ? 'var(--tandem-accent-bg)'
                  : 'var(--tandem-surface-muted)'}; color: {hasText
                  ? 'var(--tandem-accent-fg-strong)'
                  : 'var(--tandem-fg-subtle)'}; cursor: {hasText && !isSendingReply ? 'pointer' : 'default'};"
              >
                Send
              </button>
              <button
                type="button"
                data-testid="reply-thread-overlay-cancel"
                onclick={() => {
                  isReplying = false;
                  replyText = "";
                }}
                style={SECONDARY_BUTTON_STYLE}
              >
                Cancel
              </button>
            </div>
          {:else}
            <button
              type="button"
              data-testid="reply-thread-overlay-reply"
              onclick={() => (isReplying = true)}
              style={SECONDARY_BUTTON_STYLE}
            >
              Reply
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}
