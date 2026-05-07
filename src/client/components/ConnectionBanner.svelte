<script lang="ts">
interface Props {
  onDismiss: () => void;
  onRetry: () => void;
}

let { onDismiss, onRetry }: Props = $props();
</script>

<div
  data-testid="connection-banner"
  style="padding: var(--tandem-space-2) var(--tandem-space-4); background: var(--tandem-error-bg); border-bottom: 1px solid var(--tandem-error-border); font-size: var(--tandem-text-base); color: var(--tandem-error-fg-strong); text-align: center; display: flex; justify-content: center; align-items: center; gap: var(--tandem-space-3);"
>
  <span>Connection to the Tandem server has been lost. Ensure the server is running.</span>
  <button
    data-testid="connection-banner-retry"
    onclick={onRetry}
    style="background: none; border: 1px solid var(--tandem-error-border); border-radius: var(--tandem-r-2); cursor: pointer; color: var(--tandem-error-fg-strong); font-size: var(--tandem-text-sm); padding: 2px var(--tandem-space-2);"
  >
    Retry now
  </button>
  <button
    onclick={onDismiss}
    style="background: none; border: none; cursor: pointer; color: var(--tandem-error-fg-strong); font-size: 16px; line-height: 1; padding: 0 4px;"
    aria-label="Dismiss connection banner"
  >
    ×
  </button>
</div>
