<script lang="ts">
import { API_LAUNCHER_WORKING_DIRECTORY } from "../../../shared/api-paths";
import { SELECTION_DWELL_MAX_MS, SELECTION_DWELL_MIN_MS } from "../../../shared/constants";
import { isTauriRuntime } from "../../cowork/cowork-helpers";
import { API_BASE } from "../../utils/fileUpload";
import type { SettingsTabContext } from "../SettingsModal.svelte";

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

async function loadWorkingDirectory() {
  try {
    const res = await fetch(`${API_BASE}/api/integrations`);
    if (!res.ok) return;
    const file = (await res.json()) as {
      integrations?: { kind?: string; workingDirectory?: string }[];
    };
    const entry = file.integrations?.find((i) => i.kind === "claude-code");
    if (entry) {
      hasIntegration = true;
      workingDirectory = entry.workingDirectory ?? null;
    }
  } catch (err) {
    console.warn("[Settings] Failed to load workingDirectory:", err);
  } finally {
    wdLoaded = true;
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
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      wdError = body.message ?? `Save failed (${res.status})`;
      return;
    }
    const body = (await res.json()) as { workingDirectory?: string | null };
    workingDirectory = body.workingDirectory ?? null;
  } catch (err) {
    wdError = err instanceof Error ? err.message : String(err);
  } finally {
    wdInflight = false;
  }
}

async function pickFolder() {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose Claude working directory",
    });
    if (typeof selected === "string") {
      void persistWorkingDirectory(selected);
    }
  } catch (err) {
    wdError = `Folder picker unavailable: ${err instanceof Error ? err.message : err}`;
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
  <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-bottom: 6px;">
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

{#if wdLoaded && hasIntegration}
  <div data-testid="settings-modal-working-directory" style="display: flex; flex-direction: column; gap: var(--tandem-space-2);">
    <div class="settings-section-label">Claude working directory</div>
    <div style="font-size: 10px; color: var(--tandem-fg-subtle);">
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
        style="font-size: 12px; padding: var(--tandem-space-2) var(--tandem-space-3); border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-border); background: var(--tandem-surface-elevated); color: var(--tandem-fg); cursor: pointer;"
      >Save</button>
    </form>
    <div style="display: flex; gap: var(--tandem-space-2);">
      {#if isTauriRuntime()}
        <button
          type="button"
          onclick={pickFolder}
          disabled={wdInflight}
          data-testid="settings-modal-working-directory-pick"
          style="font-size: 12px; padding: var(--tandem-space-2) var(--tandem-space-3); border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-border); background: var(--tandem-surface-elevated); color: var(--tandem-fg); cursor: pointer;"
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
  style="font-size: 12px; padding: var(--tandem-space-2) var(--tandem-space-3); border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-border); background: var(--tandem-surface-elevated); color: var(--tandem-fg); cursor: pointer; align-self: flex-start;"
>
  Reopen integration wizard…
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
