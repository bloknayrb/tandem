<script lang="ts">
interface Props {
  bulkConfirm: "accept" | "dismiss" | null;
  pendingCount: number;
  allPendingCount: number;
  onConfirmAccept: () => void;
  onConfirmDismiss: () => void;
  onCancel: () => void;
  onRequestAccept: () => void;
  onRequestDismiss: () => void;
  /** Bind to get a reference to the confirm button for programmatic focus. */
  confirmRef?: HTMLButtonElement | null;
}

let {
  bulkConfirm,
  pendingCount,
  allPendingCount,
  onConfirmAccept,
  onConfirmDismiss,
  onCancel,
  onRequestAccept,
  onRequestDismiss,
  confirmRef = $bindable(null),
}: Props = $props();

const isAccept = $derived(bulkConfirm === "accept");
const countLabel = $derived(
  pendingCount === allPendingCount
    ? `${pendingCount} annotations?`
    : `${pendingCount} of ${allPendingCount} pending?`,
);

const smallBtnBase =
  "padding: 2px 8px; font-size: var(--tandem-text-xs); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-1); cursor: pointer;";
</script>

{#if pendingCount > 1}
  <div
    style="padding: 6px var(--tandem-space-4); border-bottom: 1px solid var(--tandem-border); display: flex; gap: 4px; align-items: center;"
  >
    {#if bulkConfirm}
      <span style="font-size: var(--tandem-text-xs); color: var(--tandem-fg);">
        {isAccept ? "Accept" : "Reject"}
        {countLabel}
      </span>
      <button
        bind:this={confirmRef}
        data-testid="bulk-confirm-btn"
        onclick={isAccept ? onConfirmAccept : onConfirmDismiss}
        style="{smallBtnBase} background: {isAccept
          ? 'var(--tandem-success-bg)'
          : 'var(--tandem-error-bg)'}; color: {isAccept
          ? 'var(--tandem-success-fg-strong)'
          : 'var(--tandem-error-fg-strong)'}; font-weight: 600;"
      >
        Confirm
      </button>
      <button
        data-testid="bulk-cancel-btn"
        onclick={onCancel}
        style="{smallBtnBase} background: var(--tandem-surface); color: var(--tandem-fg-muted);"
      >
        Cancel
      </button>
    {:else}
      <button
        data-testid="bulk-accept-btn"
        onclick={onRequestAccept}
        style="{smallBtnBase} background: var(--tandem-success-bg); color: var(--tandem-success-fg-strong);"
      >
        Accept All ({pendingCount})
      </button>
      <button
        data-testid="bulk-dismiss-btn"
        onclick={onRequestDismiss}
        style="{smallBtnBase} background: var(--tandem-error-bg); color: var(--tandem-error-fg-strong);"
      >
        Reject All
      </button>
    {/if}
  </div>
{/if}
