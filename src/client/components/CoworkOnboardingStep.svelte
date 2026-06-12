<script lang="ts">
import { TANDEM_REPO_URL } from "../../shared/constants";
import { formatCoworkError, writeCoworkOnboardingSkipped } from "../cowork/cowork-helpers";
import { coworkToggleIntegration, type InvokeFn, loadInvoke } from "../cowork/cowork-invoke";
import type { CoworkStatus } from "../types";

interface Props {
  status: CoworkStatus;
  onAdvance: () => void;
  onLearnMore?: () => void;
}

let { status, onAdvance, onLearnMore }: Props = $props();

let confirming = $state(false);
let busy = $state(false);
let error = $state<string | null>(null);

async function withInvoke(
  op: (invoke: InvokeFn) => Promise<void>,
  errorPrefix: string,
): Promise<boolean> {
  busy = true;
  error = null;
  try {
    const invoke = await loadInvoke();
    await op(invoke);
    return true;
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const display = formatCoworkError(rawMsg);
    error = `${errorPrefix}: ${display}`;
    return false;
  } finally {
    busy = false;
  }
}

async function handleEnable(): Promise<void> {
  const ok = await withInvoke(async (invoke) => {
    await coworkToggleIntegration(invoke, true);
  }, "Failed to enable Cowork");
  if (ok) onAdvance();
}

function handleSkip(): void {
  writeCoworkOnboardingSkipped();
  onAdvance();
}
</script>

<div class="cos-root" data-testid="cowork-onboarding-step">
  <div class="cos-title">Claude Desktop Cowork detected</div>
  <div class="cos-description">
    Enable Tandem inside Cowork workspaces?
    {#if status.vethernetCidr !== null}
      Detected VM subnet: <code>{status.vethernetCidr}</code>.
    {/if}
  </div>

  {#if error}
    <div class="cos-error" data-testid="cowork-onboarding-error" role="alert">
      {error}
    </div>
  {/if}

  {#if confirming}
    <div class="cos-confirm-banner" data-testid="cowork-onboarding-confirm">
      <div class="cos-confirm-heading">Confirm: Enable Cowork</div>
      <div class="cos-confirm-body">
        Tandem will write plugin entries to every detected Cowork workspace so Claude running in
        Cowork can reach the documents you have open.
      </div>
      <div class="cos-actions">
        <button
          data-testid="cowork-onboarding-enable-confirm-btn"
          class="cos-btn cos-btn--primary"
          type="button"
          onclick={() => void handleEnable()}
          disabled={busy}
        >
          Enable
        </button>
        <button
          data-testid="cowork-onboarding-enable-cancel-btn"
          class="cos-btn cos-btn--ghost"
          type="button"
          onclick={() => { confirming = false; }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </div>
  {:else}
    <div class="cos-actions">
      <button
        data-testid="cowork-onboarding-enable-btn"
        class="cos-btn cos-btn--primary"
        type="button"
        onclick={() => { confirming = true; }}
        disabled={busy}
      >
        Enable
      </button>
      <button
        data-testid="cowork-onboarding-skip-btn"
        class="cos-btn cos-btn--ghost"
        type="button"
        onclick={handleSkip}
        disabled={busy}
      >
        Skip
      </button>
      {#if onLearnMore}
        <button
          data-testid="cowork-onboarding-learn-more-btn"
          class="cos-btn cos-btn--ghost"
          type="button"
          onclick={onLearnMore}
          disabled={busy}
        >
          Learn more
        </button>
      {:else}
        <a
          class="cos-learn-more-link"
          data-testid="cowork-onboarding-learn-more-link"
          href={`${TANDEM_REPO_URL}#cowork`}
          target="_blank"
          rel="noreferrer"
        >
          Learn more
        </a>
      {/if}
    </div>
  {/if}
</div>

<style>
  .cos-root {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .cos-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--tandem-fg);
  }
  .cos-description {
    font-size: 13px;
    line-height: 1.5;
    color: var(--tandem-fg-muted);
  }
  .cos-error {
    font-size: 12px;
    color: var(--tandem-error-fg-strong);
    background: var(--tandem-error-bg);
    border: 1px solid var(--tandem-error-border);
    border-radius: var(--tandem-r-2);
    padding: 6px 8px;
  }
  .cos-confirm-banner {
    font-size: 12px;
    color: var(--tandem-warning-fg-strong);
    background: var(--tandem-warning-bg);
    border: 1px solid var(--tandem-warning-border);
    border-radius: var(--tandem-r-2);
    padding: 8px 10px;
  }
  .cos-confirm-heading {
    font-weight: 600;
    margin-bottom: 6px;
  }
  .cos-confirm-body {
    margin-bottom: 8px;
  }
  .cos-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .cos-btn {
    padding: 4px 10px;
    font-size: 12px;
    border-radius: var(--tandem-r-2);
    cursor: pointer;
  }
  .cos-btn--primary {
    border: 1px solid var(--tandem-accent);
    background: var(--tandem-accent);
    color: var(--tandem-accent-fg);
    font-weight: 600;
  }
  .cos-btn--primary:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .cos-btn--ghost {
    border: 1px solid var(--tandem-border-strong);
    background: var(--tandem-surface);
    color: var(--tandem-fg-muted);
  }
  .cos-btn--ghost:hover:not(:disabled) {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .cos-btn--ghost:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .cos-learn-more-link {
    font-size: 12px;
    color: var(--tandem-accent);
    align-self: center;
    text-decoration: underline;
  }
</style>
