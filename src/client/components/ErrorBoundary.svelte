<script lang="ts">
import type { Snippet } from "svelte";
import {
  ERROR_BOUNDARY_RECOVER_BTN_TESTID,
  ERROR_BOUNDARY_RELOAD_BTN_TESTID,
  MAX_RECOVERY_ATTEMPTS,
} from "./errorBoundaryConstants";

interface Props {
  children: Snippet;
}

let { children }: Props = $props();

let attempts = $state(0);
</script>

<svelte:boundary>
  {@render children()}

  {#snippet failed(error: unknown, reset: () => void)}
    <div
      role="alert"
      style="padding: var(--tandem-space-6); color: var(--tandem-fg);"
    >
      <h2>Something went wrong</h2>
      <p style="color: var(--tandem-fg-muted);">
        {attempts >= MAX_RECOVERY_ATTEMPTS
          ? "Recovery attempts exhausted. Reload the page to continue."
          : "The editor encountered an unexpected error."}
      </p>
      <pre
        style="background: var(--tandem-surface-muted); padding: var(--tandem-space-4); border-radius: var(--tandem-r-2); font-size: var(--tandem-text-sm); overflow: auto; max-height: 200px; color: var(--tandem-fg); border: 1px solid var(--tandem-border); margin: 0 0 var(--tandem-space-4);"
      >{error instanceof Error ? error.message : String(error)}</pre>
      {#if attempts < MAX_RECOVERY_ATTEMPTS}
        <button
          data-testid={ERROR_BOUNDARY_RECOVER_BTN_TESTID}
          onclick={() => {
            attempts += 1;
            reset();
          }}
          style="margin-right: var(--tandem-space-2); padding: var(--tandem-space-2) var(--tandem-space-4); cursor: pointer; border: 1px solid var(--tandem-accent); border-radius: var(--tandem-r-2); background: var(--tandem-accent); color: var(--tandem-accent-fg);"
        >
          Try to recover
        </button>
      {/if}
      <button
        data-testid={ERROR_BOUNDARY_RELOAD_BTN_TESTID}
        onclick={() => window.location.reload()}
        style="padding: var(--tandem-space-2) var(--tandem-space-4); cursor: pointer; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg);"
      >
        Reload
      </button>
    </div>
  {/snippet}
</svelte:boundary>
