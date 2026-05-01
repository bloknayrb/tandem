<script lang="ts">
  interface Props {
    onDismiss: () => void;
  }

  let { onDismiss }: Props = $props();
</script>

<div
  style="padding: 8px 16px; background: var(--tandem-error-bg); border-bottom: 1px solid var(--tandem-error-border); font-size: 13px; color: var(--tandem-error-fg-strong); text-align: center; display: flex; justify-content: center; align-items: center; gap: 12px;"
>
  <span>Connection to the Tandem server has been lost. Ensure the server is running.</span>
  <button
    onclick={onDismiss}
    style="background: none; border: none; cursor: pointer; color: var(--tandem-error-fg-strong); font-size: 16px; line-height: 1; padding: 0 4px;"
    aria-label="Dismiss connection banner"
  >
    ×
  </button>
</div>
