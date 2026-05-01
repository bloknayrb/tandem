<script lang="ts">
/**
 * Svelte 5 port of `ErrorBoundary.tsx`.
 * Uses the native `<svelte:boundary>` element introduced in Svelte 5.
 */
import type { Snippet } from "svelte";

interface Props {
  children: Snippet;
}

let { children }: Props = $props();
</script>

<svelte:boundary>
  {@render children()}

  {#snippet failed(error: unknown, _reset: () => void)}
    <!-- _reset would attempt in-place re-render; full reload matches React original behavior -->
    <div style="padding: 2rem; font-family: system-ui, sans-serif; color: var(--tandem-fg);">
      <h2>Something went wrong</h2>
      <p style="color: var(--tandem-fg-muted);">
        The editor encountered an unexpected error. Reload the page to continue.
      </p>
      <pre
        style="background: var(--tandem-surface-muted); padding: 1rem; border-radius: 4px; font-size: 12px; overflow: auto; max-height: 200px; color: var(--tandem-fg); border: 1px solid var(--tandem-border);"
      >{error instanceof Error ? error.message : String(error)}</pre>
      <button
        onclick={() => window.location.reload()}
        style="margin-top: 1rem; padding: 8px 16px; cursor: pointer; border: 1px solid var(--tandem-border-strong); border-radius: 4px; background: var(--tandem-surface); color: var(--tandem-fg);"
      >
        Reload
      </button>
    </div>
  {/snippet}
</svelte:boundary>
