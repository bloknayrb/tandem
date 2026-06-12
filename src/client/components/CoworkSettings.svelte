<script lang="ts">
import { onDestroy } from "svelte";
import { COWORK_RESCAN_DEBOUNCE_MS, TANDEM_REPO_URL } from "../../shared/constants";
import {
  aggregateWorkspaceStatus,
  coworkSettingsVariant,
  formatCoworkError,
  makeDebouncer,
  type StatusTokenFamily,
  undetectedDetail,
  workspaceFileStatusFamily,
  workspaceFileStatusLabel,
} from "../cowork/cowork-helpers";
import {
  coworkRescan,
  coworkSetLanIpOverride,
  coworkToggleIntegration,
  type InvokeFn,
  loadInvoke,
} from "../cowork/cowork-invoke";
import { createCoworkStatus } from "../hooks/useCoworkStatus.svelte";
import type { WorkspaceFileStatus, WorkspaceStatus } from "../types";

const STATUS_TOKENS: Record<StatusTokenFamily, { bg: string; fg: string; border: string }> = {
  success: {
    bg: "var(--tandem-success-bg)",
    fg: "var(--tandem-success-fg-strong)",
    border: "var(--tandem-success-border)",
  },
  warning: {
    bg: "var(--tandem-warning-bg)",
    fg: "var(--tandem-warning-fg-strong)",
    border: "var(--tandem-warning-border)",
  },
  error: {
    bg: "var(--tandem-error-bg)",
    fg: "var(--tandem-error-fg-strong)",
    border: "var(--tandem-error-border)",
  },
  neutral: {
    bg: "var(--tandem-info-bg)",
    fg: "var(--tandem-info-fg-strong)",
    border: "var(--tandem-info-border)",
  },
};

// Always active while mounted
const coworkState = createCoworkStatus(() => true);
const { refetch } = coworkState;

let inlineToastMessage = $state<string | null>(null);
let confirming = $state<"enable" | null>(null);
let busy = $state(false);

const debouncer = makeDebouncer(COWORK_RESCAN_DEBOUNCE_MS);
onDestroy(() => debouncer.cancel());

const variant = $derived(coworkSettingsVariant(coworkState.status));

async function withInvoke(
  op: (invoke: InvokeFn) => Promise<void>,
  errorPrefix: string,
): Promise<void> {
  busy = true;
  try {
    const invoke = await loadInvoke();
    await op(invoke);
    inlineToastMessage = null;
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const display = formatCoworkError(rawMsg);
    inlineToastMessage = `${errorPrefix}: ${display}`;
  } finally {
    busy = false;
  }
}

async function handleToggleOn(): Promise<void> {
  await withInvoke(async (invoke) => {
    await coworkToggleIntegration(invoke, true);
    await refetch();
    confirming = null;
  }, "Failed to enable Cowork");
}

async function handleToggleOff(): Promise<void> {
  await withInvoke(async (invoke) => {
    await coworkToggleIntegration(invoke, false);
    await refetch();
  }, "Failed to disable Cowork");
}

function handleRescan(): void {
  debouncer.schedule(() => {
    void withInvoke(async (invoke) => {
      await coworkRescan(invoke);
      await refetch();
    }, "Re-scan failed");
  });
}

async function handleToggleLanIp(enabled: boolean): Promise<void> {
  await withInvoke(async (invoke) => {
    await coworkSetLanIpOverride(invoke, enabled);
    await refetch();
  }, "Failed to update LAN-IP override");
}

function workspaceRowStyle(ws: WorkspaceStatus): string {
  const agg: WorkspaceFileStatus = aggregateWorkspaceStatus(ws);
  const tokens = STATUS_TOKENS[workspaceFileStatusFamily(agg)];
  return `display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 6px; border: 1px solid ${tokens.border}; background: ${tokens.bg}; color: ${tokens.fg}; border-radius: var(--tandem-r-2); font-size: 11px;`;
}
</script>

<div class="cs-root" data-testid="cowork-settings">
  <div class="cs-label">Cowork Integration</div>

  {#if coworkState.loading}
    <div class="cs-help-text" data-testid="cowork-settings-loading">
      Loading Cowork status...
    </div>
  {:else if variant === "unsupported"}
    <div class="cs-info-banner" data-testid="cowork-settings-unsupported">
      Cowork integration is available on Windows in v0.8.0. macOS/Linux support tracked in #316 /
      #317.
    </div>
  {:else if variant === "undetected"}
    {@const detail = coworkState.status ? undetectedDetail(coworkState.status) : "noClaude"}
    <div class="cs-info-banner" data-testid="cowork-settings-undetected" data-detail={detail}>
      {#if detail === "blocked"}
        Cowork sessions were found in a network-redirected or cloud-synced location that Tandem
        can't safely configure.{" "}
      {:else if detail === "noWorkspacesYet"}
        Claude Desktop detected. Run a Cowork session once, then enable the integration here —
        Tandem keeps newly created workspaces configured automatically.{" "}
      {:else}
        Cowork not detected on this system.{" "}
      {/if}
      <a class="cs-link" href={`${TANDEM_REPO_URL}#cowork`} target="_blank" rel="noreferrer">
        Learn more
      </a>
    </div>
  {:else if variant === "normal" && coworkState.status !== null}
    {@const s = coworkState.status}
    <!-- Toggle -->
    <label
      class="cs-toggle"
      class:is-busy={busy}
      data-testid="cowork-toggle"
    >
      <input
        class="cs-accent-cbx"
        data-testid="cowork-toggle-checkbox"
        type="checkbox"
        checked={s.enabled}
        disabled={busy}
        onchange={(e) => {
          if ((e.target as HTMLInputElement).checked) confirming = "enable";
          else void handleToggleOff();
        }}
      />
      <span>Enable Cowork integration</span>
    </label>
    <div class="cs-help">Integration enabled: {s.enabled ? "yes" : "no"}</div>

    {#if confirming === "enable"}
      <div
        class="cs-warning-banner"
        data-testid="cowork-enable-confirm"
        role="dialog"
      >
        <div class="cs-confirm-heading">Confirm: Enable Cowork</div>
        <div class="cs-confirm-body">
          Tandem will write plugin entries to every detected Cowork workspace so Claude running in
          Cowork can reach the documents you have open.
        </div>
        <div class="cs-actions">
          <button
            class="cs-btn cs-btn--primary"
            data-testid="cowork-enable-confirm-btn"
            type="button"
            onclick={() => void handleToggleOn()}
            disabled={busy}
          >
            Enable
          </button>
          <button
            class="cs-btn cs-btn--ghost"
            data-testid="cowork-enable-cancel-btn"
            type="button"
            onclick={() => { confirming = null; }}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}

    {#if s.vethernetCidr !== null}
      <div class="cs-vethernet" data-testid="cowork-vethernet-cidr">
        Detected Cowork environment: <code>{s.vethernetCidr}</code>
      </div>
    {/if}

    {#if s.lanIpFallback !== null}
      <div>
        <label
          class="cs-toggle"
          class:is-busy={busy}
          data-testid="cowork-lan-ip-override"
        >
          <input
            class="cs-accent-cbx"
            data-testid="cowork-lan-ip-override-checkbox"
            type="checkbox"
            checked={s.useLanIpOverride}
            disabled={busy}
            onchange={(e) => void handleToggleLanIp((e.target as HTMLInputElement).checked)}
          />
          <span>Use LAN IP instead of host.docker.internal</span>
        </label>
        <div class="cs-help">Fallback: {s.lanIpFallback}</div>
      </div>
    {/if}

    <div>
      <div class="cs-label">Workspaces ({s.workspaces.length})</div>
      {#if s.workspaces.length === 0}
        <div class="cs-help-text">No Cowork workspaces detected yet.</div>
      {:else}
        <div class="cs-workspace-table" data-testid="cowork-workspace-table">
          {#each s.workspaces as ws (`${ws.workspaceId}/${ws.vmId}`)}
            {@const agg = aggregateWorkspaceStatus(ws)}
            {@const label = workspaceFileStatusLabel(agg)}
            <div
              class="cs-workspace-row"
              data-testid={`cowork-workspace-row-${ws.workspaceId}-${ws.vmId}`}
              data-status={agg}
              title={ws.failureDetail ?? ws.path}
              style={workspaceRowStyle(ws)}
            >
              <span class="cs-workspace-id">{ws.workspaceId} / {ws.vmId}</span>
              <span class="cs-workspace-label">{label}</span>
              {#if agg === "schemaDrift"}
                <a
                  class="cs-report-link"
                  data-testid={`cowork-workspace-report-${ws.workspaceId}-${ws.vmId}`}
                  href="mailto:maintainers@tandem.invalid?subject=Cowork%20schema%20drift"
                >
                  Report
                </a>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
      <button
        class="cs-btn cs-btn--ghost cs-rescan-btn"
        data-testid="cowork-rescan-btn"
        type="button"
        onclick={handleRescan}
        disabled={busy}
      >
        Re-scan workspaces
      </button>
    </div>
  {/if}

  {#if coworkState.error && !coworkState.status}
    <div class="cs-error-banner" data-testid="cowork-settings-error" role="alert">
      Failed to load Cowork status: {coworkState.error}
    </div>
  {/if}

  {#if inlineToastMessage}
    <div class="cs-error-banner" data-testid="cowork-inline-toast" role="alert">
      {inlineToastMessage}
    </div>
  {/if}
</div>

<style>
  .cs-root {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cs-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--tandem-fg);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .cs-help-text {
    font-size: 12px;
    color: var(--tandem-fg-subtle);
  }
  .cs-help {
    font-size: 10px;
    color: var(--tandem-fg-subtle);
    margin-top: 4px;
  }
  .cs-info-banner {
    border: 1px solid var(--tandem-info-border);
    background: var(--tandem-info-bg);
    color: var(--tandem-info-fg-strong);
    border-radius: var(--tandem-r-3);
    padding: 8px 10px;
    font-size: 12px;
  }
  .cs-error-banner {
    border: 1px solid var(--tandem-error-border);
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
    border-radius: var(--tandem-r-3);
    padding: 8px 10px;
    font-size: 12px;
  }
  .cs-warning-banner {
    border: 1px solid var(--tandem-warning-border);
    background: var(--tandem-warning-bg);
    color: var(--tandem-warning-fg-strong);
    border-radius: var(--tandem-r-3);
    padding: 8px 10px;
    font-size: 12px;
  }
  .cs-confirm-heading {
    font-weight: 600;
    margin-bottom: 4px;
  }
  .cs-confirm-body {
    margin-bottom: 8px;
  }
  .cs-link {
    color: var(--tandem-accent);
  }

  .cs-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 12px;
    color: var(--tandem-fg);
    min-height: 24px;
  }
  .cs-toggle.is-busy {
    cursor: wait;
  }
  .cs-accent-cbx {
    accent-color: var(--tandem-accent);
  }

  .cs-vethernet {
    font-size: 12px;
  }

  .cs-actions {
    display: flex;
    gap: 8px;
  }
  .cs-btn {
    padding: 4px 10px;
    font-size: 12px;
    border-radius: var(--tandem-r-2);
    cursor: pointer;
  }
  .cs-btn--primary {
    border: 1px solid var(--tandem-accent);
    background: var(--tandem-accent);
    color: var(--tandem-accent-fg);
    font-weight: 600;
  }
  .cs-btn--primary:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .cs-btn--ghost {
    border: 1px solid var(--tandem-border-strong);
    background: var(--tandem-surface);
    color: var(--tandem-fg-muted);
  }
  .cs-btn--ghost:hover:not(:disabled) {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .cs-btn--ghost:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .cs-rescan-btn {
    margin-top: 8px;
  }

  /* Workspace rows. The per-row border/bg/fg are computed at runtime by
     workspaceRowStyle() because they vary per status family (success /
     warning / error) — leaving that inline keeps the status-family map as
     the source of truth. */
  .cs-workspace-table {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cs-workspace-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: var(--tandem-r-2);
    font-size: 11px;
  }
  .cs-workspace-id {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cs-workspace-label {
    font-weight: 600;
    white-space: nowrap;
  }
  .cs-report-link {
    color: var(--tandem-error-fg-strong);
    text-decoration: underline;
  }
</style>
