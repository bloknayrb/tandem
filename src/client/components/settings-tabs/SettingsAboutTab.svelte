<script lang="ts">
import { API_DIAGNOSTICS } from "../../../shared/api-paths";
import { isTauriRuntime } from "../../cowork/cowork-helpers";
import { loadInvoke } from "../../cowork/cowork-invoke";
import { createAppInfo } from "../../hooks/useAppInfo.svelte";
import { isCrashReportingEnabled } from "../../sentry";
import { type DiagnosticsPayload, formatDiagnostics } from "../../utils/diagnostics";
import { API_BASE } from "../../utils/fileUpload";
import { openServerPath } from "../../utils/server-paths";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// Keep `$props()` as a single proxy variable and read fields via `ctx.foo`.
// Capturing into a local and then destructuring (`let c = $props(); let { open } = c`)
// would freeze the getter at mount (feedback_svelte_getter_destructuring), so
// the open flag would stall and `createAppInfo` would never see open transitions.
let ctx: SettingsTabContext = $props();

const appInfo = createAppInfo(() => ctx.open);
let docsLoading = $state(false);
let docsError = $state<string | null>(null);
let diagLoading = $state(false);

async function handleCopyDiagnostics(): Promise<void> {
  diagLoading = true;
  let text: string;
  try {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${API_DIAGNOSTICS}`);
    } catch {
      ctx.notify("error", "Couldn't reach the server — is it running?");
      return;
    }
    if (!res.ok) {
      // The server WAS reached — an "is it running?" message would misdirect.
      ctx.notify("error", "Diagnostics failed on the server — try `tandem doctor` in a terminal");
      return;
    }
    // Format before entering the clipboard try, so a malformed payload isn't
    // misreported as a clipboard-permission problem.
    text = formatDiagnostics((await res.json()) as DiagnosticsPayload);
  } catch {
    ctx.notify("error", "Diagnostics failed on the server — try `tandem doctor` in a terminal");
    return;
  } finally {
    diagLoading = false;
  }
  try {
    await navigator.clipboard.writeText(text);
    ctx.notify("info", "Diagnostics copied to clipboard");
  } catch {
    // Clipboard access denied (permissions policy / non-secure context).
    ctx.notify(
      "error",
      "Couldn't access the clipboard — run `tandem doctor` in a terminal instead",
    );
  }
}

async function handleOpenLogFolder(): Promise<void> {
  try {
    const [{ appLogDir }, invoke] = await Promise.all([
      import("@tauri-apps/api/path"),
      loadInvoke(),
    ]);
    const path = await appLogDir();
    await invoke("show_in_file_manager", { path });
  } catch {
    ctx.notify("error", "Couldn't open the log folder");
  }
}

/** Shared chrome for the full-width About-tab action buttons. */
const actionBtnStyle =
  "flex: 1; padding: var(--tandem-space-2); font-size: 13px; font-weight: 500; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface-muted); color: var(--tandem-fg);";

async function handleViewDocumentation(): Promise<void> {
  const filePath = appInfo.info?.workflowsPath;
  if (!filePath) {
    docsError = "Documentation file not found.";
    return;
  }
  docsLoading = true;
  docsError = null;
  const result = await openServerPath(filePath, {
    readOnly: true,
    notFoundMessage: "Documentation file not found.",
    failureMessage: "Failed to open documentation.",
  });
  docsLoading = false;
  if (!result.ok) {
    docsError = result.error;
  }
  // Unlike the changelog button in SettingsModal, the documentation button
  // keeps the modal open after a successful open.
}

const aboutRows = $derived.by(() => {
  const info = appInfo.info;
  if (!info) return [];

  const rows: Array<{ label: string; value: string }> = [
    { label: "Version", value: `Tandem v${info.version}` },
    {
      label: "Tools",
      value:
        info.toolCount === null ? "Tool count unavailable" : `${info.toolCount} tools available`,
    },
    { label: "MCP SDK", value: `MCP SDK ${info.mcpSdkVersion}` },
    { label: "Transport", value: info.transport?.toUpperCase() ?? "—" },
  ];

  if (info.storagePath) rows.push({ label: "Storage", value: info.storagePath });
  if (info.tokenRotatedAt !== undefined) {
    rows.push({
      label: "Token",
      value:
        info.tokenRotatedAt === null
          ? "Token not created"
          : `Token rotated ${new Date(info.tokenRotatedAt).toLocaleString()}`,
    });
  }
  if (info.changelogPath) rows.push({ label: "Changelog", value: info.changelogPath });

  // Crash reporting (#921) is opt-in via the TANDEM_SENTRY_DSN env var and off
  // by default; surface its status read-only (no toggle — the env var is the
  // single source of truth).
  rows.push({
    label: "Crash reports",
    value: isCrashReportingEnabled()
      ? "On (TANDEM_SENTRY_DSN set)"
      : "Off — opt in with TANDEM_SENTRY_DSN",
  });

  return rows;
});
</script>

<div>
  <button
    type="button"
    data-testid="settings-modal-view-documentation-btn"
    onclick={() => void handleViewDocumentation()}
    disabled={docsLoading || appInfo.loading}
    style="width: 100%; padding: var(--tandem-space-2); font-size: 13px; font-weight: 500; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); cursor: {docsLoading || appInfo.loading ? 'not-allowed' : 'pointer'}; background: var(--tandem-surface-muted); color: var(--tandem-fg); opacity: {docsLoading || appInfo.loading ? 0.6 : 1};"
  >
    {docsLoading ? "Opening…" : "View Documentation"}
  </button>
  {#if docsError}
    <div style="margin-top: 6px; font-size: 11px; color: var(--tandem-error-fg);">
      {docsError}
    </div>
  {/if}
</div>

<div style="display: flex; gap: var(--tandem-space-2);">
  <button
    type="button"
    data-testid="settings-modal-copy-diagnostics-btn"
    onclick={() => void handleCopyDiagnostics()}
    disabled={diagLoading}
    style="{actionBtnStyle} cursor: {diagLoading ? 'not-allowed' : 'pointer'}; opacity: {diagLoading ? 0.6 : 1};"
  >
    {diagLoading ? "Collecting…" : "Copy Diagnostics"}
  </button>
  {#if isTauriRuntime()}
    <button
      type="button"
      data-testid="settings-modal-open-log-folder-btn"
      onclick={() => void handleOpenLogFolder()}
      style="{actionBtnStyle} cursor: pointer;"
    >
      Open Log Folder
    </button>
  {/if}
</div>

<div
  data-testid="settings-modal-app-info-footer"
  style="border-top: 1px solid var(--tandem-border); padding-top: 10px;"
>
  <div class="settings-section-label">About</div>
  {#if appInfo.loading}
    <div style="font-size: 11px; color: var(--tandem-fg-subtle);">Loading...</div>
  {:else if appInfo.info}
    <dl
      style="display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 14px; margin: 0; font-size: 11px;"
    >
      {#each aboutRows as row (row.label)}
        <dt style="color: var(--tandem-fg-subtle);">{row.label}</dt>
        <dd
          style="margin: 0; color: var(--tandem-fg-muted); overflow-wrap: anywhere; font-family: var(--tandem-font-mono);"
        >
          {row.value}
        </dd>
      {/each}
    </dl>
  {:else}
    <div style="font-size: 11px; color: var(--tandem-fg-subtle);">
      App info unavailable.
    </div>
  {/if}
</div>
