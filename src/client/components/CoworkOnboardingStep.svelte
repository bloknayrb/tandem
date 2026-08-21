<script lang="ts">
import { TANDEM_REPO_URL } from "../../shared/constants";
import {
  COWORK_PREFLIGHT_CHECKING,
  COWORK_PREFLIGHT_FAILED,
  formatCoworkError,
  writeCoworkOnboardingSkipped,
} from "../cowork/cowork-helpers";
import { coworkToggleIntegration, type InvokeFn, loadInvoke } from "../cowork/cowork-invoke";
import { createSubnetPreflight } from "../hooks/useCoworkPreflight.svelte";
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
// #1298: the enable path detects the Hyper-V subnet as its second step, and a
// failure there used to surface as a blanket "is Cowork set up on this
// machine?" — under a title, two lines above, that says it is. Probe first so
// we can say what is actually wrong instead of offering a button that cannot
// work.
//
// On confirm rather than on mount: the step mounts for every user with Cowork
// detected-but-off, including everyone who will hit Skip, and a mount-time
// answer can go stale before the click it exists to inform.
const probe = createSubnetPreflight();

function openConfirm(): void {
  confirming = true;
  void probe.run();
}

/** Leave the confirm, abandoning any probe still in flight. `reset()` is the
 *  only thing that clears `preflight`, so every exit must come through here. */
function closeConfirm(): void {
  confirming = false;
  probe.reset();
}

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

/**
 * The toggle's degraded-success warnings (#1438) are deliberately NOT rendered
 * here. This step advances out of itself on success, so a caveat shown at this
 * moment is discarded before it can be read — and the facts behind it are not
 * lost: they come back on every `cowork_get_status` as per-workspace
 * `WorkspaceStatus.fileStatus`, which the Cowork settings panel renders. The
 * defect #1438 describes — the caveat existing ONLY in a Tauri log — is closed
 * by the payload being structured and by that panel, not by a banner on a view
 * that is about to unmount.
 */
async function handleEnable(): Promise<void> {
  const ok = await withInvoke(async (invoke) => {
    await coworkToggleIntegration(invoke, true);
  }, "Failed to enable Cowork");
  if (ok) {
    // `run()` no longer clears `preflight`, so every path that leaves the
    // confirm owns the reset. Advancing is one of them: the step can be
    // returned to, and a stale hint would be waiting on arrival.
    closeConfirm();
    onAdvance();
  }
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
        Tandem will register itself as a plugin in every detected Cowork workspace so Claude in
        Cowork can reach your open documents. This adds a Windows firewall rule so the Cowork VM
        can connect back — admin is required once. To check it worked afterward, ask Claude in a
        Cowork session to open or list your documents.
      </div>
      <!-- #1376: mounted-before-populated, and the two children are additive.
           `useCoworkPreflight.svelte.ts` explains both and is the one place
           that should. -->
      <div role="status" data-testid="cowork-onboarding-preflight-live">
        {#if probe.preflight?.status === "blocked"}
          <!-- Say what stopped us and offer a retry, rather than an Enable button
               whose failure we have already observed. -->
          <div class="cos-preflight" data-testid="cowork-onboarding-preflight-blocked">
            {probe.preflight.hint}
          </div>
        {:else if probe.preflight?.status === "failed"}
          <!-- #1436: see the note in CoworkSettings. Hedged, and no retry —
               nothing was observed to fail, so Enable stays. -->
          <div class="cos-checking" data-testid="cowork-onboarding-preflight-failed">
            {COWORK_PREFLIGHT_FAILED}
          </div>
        {/if}
        {#if probe.probing}
          <div class="cos-checking">{COWORK_PREFLIGHT_CHECKING}</div>
        {/if}
      </div>
      <div class="cos-actions">
        {#if probe.preflight?.status === "blocked"}
          <button
            data-testid="cowork-onboarding-preflight-retry-btn"
            class="cos-btn cos-btn--primary"
            type="button"
            onclick={() => void probe.run()}
            disabled={busy || probe.probing}
          >
            {probe.probing ? "Checking…" : "Check again"}
          </button>
        {:else}
          <button
            data-testid="cowork-onboarding-enable-confirm-btn"
            class="cos-btn cos-btn--primary"
            type="button"
            onclick={() => void handleEnable()}
            disabled={busy}
          >
            Enable
          </button>
        {/if}
        <button
          data-testid="cowork-onboarding-enable-cancel-btn"
          class="cos-btn cos-btn--ghost"
          type="button"
          onclick={closeConfirm}
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
        onclick={openConfirm}
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
  .cos-preflight {
    font-size: 12px;
    line-height: 1.5;
    color: var(--tandem-warning-fg-strong);
    background: var(--tandem-warning-bg);
    border: 1px solid var(--tandem-warning-border);
    border-radius: var(--tandem-r-2);
    padding: 6px 8px;
    margin-bottom: 8px;
  }
  .cos-checking {
    font-size: 12px;
    color: var(--tandem-fg-muted);
    margin-bottom: 8px;
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
