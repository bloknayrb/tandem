<script lang="ts">
import { onDestroy } from "svelte";
import { API_LAUNCHER_WORKING_DIRECTORY } from "../../../shared/api-paths";
import { SELECTION_DWELL_MAX_MS, SELECTION_DWELL_MIN_MS } from "../../../shared/constants";
import {
  LAUNCHER_ERROR_IN_PROGRESS,
  LAUNCHER_ERROR_INVALID_BODY,
  LAUNCHER_ERROR_NO_INTEGRATION,
  LAUNCHER_ERROR_NOT_AVAILABLE,
  LAUNCHER_ERROR_PATH_REJECTED,
} from "../../../shared/launcher/contract";
import { isTauriRuntime } from "../../cowork/cowork-helpers";
import { API_BASE } from "../../utils/fileUpload";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// Map the server's stable `code` field (POST /api/launcher/working-directory,
// `src/server/launcher/api-routes.ts`) to fixed client strings. We deliberately
// DO NOT render the server's `body.message` — it's free-form text and rendering
// it verbatim would violate the "fixed strings only — never include raw
// err.message/paths in the banner" invariant the moment a future server change
// interpolated the submitted path into `message`. Unknown codes fall back to a
// generic string so a new server-side code can't leak through.
function workingDirErrorForCode(code: unknown): string {
  switch (code) {
    case LAUNCHER_ERROR_PATH_REJECTED:
      return "Working directory must be a folder inside your home directory.";
    case LAUNCHER_ERROR_INVALID_BODY:
      return "Working directory path is invalid.";
    case LAUNCHER_ERROR_IN_PROGRESS:
      return "Another working-directory update is in progress. Try again.";
    case LAUNCHER_ERROR_NO_INTEGRATION:
      return "No Claude Code integration is configured.";
    case LAUNCHER_ERROR_NOT_AVAILABLE:
      return "Auto-launcher is not available in this Tandem build.";
    default:
      return "Couldn't save working directory.";
  }
}

// Keep `$props()` as a single proxy variable and read fields via `ctx.foo`.
// Capturing into a local and then destructuring (`let c = $props(); let { settings } = c`)
// would freeze the inner getters at mount (feedback_svelte_getter_destructuring).
let ctx: SettingsTabContext = $props();

function openWizard() {
  // Custom event picked up by App.svelte. Avoids threading a callback through
  // every SettingsModal tab; the modal owner already listens for tab actions.
  window.dispatchEvent(new CustomEvent("tandem:open-integration-wizard"));
}

// --- workingDirectory picker (#477 PR 4b) ---------------------------------
// State here is local to this mount — the settings ctx targets useTandemSettings,
// while workingDirectory lives on the claude-code integration in integrations.json.

let workingDirectory = $state<string | null>(null);
let wdInflight = $state(false);
let wdError = $state<string | null>(null);
let wdLoaded = $state(false);
let hasIntegration = $state(false);
/**
 * Captures the load-failure reason so the UI can surface a banner instead
 * of silently hiding the working-directory section. `null` means either
 * "load hasn't completed yet" (gated by `wdLoaded`) or "load succeeded but
 * no claude-code integration was returned" — both pre-existing states.
 */
let lastLoadError = $state<string | null>(null);

/**
 * #1022 discoverability: a user with Claude credentials but no configured
 * integration used to land on this tab and find only a buried "Reopen
 * integration wizard…" button — nothing said AI wasn't set up or that no API
 * key is needed. Show a prominent "Connect AI" callout once the integrations
 * load has settled and found no claude-code entry. Suppressed while loading
 * and on load failure (the error banner below owns that state — we don't
 * know whether an integration exists, so claiming "no AI connected" would
 * be a guess).
 */
const showConnectCallout = $derived(wdLoaded && !hasIntegration && !lastLoadError);

// Mounted-guard for async fetch — matches the pattern in TitleBar.svelte
// (search "mounted = true" / "if (!mounted) return"). Without it,
// `loadWorkingDirectory` writes to `$state` after the component unmounts,
// which Svelte will not warn about but is a leak nonetheless.
let mounted = true;
onDestroy(() => {
  mounted = false;
});

async function loadWorkingDirectory() {
  try {
    const res = await fetch(`${API_BASE}/api/integrations`);
    if (!mounted) return;
    if (!res.ok) {
      lastLoadError = `Failed to load integrations (HTTP ${res.status}).`;
      return;
    }
    const file = (await res.json()) as {
      integrations?: { kind?: string; workingDirectory?: string }[];
    };
    if (!mounted) return;
    const entry = file.integrations?.find((i) => i.kind === "claude-code");
    if (entry) {
      hasIntegration = true;
      workingDirectory = entry.workingDirectory ?? null;
    }
  } catch (err) {
    if (!mounted) return;
    // Fixed-string banner — don't leak `err.message` to the user (the message
    // can contain absolute paths and URLs from the underlying fetch error).
    // Debug detail still goes to the console for developer triage.
    console.warn("[Settings] Failed to load workingDirectory:", err);
    lastLoadError = "Couldn't load Claude working directory.";
  } finally {
    if (mounted) wdLoaded = true;
  }
}

void loadWorkingDirectory();

async function persistWorkingDirectory(value: string | null) {
  wdInflight = true;
  wdError = null;
  try {
    const res = await fetch(`${API_BASE}${API_LAUNCHER_WORKING_DIRECTORY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workingDirectory: value }),
    });
    if (!mounted) return;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      if (!mounted) return;
      // Map the server's stable `code` to a fixed string — never render the
      // server's free-form `message` (see `workingDirErrorForCode`).
      wdError = workingDirErrorForCode(body.code);
      return;
    }
    const body = (await res.json()) as { workingDirectory?: string | null };
    if (!mounted) return;
    workingDirectory = body.workingDirectory ?? null;
    // Fixed-string success toast (E5). Never include `err.message` or the
    // resolved path — the toast surface is shared with other warnings and
    // path leakage isn't appropriate there.
    ctx.notify("info", "Working directory saved.");
  } catch (err) {
    if (!mounted) return;
    // Fixed-string banner — `err.message` can carry absolute paths / URLs
    // from the underlying fetch failure. Detail goes to the console only.
    console.warn("[Settings] Failed to save workingDirectory:", err);
    wdError = "Couldn't save working directory.";
  } finally {
    if (mounted) wdInflight = false;
  }
}

async function pickFolder() {
  // Split the try-blocks so a dynamic-import failure (plugin missing /
  // not registered) is distinguishable from an `open()` rejection
  // (permission denied, IPC failure, user-cancel-with-error). Both
  // notifications use fixed strings — raw `err.message` can include
  // absolute paths from Tauri's IPC error envelopes.
  let openFn: typeof import("@tauri-apps/plugin-dialog").open;
  try {
    ({ open: openFn } = await import("@tauri-apps/plugin-dialog"));
  } catch (err) {
    console.warn("[Settings] Folder picker import failed:", err);
    ctx.notify("error", "Folder picker plugin unavailable");
    return;
  }
  try {
    const selected = await openFn({
      directory: true,
      multiple: false,
      title: "Choose Claude working directory",
    });
    if (typeof selected === "string") {
      void persistWorkingDirectory(selected);
    }
  } catch (err) {
    console.warn("[Settings] Folder picker open() failed:", err);
    ctx.notify("error", "Folder picker permission denied or IPC error");
  }
}

function handleManualSave(e: SubmitEvent) {
  e.preventDefault();
  const input = (e.target as HTMLFormElement).elements.namedItem("wd") as HTMLInputElement | null;
  const value = input?.value.trim();
  void persistWorkingDirectory(value ? value : null);
}

function handleReset() {
  void persistWorkingDirectory(null);
}
</script>

{#if showConnectCallout}
  <div
    data-testid="settings-modal-connect-ai-callout"
    style="display: flex; flex-direction: column; align-items: flex-start; gap: var(--tandem-space-2); padding: var(--tandem-space-3); background: var(--tandem-info-bg); border: 1px solid var(--tandem-info-border); border-radius: var(--tandem-r-3); margin-bottom: var(--tandem-space-3);"
  >
    <div style="font-size: 13px; font-weight: 600; color: var(--tandem-info-fg-strong);">
      No AI connected yet
    </div>
    <div style="font-size: 12px; line-height: 1.5; color: var(--tandem-info-fg);">
      Tandem's AI works through Claude Code or Claude Desktop using your existing Claude
      sign-in — no API key needed. The setup wizard connects it in one step.
    </div>
    <button
      type="button"
      onclick={openWizard}
      data-testid="settings-modal-connect-ai-btn"
      style="font-size: 12px; font-weight: 500; padding: var(--tandem-space-2) var(--tandem-space-3); border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-accent); background: var(--tandem-accent); color: var(--tandem-accent-fg); cursor: pointer;"
    >
      Connect AI…
    </button>
  </div>
{/if}

<p
  style="font-size: 12px; line-height: 1.5; color: var(--tandem-fg-muted); margin: 0 0 var(--tandem-space-3);"
>
  Tandem connects to any MCP-capable AI client over its MCP endpoint. Claude (Claude Code and
  Claude Desktop) is the default integration — auto-configured, tested, and the only client whose
  channel-push, cowork, and auto-launch extras are validated today. Other clients can connect
  manually using the MCP endpoint on the Network tab.
</p>

<div>
  <div class="settings-section-label">
    Selection Sensitivity:
    <span style="font-weight: 400; text-transform: none;">
      {(ctx.settings.selectionDwellMs / 1000).toFixed(1)}s
    </span>
  </div>
  <div class="settings-hint" style="margin-bottom: 6px;">
    How long you must hold a selection before your AI notices it
  </div>
  <input
    data-testid="settings-modal-dwell-time-slider"
    type="range"
    min={SELECTION_DWELL_MIN_MS}
    max={SELECTION_DWELL_MAX_MS}
    step={100}
    value={ctx.settings.selectionDwellMs}
    oninput={(e) =>
      ctx.onUpdate({ selectionDwellMs: Number((e.target as HTMLInputElement).value) })}
    style="width: 100%; accent-color: var(--tandem-accent);"
    aria-label="Selection dwell time"
  />
  <div
    style="display: flex; justify-content: space-between; font-size: 10px; color: var(--tandem-fg-subtle);"
  >
    <span>{(SELECTION_DWELL_MIN_MS / 1000).toFixed(1)}s</span>
    <span>{(SELECTION_DWELL_MAX_MS / 1000).toFixed(1)}s</span>
  </div>
</div>

<label
  data-testid="settings-modal-selection-toolbar-toggle"
  style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;"
>
  <input
    type="checkbox"
    checked={ctx.settings.selectionToolbar}
    onchange={(e) =>
      ctx.onUpdate({ selectionToolbar: (e.target as HTMLInputElement).checked })}
    style="accent-color: var(--tandem-accent);"
  />
  <span>Show floating selection toolbar</span>
</label>

<label
  data-testid="settings-modal-margin-view-toggle"
  style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;"
>
  <input
    type="checkbox"
    checked={ctx.settings.marginView}
    onchange={(e) => ctx.onUpdate({ marginView: (e.target as HTMLInputElement).checked })}
    style="accent-color: var(--tandem-accent);"
  />
  <span>Margin annotation view (Word-style)</span>
</label>
<div
  data-testid="settings-modal-margin-view-hint"
  style="font-size: 10px; color: var(--tandem-fg-subtle);"
>
  Margin columns appear where rails are collapsed — open rails hide that side.
</div>

{#if wdLoaded && !hasIntegration && lastLoadError}
  <div
    role="alert"
    data-testid="settings-modal-working-directory-load-error"
    style="font-size: 11px; color: var(--tandem-error-fg); background: var(--tandem-error-bg); border: 1px solid var(--tandem-error-border); border-radius: var(--tandem-r-2); padding: var(--tandem-space-2);"
  >
    {lastLoadError}
  </div>
{/if}

{#if wdLoaded && hasIntegration}
  <div data-testid="settings-modal-working-directory" style="display: flex; flex-direction: column; gap: var(--tandem-space-2);">
    <div class="settings-section-label">Claude working directory</div>
    <div class="settings-hint">
      Folder where Claude launches. Defaults to your home directory if empty.
    </div>
    <form onsubmit={handleManualSave} style="display: flex; gap: var(--tandem-space-2);">
      <input
        type="text"
        name="wd"
        value={workingDirectory ?? ""}
        placeholder={"(default: home)"}
        disabled={wdInflight}
        data-testid="settings-modal-working-directory-input"
        style="flex: 1; font-size: 12px; padding: var(--tandem-space-2); border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-border); background: var(--tandem-surface); color: var(--tandem-fg); font-family: var(--tandem-font-mono);"
      />
      <button
        type="submit"
        disabled={wdInflight}
        data-testid="settings-modal-working-directory-save"
        style="font-size: 12px; padding: var(--tandem-space-2) var(--tandem-space-3); border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-border); background: var(--tandem-surface-muted); color: var(--tandem-fg); cursor: pointer;"
      >Save</button>
    </form>
    <div style="display: flex; gap: var(--tandem-space-2);">
      {#if isTauriRuntime()}
        <button
          type="button"
          onclick={pickFolder}
          disabled={wdInflight}
          data-testid="settings-modal-working-directory-pick"
          style="font-size: 12px; padding: var(--tandem-space-2) var(--tandem-space-3); border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-border); background: var(--tandem-surface-muted); color: var(--tandem-fg); cursor: pointer;"
        >Choose folder…</button>
      {/if}
      <button
        type="button"
        onclick={handleReset}
        disabled={wdInflight || workingDirectory === null}
        data-testid="settings-modal-working-directory-reset"
        style="font-size: 12px; padding: var(--tandem-space-2) var(--tandem-space-3); border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-border); background: transparent; color: var(--tandem-fg-muted); cursor: pointer;"
      >Reset to default</button>
    </div>
    {#if wdError}
      <div role="alert" style="font-size: 11px; color: var(--tandem-error-fg);">
        {wdError}
      </div>
    {/if}
  </div>
{/if}

<button
  type="button"
  onclick={openWizard}
  data-testid="settings-modal-open-integration-wizard"
  style="font-size: 12px; padding: var(--tandem-space-2) var(--tandem-space-3); border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-border); background: var(--tandem-surface-muted); color: var(--tandem-fg); cursor: pointer; align-self: flex-start;"
>
  <!-- "Reopen" reads as a power-user re-entry; for an unconfigured user this
       is the setup entry point, so the label adapts (#1022). Keyed off the
       load-settled callout state (not `hasIntegration` directly) so configured
       users keep the historical "Reopen…" label during the brief integrations
       fetch instead of seeing it flicker. -->
  {showConnectCallout ? "Open integration wizard…" : "Reopen integration wizard…"}
</button>

{#if isTauriRuntime()}
  {#await import("../CoworkSettings.svelte")}
    <div
      data-testid="settings-modal-cowork-suspense-fallback"
      style="font-size: 12px; color: var(--tandem-fg-subtle);"
    >
      Loading Cowork integration...
    </div>
  {:then mod}
    {@const CoworkSettingsComp = mod.default}
    <CoworkSettingsComp />
  {/await}
{/if}
