<script lang="ts">
import { onDestroy } from "svelte";
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";

interface Props {
  annotationId: string;
  annotationType?: string;
  isPending: boolean;
  isEditing: boolean;
  undoable?: boolean;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => boolean;
  onRemove?: (id: string) => void;
  onSendToClaude?: (id: string) => void;
}

let {
  annotationId,
  annotationType,
  isPending,
  isEditing,
  undoable,
  onAccept,
  onDismiss,
  onUndo,
  onRemove,
  onSendToClaude,
}: Props = $props();

const agentLabel = createAgentLabel();

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
  <div class="aca-row">
    {#if onAccept}
      <button
        data-testid="accept-btn-{annotationId}"
        class="aca-btn aca-btn--accept"
        onclick={(e) => {
          e.stopPropagation();
          onAccept!(annotationId);
        }}
      >
        Accept
      </button>
    {/if}
    {#if onDismiss}
      <button
        data-testid="dismiss-btn-{annotationId}"
        class="aca-btn aca-btn--reject"
        onclick={(e) => {
          e.stopPropagation();
          onDismiss!(annotationId);
        }}
      >
        Reject
      </button>
    {/if}
  </div>
{:else if isPending && !isEditing && annotationType === "note"}
  <div class="aca-row">
    {#if onRemove}
      <button
        data-testid="archive-btn-{annotationId}"
        class="aca-btn aca-btn--ghost"
        onclick={(e) => {
          e.stopPropagation();
          onRemove!(annotationId);
        }}
      >
        Archive
      </button>
    {/if}
    {#if onSendToClaude}
      <button
        data-testid="send-to-claude-btn-{annotationId}"
        class="aca-btn aca-btn--send"
        onclick={(e) => {
          e.stopPropagation();
          onSendToClaude!(annotationId);
        }}
      >
        <span class="aca-dest" aria-hidden="true"></span>
        Send to {agentLabel.family}
      </button>
    {/if}
  </div>
{:else if isPending && !isEditing && onRemove}
  <button
    data-testid="remove-btn-{annotationId}"
    class="aca-btn aca-btn--ghost aca-standalone"
    onclick={(e) => {
      e.stopPropagation();
      onRemove!(annotationId);
    }}
  >
    Remove
  </button>
{:else if !isPending && undoable && onUndo}
  <div class="aca-undo-row">
    <button data-testid="undo-btn" class="aca-undo" onclick={handleUndo}>
      Undo
    </button>
    {#if undoError}
      <div class="aca-undo-error">
        Can't undo — text has changed.
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Action-row family. All variants share the pill recipe (4×12, r-pill,
     text-xs); per-variant tokens carry the accept/reject/ghost/send semantic
     so the row reads as a coherent set. Hover/:focus-visible states only
     expressible in a <style> block. */
  .aca-row {
    display: flex;
    gap: 4px;
    margin-top: 4px;
  }
  .aca-btn {
    padding: 4px 12px;
    font-size: var(--tandem-text-xs);
    border: 1px solid var(--tandem-border-strong);
    border-radius: var(--tandem-r-pill);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, transform 120ms var(--tandem-ease-out);
  }
  /* A1 (Phase 4 / #798) — quick press-in on commit. */
  .aca-btn:active {
    transform: scale(0.96);
  }
  .aca-standalone {
    margin-top: 4px;
  }
  .aca-btn--accept {
    background: var(--tandem-success-bg);
    color: var(--tandem-success-fg-strong);
  }
  .aca-btn--reject {
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
  }
  .aca-btn--ghost {
    background: var(--tandem-surface-muted);
    color: var(--tandem-fg-muted);
  }
  .aca-btn--ghost:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  /* #1444: colour-neutral, converging on the ghost treatment next to it — the
     accent fill contradicted the composer's coral one for the same action, and
     neither audience is recommended, so neither gets a recommending colour.
     Deliberately NOT folded into .aca-btn--ghost, which is also the standalone
     Remove button on four differently-tinted card types.

     The accent `border-color` is DELETED rather than overridden: .aca-btn's
     :focus-visible below sets that same token as its only signal, so while Send
     carried it at rest, focusing Send produced no visual change at all.

     The flex properties are scoped here, not on .aca-btn — Accept, Reject,
     Archive and Remove share that base and none of them needs to become a flex
     container. `justify-content` is required rather than decorative: <button>'s
     UA text-align stops applying once the element is a flex container. */
  .aca-btn--send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: var(--tandem-surface-muted);
    color: var(--tandem-fg);
  }
  /* Background only — unlike --ghost, rest is already --tandem-fg, so hover
     re-stating the colour would be a no-op. */
  .aca-btn--send:hover {
    background: var(--tandem-surface-sunk);
  }
  /* Twin of .composer-dest in Toolbar.svelte — see the long comment there for
     why the shape (not the colour) is what survives forced colors, why 10px,
     and why the colour is a literal rather than agentColor(). Declared here
     rather than shared because Svelte prunes scoped selectors per component.
     This card renders a lone disc, so the shape reinforces the label rather
     than distinguishing two markers; the composer is where the pair reads. */
  .aca-dest {
    box-sizing: border-box;
    width: 10px;
    height: 10px;
    border-radius: var(--tandem-r-circle);
    border: 2px solid var(--tandem-author-claude);
    background: var(--tandem-author-claude);
    flex-shrink: 0;
  }
  .aca-btn:focus-visible {
    outline: none;
    border-color: var(--tandem-accent-border);
  }
  @media (prefers-reduced-motion: reduce) {
    .aca-btn {
      transition: none;
    }
    .aca-btn:active {
      transform: none;
    }
  }
  :global(body.tandem-reduce-motion) .aca-btn {
    transition: none;
  }
  :global(body.tandem-reduce-motion) .aca-btn:active {
    transform: none;
  }

  .aca-undo-row {
    margin-top: 4px;
  }
  .aca-undo {
    padding: 1px 6px;
    font-size: var(--tandem-text-xs);
    border: none;
    background: none;
    color: var(--tandem-accent);
    cursor: pointer;
    text-decoration: underline;
  }
  .aca-undo-error {
    font-size: var(--tandem-text-xs);
    color: var(--tandem-error-fg-strong);
    margin-top: 2px;
  }
</style>
