<script lang="ts">
import { onDestroy } from "svelte";

interface Props {
  annotationId: string;
  isPending: boolean;
  isEditing: boolean;
  undoable?: boolean;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => boolean;
  onRemove?: (id: string) => void;
}

let { annotationId, isPending, isEditing, undoable, onAccept, onDismiss, onUndo, onRemove }: Props =
  $props();

let undoError = $state(false);
let undoTimer: ReturnType<typeof setTimeout> | null = null;

function clearUndoTimer() {
  if (undoTimer) {
    clearTimeout(undoTimer);
    undoTimer = null;
  }
}

function handleUndo(e: MouseEvent) {
  e.stopPropagation();
  if (!onUndo) return;
  const ok = onUndo(annotationId);
  if (ok) {
    clearUndoTimer();
    undoError = false;
    return;
  }
  if (!ok) {
    undoError = true;
    clearUndoTimer();
    undoTimer = setTimeout(() => {
      undoError = false;
      undoTimer = null;
    }, 3000);
  }
}

onDestroy(clearUndoTimer);
</script>

{#if isPending && !isEditing && (onAccept || onDismiss)}
  <div style="display: flex; gap: 6px; margin-top: 6px;">
    {#if onAccept}
      <button
        data-testid="accept-btn-{annotationId}"
        onclick={(e) => {
          e.stopPropagation();
          onAccept!(annotationId);
        }}
        style="padding: 2px 8px; font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: 3px; background: var(--tandem-success-bg); color: var(--tandem-success-fg-strong); cursor: pointer;"
      >
        Accept
      </button>
    {/if}
    {#if onDismiss}
      <button
        data-testid="dismiss-btn-{annotationId}"
        onclick={(e) => {
          e.stopPropagation();
          onDismiss!(annotationId);
        }}
        style="padding: 2px 8px; font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: 3px; background: var(--tandem-error-bg); color: var(--tandem-error-fg-strong); cursor: pointer;"
      >
        Reject
      </button>
    {/if}
  </div>
{:else if isPending && !isEditing && onRemove}
  <button
    data-testid="remove-btn-{annotationId}"
    onclick={(e) => {
      e.stopPropagation();
      onRemove!(annotationId);
    }}
    style="margin-top: 6px; padding: 2px 8px; font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: 3px; background: var(--tandem-surface-muted); color: var(--tandem-fg-muted); cursor: pointer;"
  >
    Remove
  </button>
{:else if !isPending && undoable && onUndo}
  <div style="margin-top: 4px;">
    <button
      data-testid="undo-btn"
      onclick={handleUndo}
      style="padding: 1px 6px; font-size: 11px; border: none; background: none; color: var(--tandem-accent); cursor: pointer; text-decoration: underline;"
    >
      Undo
    </button>
    {#if undoError}
      <div style="font-size: 11px; color: var(--tandem-error-fg); margin-top: 2px;">
        Can't undo — text has changed.
      </div>
    {/if}
  </div>
{/if}
