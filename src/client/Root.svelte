<script lang="ts">
import App from "./App.svelte";
</script>

<svelte:boundary>
  <App />
  {#snippet failed(error: unknown)}
    <div style="padding: 2rem; font-family: system-ui, sans-serif; color: var(--tandem-fg);">
      <h2 style="margin: 0 0 0.5rem;">Something went wrong</h2>
      <p style="color: var(--tandem-fg-muted); margin: 0 0 1rem;">The editor encountered an unexpected error. Reload to continue.</p>
      <pre style="background: var(--tandem-surface-muted); padding: 1rem; border-radius: var(--tandem-r-2); font-size: 12px; overflow: auto; max-height: 200px; color: var(--tandem-fg); border: 1px solid var(--tandem-border); margin: 0 0 1rem;">{error instanceof Error ? error.message : String(error)}</pre>
      <button
        onclick={() => window.location.reload()}
        style="padding: 8px 16px; cursor: pointer; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); font-size: 14px;"
      >Reload</button>
    </div>
  {/snippet}
</svelte:boundary>
