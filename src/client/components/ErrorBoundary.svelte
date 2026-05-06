<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
  children: Snippet;
}

let { children }: Props = $props();

const MAX_RECOVERY_ATTEMPTS = 3;

let error = $state<unknown>(null);
let resetFn = $state<() => void>(() => {});
let attempts = $state(0);

function handleError(e: unknown, r: () => void) {
  error = e;
  resetFn = r;
}

function tryRecover() {
  // Counter tracks user-initiated recovery clicks, not raw error count, so
  // the cap reflects "three chances to recover". attempts persists across
  // the session — a new error after a recovered render still counts toward
  // the same cap, so a chronically unhealthy session forces a reload.
  attempts += 1;
  const fn = resetFn;
  error = null;
  fn();
}
</script>

<svelte:boundary onerror={handleError}>
  {@render children()}

  {#snippet failed(_e: unknown, _r: () => void)}
    <div
      role="alert"
      style="padding: 2rem; font-family: system-ui, sans-serif; color: var(--tandem-fg);"
    >
      <h2>Something went wrong</h2>
      <p style="color: var(--tandem-fg-muted);">
        {attempts >= MAX_RECOVERY_ATTEMPTS
          ? "Recovery attempts exhausted. Reload the page to continue."
          : "The editor encountered an unexpected error."}
      </p>
      <pre
        style="background: var(--tandem-surface-muted); padding: 1rem; border-radius: var(--tandem-r-2); font-size: 12px; overflow: auto; max-height: 200px; color: var(--tandem-fg); border: 1px solid var(--tandem-border); margin: 0 0 1rem;"
      >{error instanceof Error ? error.message : String(error)}</pre>
      {#if attempts < MAX_RECOVERY_ATTEMPTS}
        <button
          data-testid="error-boundary-recover-btn"
          onclick={tryRecover}
          style="margin-right: 0.5rem; padding: 8px 16px; cursor: pointer; border: 1px solid var(--tandem-accent); border-radius: var(--tandem-r-2); background: var(--tandem-accent); color: var(--tandem-accent-fg);"
        >
          Try to recover
        </button>
      {/if}
      <button
        data-testid="error-boundary-reload-btn"
        onclick={() => window.location.reload()}
        style="padding: 8px 16px; cursor: pointer; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg);"
      >
        Reload
      </button>
    </div>
  {/snippet}
</svelte:boundary>
