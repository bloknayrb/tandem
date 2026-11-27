<script lang="ts">
import { untrack } from "svelte";
import { type CompareResult, compareDocument, comparisonLabel } from "../utils/backups.js";
import { trapTab } from "../utils/focus-trap.js";
import DiffView from "./DiffView.svelte";

/**
 * Compare the file on disk with the document now (ADR-057, PR 4), opened from
 * the "changed on disk" banner, so the user can see what Keep or Reload would
 * mean before choosing. Read-only; open while `documentId` is set.
 */

interface Props {
  documentId: string | null;
  fileName: string;
  onClose: () => void;
}

const { documentId, fileName, onClose }: Props = $props();

const open = $derived(documentId !== null);
let result = $state<CompareResult | null>(null);
let dialogEl: HTMLElement | null = $state(null);
let prevFocus: Element | null = null;
let seq = 0;

$effect(() => {
  if (documentId === null) return;
  const forDoc = documentId;
  const mine = ++seq;
  untrack(() => {
    result = null;
  });
  void compareDocument(forDoc, "disk").then((r) => {
    if (mine === seq) result = r;
  });
});

// Focus: into the dialog on open, back where it was on close.
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

// Capture phase + stopPropagation, as HelpModal: the app's Escape never sees it.
$effect(() => {
  if (!open) return;
  const handler = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  window.addEventListener("keydown", handler, { capture: true });
  return () => window.removeEventListener("keydown", handler, { capture: true });
});
</script>

{#if open}
  <div role="presentation" class="modal-backdrop" onclick={onClose}>
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="compare-title"
      tabindex="-1"
      bind:this={dialogEl}
      class="compare-modal"
      data-testid="compare-modal"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => {
        e.stopPropagation();
        trapTab(e, dialogEl);
      }}
    >
      <header class="modal-header">
        <h2 id="compare-title">Compare with the file on disk: {fileName}</h2>
        <button
          type="button"
          class="modal-close"
          data-testid="compare-close"
          onclick={onClose}
          aria-label="Close compare"
        >
          ×
        </button>
      </header>
      <div class="modal-content">
        {#if result === null}
          <p class="state">Comparing…</p>
        {:else if !result.ok}
          <p class="state state--error" data-testid="compare-error">{result.message}</p>
        {:else}
          <DiffView
            current={result.comparison.current}
            other={result.comparison.other}
            otherLabel={comparisonLabel(result.comparison.otherLabel)}
            truncated={result.comparison.truncated}
          />
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--tandem-bg) 70%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--tandem-z-above-titlebar);
  }

  .compare-modal {
    width: min(820px, 94vw);
    max-height: min(86vh, 820px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background-color: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-5);
    box-shadow: var(--tandem-shadow-3);
  }

  .modal-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--tandem-space-4);
    padding: 20px 24px 14px;
    border-bottom: 1px solid var(--tandem-border);
  }

  .modal-header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--tandem-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .modal-close {
    background: none;
    border: 1px solid transparent;
    cursor: pointer;
    color: var(--tandem-fg-subtle);
    font-size: 18px;
    line-height: 1;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    padding: 0;
    border-radius: var(--tandem-r-2);
    flex: 0 0 auto;
  }
  .modal-close:hover,
  .modal-close:focus-visible {
    color: var(--tandem-fg);
    background: var(--tandem-surface-sunk);
    outline: none;
  }

  .modal-content {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 24px 24px;
  }

  .state {
    margin: 0;
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg-muted);
  }
  .state--error {
    color: var(--tandem-error-fg-strong);
  }
</style>
