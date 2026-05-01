<script lang="ts">
  import { formatCoworkError, writeCoworkOnboardingSkipped } from "../cowork/cowork-helpers";
  import { coworkToggleIntegration, type InvokeFn, loadInvoke } from "../cowork/cowork-invoke";
  import type { CoworkStatus } from "../types";

  interface Props {
    status: CoworkStatus;
    onAdvance: () => void;
    onLearnMore?: () => void;
  }

  let { status, onAdvance, onLearnMore }: Props = $props();

  const primaryBtnStyle =
    "padding: 4px 10px; font-size: 12px; border: 1px solid var(--tandem-accent); border-radius: 4px; background: var(--tandem-accent); color: var(--tandem-accent-fg); cursor: pointer; font-weight: 600;";
  const secondaryBtnStyle =
    "padding: 4px 10px; font-size: 12px; border: 1px solid var(--tandem-border-strong); border-radius: 4px; background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: pointer;";

  let confirming = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function withInvoke(op: (invoke: InvokeFn) => Promise<void>, errorPrefix: string): Promise<boolean> {
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

<div
  data-testid="cowork-onboarding-step"
  style="display: flex; flex-direction: column; gap: 8px;"
>
  <div style="font-size: 14px; font-weight: 600; color: var(--tandem-fg);">
    Claude Desktop Cowork detected
  </div>
  <div style="font-size: 13px; line-height: 1.5; color: var(--tandem-fg-muted);">
    Enable Tandem inside Cowork workspaces?
    {#if status.vethernetCidr !== null}
      Detected VM subnet: <code>{status.vethernetCidr}</code>.
    {/if}
  </div>

  {#if error}
    <div
      data-testid="cowork-onboarding-error"
      role="alert"
      style="font-size: 12px; color: var(--tandem-error-fg-strong); background: var(--tandem-error-bg); border: 1px solid var(--tandem-error-border); border-radius: 4px; padding: 6px 8px;"
    >
      {error}
    </div>
  {/if}

  {#if confirming}
    <div
      data-testid="cowork-onboarding-confirm"
      style="font-size: 12px; color: var(--tandem-warning-fg-strong); background: var(--tandem-warning-bg); border: 1px solid var(--tandem-warning-border); border-radius: 4px; padding: 8px 10px;"
    >
      <div style="font-weight: 600; margin-bottom: 6px;">Confirm: Enable Cowork</div>
      <div style="margin-bottom: 8px;">
        Windows will prompt for admin permission to modify firewall rules. This is expected.
      </div>
      <div style="display: flex; gap: 8px;">
        <button
          data-testid="cowork-onboarding-enable-confirm-btn"
          type="button"
          onclick={() => void handleEnable()}
          disabled={busy}
          style={primaryBtnStyle}
        >
          Enable
        </button>
        <button
          data-testid="cowork-onboarding-enable-cancel-btn"
          type="button"
          onclick={() => { confirming = false; }}
          disabled={busy}
          style={secondaryBtnStyle}
        >
          Cancel
        </button>
      </div>
    </div>
  {:else}
    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
      <button
        data-testid="cowork-onboarding-enable-btn"
        type="button"
        onclick={() => { confirming = true; }}
        disabled={busy}
        style={primaryBtnStyle}
      >
        Enable
      </button>
      <button
        data-testid="cowork-onboarding-skip-btn"
        type="button"
        onclick={handleSkip}
        disabled={busy}
        style={secondaryBtnStyle}
      >
        Skip
      </button>
      {#if onLearnMore}
        <button
          data-testid="cowork-onboarding-learn-more-btn"
          type="button"
          onclick={onLearnMore}
          disabled={busy}
          style={secondaryBtnStyle}
        >
          Learn more
        </button>
      {:else}
        <a
          data-testid="cowork-onboarding-learn-more-link"
          href="https://github.com/bloknayrb/tandem#cowork"
          target="_blank"
          rel="noreferrer"
          style="font-size: 12px; color: var(--tandem-accent); align-self: center; text-decoration: underline;"
        >
          Learn more
        </a>
      {/if}
    </div>
  {/if}
</div>
