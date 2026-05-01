<script lang="ts">
import { COWORK_RESCAN_DEBOUNCE_MS } from "../../shared/constants";
import {
  aggregateWorkspaceStatus,
  coworkSettingsVariant,
  formatCoworkError,
  makeDebouncer,
  type StatusTokenFamily,
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
};

const sectionLabelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";
const helpTextStyle = "font-size: 10px; color: var(--tandem-fg-subtle); margin-top: 4px;";
const infoBannerStyle =
  "border: 1px solid var(--tandem-info-border); background: var(--tandem-info-bg); color: var(--tandem-info-fg-strong); border-radius: 6px; padding: 8px 10px; font-size: 12px;";
const errorBannerStyle =
  "border: 1px solid var(--tandem-error-border); background: var(--tandem-error-bg); color: var(--tandem-error-fg-strong); border-radius: 6px; padding: 8px 10px; font-size: 12px;";
const primaryBtnStyle =
  "padding: 4px 10px; font-size: 12px; border: 1px solid var(--tandem-accent); border-radius: 4px; background: var(--tandem-accent); color: var(--tandem-accent-fg); cursor: pointer; font-weight: 600;";
const secondaryBtnStyle =
  "padding: 4px 10px; font-size: 12px; border: 1px solid var(--tandem-border-strong); border-radius: 4px; background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: pointer;";

// Always active while mounted
const coworkState = createCoworkStatus(() => true);
const { refetch } = coworkState;

let inlineToastMessage = $state<string | null>(null);
let confirming = $state<"enable" | null>(null);
let busy = $state(false);

const debouncer = makeDebouncer(COWORK_RESCAN_DEBOUNCE_MS);

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
  return `display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 6px; border: 1px solid ${tokens.border}; background: ${tokens.bg}; color: ${tokens.fg}; border-radius: 4px; font-size: 11px;`;
}
</script>

<div
  data-testid="cowork-settings"
  style="display: flex; flex-direction: column; gap: 10px;"
>
  <div style={sectionLabelStyle}>Cowork Integration</div>

  {#if coworkState.loading}
    <div
      data-testid="cowork-settings-loading"
      style="font-size: 12px; color: var(--tandem-fg-subtle);"
    >
      Loading Cowork status...
    </div>
  {:else if variant === "unsupported"}
    <div data-testid="cowork-settings-unsupported" style={infoBannerStyle}>
      Cowork integration is available on Windows in v0.8.0. macOS/Linux support tracked in #316 /
      #317.
    </div>
  {:else if variant === "undetected"}
    <div data-testid="cowork-settings-undetected" style={infoBannerStyle}>
      Cowork not detected on this system.{" "}
      <a
        href="https://github.com/bloknayrb/tandem#cowork"
        target="_blank"
        rel="noreferrer"
        style="color: var(--tandem-accent);"
      >
        Learn more
      </a>
    </div>
  {:else if variant === "normal" && coworkState.status !== null}
    {@const s = coworkState.status}
    <!-- Toggle -->
    <label
      data-testid="cowork-toggle"
      style="display: flex; align-items: center; gap: 8px; cursor: {busy ? 'wait' : 'pointer'}; font-size: 12px; color: var(--tandem-fg); min-height: 24px;"
    >
      <input
        data-testid="cowork-toggle-checkbox"
        type="checkbox"
        checked={s.enabled}
        disabled={busy}
        onchange={(e) => {
          if ((e.target as HTMLInputElement).checked) confirming = "enable";
          else void handleToggleOff();
        }}
        style="accent-color: var(--tandem-accent);"
      />
      <span>Enable Cowork integration</span>
    </label>
    <div style={helpTextStyle}>Token provisioned: {s.enabled ? "yes" : "no"}</div>

    {#if confirming === "enable"}
      <div
        data-testid="cowork-enable-confirm"
        role="dialog"
        style="border: 1px solid var(--tandem-warning-border); background: var(--tandem-warning-bg); color: var(--tandem-warning-fg-strong); border-radius: 6px; padding: 8px 10px; font-size: 12px;"
      >
        <div style="font-weight: 600; margin-bottom: 4px;">Confirm: Enable Cowork</div>
        <div style="margin-bottom: 8px;">
          Windows will prompt for admin permission to modify firewall rules. This is expected.
          Tandem will write plugin entries to every detected Cowork workspace.
        </div>
        <div style="display: flex; gap: 8px;">
          <button
            data-testid="cowork-enable-confirm-btn"
            type="button"
            onclick={() => void handleToggleOn()}
            disabled={busy}
            style={primaryBtnStyle}
          >
            Enable
          </button>
          <button
            data-testid="cowork-enable-cancel-btn"
            type="button"
            onclick={() => { confirming = null; }}
            disabled={busy}
            style={secondaryBtnStyle}
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}

    {#if s.vethernetCidr !== null}
      <div data-testid="cowork-vethernet-cidr" style="font-size: 12px;">
        Detected VM subnet: <code>{s.vethernetCidr}</code>
      </div>
    {/if}

    {#if s.lanIpFallback !== null}
      <div>
        <label
          data-testid="cowork-lan-ip-override"
          style="display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: {busy ? 'wait' : 'pointer'};"
        >
          <input
            data-testid="cowork-lan-ip-override-checkbox"
            type="checkbox"
            checked={s.useLanIpOverride}
            disabled={busy}
            onchange={(e) => void handleToggleLanIp((e.target as HTMLInputElement).checked)}
            style="accent-color: var(--tandem-accent);"
          />
          <span>Use LAN IP instead of host.docker.internal</span>
        </label>
        <div style={helpTextStyle}>Fallback: {s.lanIpFallback}</div>
      </div>
    {/if}

    <div>
      <div style={sectionLabelStyle}>Workspaces ({s.workspaces.length})</div>
      {#if s.workspaces.length === 0}
        <div style="font-size: 12px; color: var(--tandem-fg-subtle);">
          No Cowork workspaces detected yet.
        </div>
      {:else}
        <div
          data-testid="cowork-workspace-table"
          style="display: flex; flex-direction: column; gap: 4px;"
        >
          {#each s.workspaces as ws (`${ws.workspaceId}/${ws.vmId}`)}
            {@const agg = aggregateWorkspaceStatus(ws)}
            {@const label = workspaceFileStatusLabel(agg)}
            <div
              data-testid={`cowork-workspace-row-${ws.workspaceId}-${ws.vmId}`}
              data-status={agg}
              title={ws.failureDetail ?? ws.path}
              style={workspaceRowStyle(ws)}
            >
              <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                {ws.workspaceId} / {ws.vmId}
              </span>
              <span style="font-weight: 600; white-space: nowrap;">{label}</span>
              {#if agg === "schemaDrift"}
                <a
                  data-testid={`cowork-workspace-report-${ws.workspaceId}-${ws.vmId}`}
                  href="mailto:maintainers@tandem.invalid?subject=Cowork%20schema%20drift"
                  style="color: var(--tandem-error-fg-strong); text-decoration: underline;"
                >
                  Report
                </a>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
      <button
        data-testid="cowork-rescan-btn"
        type="button"
        onclick={handleRescan}
        disabled={busy}
        style="{secondaryBtnStyle} margin-top: 8px;"
      >
        Re-scan workspaces
      </button>
    </div>
  {/if}

  {#if coworkState.error && !coworkState.status}
    <div data-testid="cowork-settings-error" role="alert" style={errorBannerStyle}>
      Failed to load Cowork status: {coworkState.error}
    </div>
  {/if}

  {#if inlineToastMessage}
    <div data-testid="cowork-inline-toast" role="alert" style={errorBannerStyle}>
      {inlineToastMessage}
    </div>
  {/if}
</div>
