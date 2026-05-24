<script lang="ts">
/**
 * Integration setup wizard modal.
 *
 * Full-screen Svelte 5 modal driven by `createIntegrationWizard()`. All
 * steps (detect → pick → secrets → review → saving/done/error) live in
 * one file — splitting into sub-components added more indirection than
 * value at this size. App.svelte mounts via `{#if shouldShowWizard}` so
 * the state machine resets on close→reopen.
 */
import { untrack } from "svelte";
import { DEFAULT_MCP_PORT } from "../../shared/constants.js";
import type { ExistingMcpInstall, IntegrationConfig } from "../../shared/integrations/contract.js";
import {
  createIntegrationWizard,
  type PickedIntegration,
} from "../hooks/useIntegrationWizard.svelte.js";

interface Props {
  open: boolean;
  onClose: () => void;
}

let { open, onClose }: Props = $props();

// Absolute base URL because the Vite dev server does not proxy /api/* —
// other client modules (yjsSync, useNotifications, fileUpload) follow the
// same pattern of pointing directly at the backend port.
const wizard = createIntegrationWizard({ baseUrl: `http://127.0.0.1:${DEFAULT_MCP_PORT}` });
let dialogEl: HTMLElement | null = $state(null);
let prevFocus: Element | null = null;
// User-entered token text per integration id (cleared after submit).
let secretInputs = $state<Record<string, string>>({});

$effect(() => {
  if (!open) return;
  const el = untrack(() => dialogEl);
  if (!el) return;
  prevFocus = document.activeElement;
  el.focus();
  return () => {
    if (prevFocus instanceof HTMLElement && document.contains(prevFocus)) prevFocus.focus();
  };
});

$effect(() => {
  if (!open) return;
  // Kick off detection on open. begin() is idempotent — calling on re-open
  // refreshes the existing-entries list.
  void wizard.begin();
});

$effect(() => {
  if (!open) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
});

function close(): void {
  wizard.reset();
  secretInputs = {};
  onClose();
}

/**
 * Build a stable id. `Date.now()` has only millisecond resolution and
 * `IntegrationsFileSchema` doesn't reject duplicate ids — two rapid picks
 * in the same tick would silently overwrite each other downstream.
 */
function newPickedId(kindPrefix: string): string {
  return `${kindPrefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function detectedToPicked(install: ExistingMcpInstall): PickedIntegration | null {
  if (install.target.kind === "claude-code") {
    const url = install.tandemEntry?.url ?? "http://127.0.0.1:3479";
    const id = newPickedId("claude-code");
    return {
      id,
      config: {
        kind: "claude-code",
        id,
        label: install.target.label,
        configPath: install.target.configPath,
        transport: "http",
        url,
      },
      hasStoredSecret: false,
      keychainUnavailable: false,
    };
  }
  if (install.target.kind === "claude-desktop") {
    const id = newPickedId("claude-desktop");
    return {
      id,
      config: {
        kind: "claude-desktop",
        id,
        label: install.target.label,
        configPath: install.target.configPath,
        transport: "stdio",
      },
      hasStoredSecret: false,
      keychainUnavailable: false,
    };
  }
  return null;
}

function preselectFromDetected(): void {
  const next = wizard.existing
    .filter((i) => i.status === "ok" || i.status === "missing")
    .map(detectedToPicked)
    .filter((p): p is PickedIntegration => p !== null);
  wizard.setPicked(next);
  wizard.advanceToPick();
}

function togglePicked(install: ExistingMcpInstall): void {
  const existingIdx = wizard.picked.findIndex(
    (p) => p.config.kind === install.target.kind && p.config.label === install.target.label,
  );
  if (existingIdx >= 0) {
    wizard.setPicked(wizard.picked.filter((_, i) => i !== existingIdx));
    return;
  }
  const next = detectedToPicked(install);
  if (next) wizard.setPicked([...wizard.picked, next]);
}

function isPicked(install: ExistingMcpInstall): boolean {
  return wizard.picked.some(
    (p) => p.config.kind === install.target.kind && p.config.label === install.target.label,
  );
}

async function onSubmitSecret(picked: PickedIntegration): Promise<void> {
  const secret = secretInputs[picked.id] ?? "";
  if (secret.length === 0) return;
  await wizard.submitSecret(picked, secret);
  secretInputs = { ...secretInputs, [picked.id]: "" };
}

function configBadge(config: IntegrationConfig): string {
  if (config.kind === "claude-code") return "Claude Code · HTTP";
  if (config.kind === "claude-desktop") return "Claude Desktop · stdio";
  return `Other MCP · ${config.transport}`;
}
</script>

{#if open}
  <div
    role="presentation"
    class="iw-scrim"
    onclick={close}
    data-testid="integration-wizard"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Integration Setup Wizard"
      tabindex="-1"
      bind:this={dialogEl}
      class="iw-dialog"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => {
        // Handle Escape locally; the window-level handler never sees it
        // because we stopPropagation on every non-Tab key below.
        if (e.key === "Escape") {
          close();
          return;
        }
        if (e.key !== "Tab") e.stopPropagation();
      }}
    >
      <header class="iw-header">
        <h2 class="iw-title">Connect an AI assistant</h2>
        <button
          type="button"
          class="iw-close"
          onclick={close}
          aria-label="Close wizard"
          data-testid="integration-wizard-close"
        >
          ×
        </button>
      </header>

      {#if wizard.step === "detect"}
        <section data-testid="integration-wizard-step-detect">
          <p>Looking for existing AI integrations on your system…</p>
          {#if wizard.existing.length > 0}
            <ul class="iw-existing">
              {#each wizard.existing as install (install.target.configPath)}
                <li>
                  <strong>{install.target.label}</strong>
                  <span class="iw-status iw-status-{install.status}">{install.status}</span>
                  {#if install.tandemEntry}
                    <span class="iw-hint">Tandem is already configured here.</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          <div class="iw-actions">
            <button
              type="button"
              onclick={preselectFromDetected}
              data-testid="integration-wizard-continue-detect"
            >
              Continue
            </button>
          </div>
        </section>
      {:else if wizard.step === "pick"}
        <section data-testid="integration-wizard-step-pick">
          <p>Select which AI integrations to register with Tandem.</p>
          <ul class="iw-pick-list">
            {#each wizard.existing as install (install.target.configPath)}
              <li>
                <label>
                  <input
                    type="checkbox"
                    checked={isPicked(install)}
                    onchange={() => togglePicked(install)}
                    data-testid="integration-wizard-pick-{install.target.kind}"
                  />
                  <strong>{install.target.label}</strong>
                  <small>{install.target.configPath}</small>
                </label>
              </li>
            {/each}
          </ul>
          <div class="iw-actions">
            <button type="button" onclick={() => wizard.advanceToSecrets()} data-testid="integration-wizard-continue-pick">
              Continue
            </button>
          </div>
        </section>
      {:else if wizard.step === "secrets"}
        <section data-testid="integration-wizard-step-secrets">
          <p>
            Optional — store an auth token for each integration. Tandem keeps these in your
            operating system's keychain, never in plain text.
          </p>
          {#if wizard.keychainUnavailable}
            <p class="iw-warning" data-testid="integration-wizard-keychain-fallback">
              Your operating system keychain isn't reachable from this Tandem build. Tokens
              entered here can't be saved. Use the environment variable
              <code>TANDEM_INTEGRATION_&lt;id&gt;_TOKEN</code> instead, or skip this step and
              add the token via your AI client's own configuration.
            </p>
          {/if}
          <ul class="iw-secrets-list">
            {#each wizard.picked as picked (picked.id)}
              <li>
                <div class="iw-secret-row">
                  <strong>{picked.config.label}</strong>
                  <small>{configBadge(picked.config)}</small>
                </div>
                {#if picked.hasStoredSecret}
                  <em class="iw-stored">Token saved.</em>
                {:else if picked.keychainUnavailable}
                  <em class="iw-skipped">Skipped (keychain unavailable).</em>
                {:else}
                  <div class="iw-secret-input">
                    <input
                      type="password"
                      placeholder="Paste auth token (optional)"
                      bind:value={secretInputs[picked.id]}
                      data-testid="integration-wizard-secret-input-{picked.id}"
                    />
                    <button
                      type="button"
                      onclick={() => onSubmitSecret(picked)}
                      disabled={!secretInputs[picked.id]}
                      data-testid="integration-wizard-secret-submit-{picked.id}"
                    >
                      Save token
                    </button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
          <div class="iw-actions">
            <button
              type="button"
              onclick={() => wizard.advanceToReview()}
              data-testid="integration-wizard-continue-secrets"
            >
              Continue
            </button>
          </div>
        </section>
      {:else if wizard.step === "review"}
        <section data-testid="integration-wizard-step-review">
          <p>Ready to save. Tandem will register these integrations:</p>
          <ul class="iw-review-list">
            {#each wizard.picked as picked (picked.id)}
              <li>
                <strong>{picked.config.label}</strong>
                <small>{configBadge(picked.config)}</small>
                {#if picked.config.tokenSecretRef}
                  <span class="iw-token-badge">Token stored</span>
                {/if}
              </li>
            {/each}
          </ul>
          <div class="iw-actions">
            <button
              type="button"
              onclick={() => wizard.save()}
              data-testid="integration-wizard-save"
            >
              Save and finish
            </button>
          </div>
        </section>
      {:else if wizard.step === "saving"}
        <section data-testid="integration-wizard-step-saving">
          <p>Saving integration configuration…</p>
        </section>
      {:else if wizard.step === "done"}
        <section data-testid="integration-wizard-step-done">
          <p>Done — Tandem is connected to your AI client(s).</p>
          {#if wizard.applyResults.length > 0}
            <ul class="iw-apply-results">
              {#each wizard.applyResults as result (result.id)}
                <li
                  class="iw-apply-result iw-apply-result-{result.status}"
                  data-testid="integration-wizard-apply-result-{result.id}"
                >
                  <span class="iw-apply-result-id">{result.id}</span>
                  <span class="iw-apply-result-status">{result.status}</span>
                  {#if result.status === "error" && result.message}
                    <span class="iw-apply-result-message">{result.message}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          <div class="iw-actions">
            <button type="button" onclick={close} data-testid="integration-wizard-done-close">
              Close
            </button>
          </div>
        </section>
      {:else if wizard.step === "error"}
        <section data-testid="integration-wizard-step-error">
          <p class="iw-error">Something went wrong: {wizard.errorMessage}</p>
          <div class="iw-actions">
            <button type="button" onclick={() => wizard.reset()}>Start over</button>
            <button type="button" onclick={close}>Close</button>
          </div>
        </section>
      {/if}
    </div>
  </div>
{/if}

<style>
  .iw-scrim {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--tandem-z-above-titlebar);
  }

  .iw-dialog {
    background-color: var(--tandem-surface);
    color: var(--tandem-fg);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-4);
    box-shadow: var(--tandem-shadow-3);
    padding: var(--tandem-space-5);
    width: 640px;
    max-width: 95vw;
    max-height: 90vh;
    overflow-y: auto;
  }

  .iw-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: var(--tandem-space-4);
  }

  .iw-title {
    font-size: var(--tandem-text-xl);
    margin: 0;
  }

  .iw-close {
    background: none;
    border: none;
    font-size: var(--tandem-text-2xl);
    cursor: pointer;
    color: var(--tandem-fg-muted);
  }

  .iw-existing,
  .iw-pick-list,
  .iw-secrets-list,
  .iw-review-list {
    list-style: none;
    padding: 0;
    margin: var(--tandem-space-3) 0;
  }

  .iw-existing li,
  .iw-pick-list li,
  .iw-secrets-list li,
  .iw-review-list li {
    padding: var(--tandem-space-2) 0;
    border-bottom: 1px solid var(--tandem-border-subtle);
  }

  .iw-status {
    margin-left: var(--tandem-space-2);
    font-size: var(--tandem-text-2xs);
    padding: 2px 6px;
    border-radius: var(--tandem-r-pill);
  }
  .iw-status-ok {
    background: var(--tandem-success-bg);
    color: var(--tandem-success-fg-strong);
  }
  .iw-status-missing {
    background: var(--tandem-warning-bg);
    color: var(--tandem-warning-fg-strong);
  }
  .iw-status-malformed,
  .iw-status-error {
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
  }

  .iw-hint {
    display: block;
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-muted);
  }

  .iw-actions {
    display: flex;
    gap: var(--tandem-space-2);
    justify-content: flex-end;
    margin-top: var(--tandem-space-4);
  }

  .iw-actions button {
    padding: var(--tandem-space-2) var(--tandem-space-3);
    border-radius: var(--tandem-r-2);
    border: 1px solid var(--tandem-border);
    background: var(--tandem-surface-elevated);
    color: var(--tandem-fg);
    cursor: pointer;
  }

  .iw-secret-row {
    display: flex;
    flex-direction: column;
    margin-bottom: var(--tandem-space-1);
  }

  .iw-secret-input {
    display: flex;
    gap: var(--tandem-space-2);
  }

  .iw-secret-input input {
    flex: 1;
    padding: var(--tandem-space-1) var(--tandem-space-2);
    border-radius: var(--tandem-r-2);
    border: 1px solid var(--tandem-border);
  }

  .iw-stored {
    color: var(--tandem-success-fg-strong);
  }
  .iw-skipped {
    color: var(--tandem-warning-fg-strong);
  }

  .iw-warning {
    padding: var(--tandem-space-2);
    background: var(--tandem-warning-bg);
    color: var(--tandem-warning-fg-strong);
    border-radius: var(--tandem-r-2);
    margin: var(--tandem-space-2) 0;
  }

  .iw-error {
    color: var(--tandem-error-fg-strong);
  }

  .iw-token-badge {
    margin-left: var(--tandem-space-2);
    font-size: var(--tandem-text-2xs);
    padding: 2px 6px;
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-success-bg);
    color: var(--tandem-success-fg-strong);
  }

  .iw-apply-results {
    list-style: none;
    padding: 0;
    margin: var(--tandem-space-3) 0;
  }
  .iw-apply-result {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tandem-space-2);
    padding: var(--tandem-space-2);
    border-radius: var(--tandem-r-2);
    margin-bottom: var(--tandem-space-1);
    border: 1px solid var(--tandem-border-subtle);
  }
  .iw-apply-result-id {
    font-weight: 600;
  }
  .iw-apply-result-status {
    font-size: var(--tandem-text-2xs);
    padding: 2px 6px;
    border-radius: var(--tandem-r-pill);
    text-transform: uppercase;
  }
  .iw-apply-result-message {
    flex-basis: 100%;
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-muted);
  }
  .iw-apply-result-applied {
    background: var(--tandem-success-bg);
    color: var(--tandem-success-fg-strong);
  }
  .iw-apply-result-skipped {
    background: var(--tandem-warning-bg);
    color: var(--tandem-warning-fg-strong);
  }
  .iw-apply-result-error {
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
  }
</style>
