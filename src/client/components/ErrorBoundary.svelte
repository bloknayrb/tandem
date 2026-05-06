<script lang="ts">
/**
 * App-root error boundary with capped in-place recovery (#507).
 *
 * On render-time errors (including throws inside `$effect`), the failed
 * snippet shows a "Try to recover" button that calls `<svelte:boundary>`'s
 * `reset()` to re-attempt the children. Capped at MAX_RECOVERY_ATTEMPTS
 * consecutive failures per error session. The `SuccessHook` sentinel
 * mounts in the success branch and resets the counter on each successful
 * recovery so a new, unrelated error gets a fresh budget. `errorSessionId`
 * keys the alert div so screen readers re-announce on each fresh failure.
 */
import type { Snippet } from "svelte";
import {
  ERROR_BOUNDARY_RECOVER_BTN_TESTID,
  ERROR_BOUNDARY_RELOAD_BTN_TESTID,
  MAX_RECOVERY_ATTEMPTS,
} from "./errorBoundaryConstants";
import SuccessHook from "./SuccessHook.svelte";

interface Props {
  children: Snippet;
}

let { children }: Props = $props();

let attempts = $state(0);
let errorSessionId = $state(0);
</script>

<svelte:boundary
  onerror={() => {
    errorSessionId += 1;
  }}
>
  {@render children()}
  <!-- MUST stay AFTER children so a throwing child effect aborts the flush
       before this hook's effect runs. See SuccessHook.svelte. -->
  <SuccessHook
    onSuccess={() => {
      attempts = 0;
    }}
  />

  {#snippet failed(error: unknown, reset: () => void)}
    {#key errorSessionId}
      <div role="alert" class="error-boundary">
        <h2>Something went wrong</h2>
        <p class="message">
          {attempts >= MAX_RECOVERY_ATTEMPTS
            ? "Recovery attempts exhausted. Reload the page to continue."
            : "The editor encountered an unexpected error."}
        </p>
        <pre class="detail">{error instanceof Error ? error.message : String(error)}</pre>
        {#if attempts < MAX_RECOVERY_ATTEMPTS}
          <button
            data-testid={ERROR_BOUNDARY_RECOVER_BTN_TESTID}
            class="btn btn-primary"
            onclick={() => {
              attempts += 1;
              reset();
            }}
          >
            Try to recover
          </button>
        {/if}
        <button
          data-testid={ERROR_BOUNDARY_RELOAD_BTN_TESTID}
          class="btn btn-secondary"
          onclick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    {/key}
  {/snippet}
</svelte:boundary>

<style>
.error-boundary {
  padding: var(--tandem-space-6);
  background: var(--tandem-error-bg);
  border: 1px solid var(--tandem-error-border);
  border-radius: var(--tandem-r-2);
  color: var(--tandem-fg);
}

.error-boundary h2 {
  color: var(--tandem-error-fg-strong);
}

.message {
  color: var(--tandem-fg-muted);
}

.detail {
  background: var(--tandem-surface-muted);
  padding: var(--tandem-space-4);
  border-radius: var(--tandem-r-2);
  font-size: var(--tandem-text-sm);
  overflow: auto;
  max-height: 200px;
  color: var(--tandem-fg);
  border: 1px solid var(--tandem-border);
  margin: 0 0 var(--tandem-space-4);
}

.btn {
  padding: var(--tandem-space-2) var(--tandem-space-4);
  border-radius: var(--tandem-r-2);
  cursor: pointer;
}

.btn-primary {
  margin-right: var(--tandem-space-2);
  border: 1px solid var(--tandem-accent);
  background: var(--tandem-accent);
  color: var(--tandem-accent-fg);
}

.btn-secondary {
  border: 1px solid var(--tandem-border-strong);
  background: var(--tandem-surface);
  color: var(--tandem-fg);
}
</style>
