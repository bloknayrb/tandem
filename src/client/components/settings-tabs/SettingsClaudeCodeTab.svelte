<script lang="ts">
import { SELECTION_DWELL_MAX_MS, SELECTION_DWELL_MIN_MS } from "../../../shared/constants";
import { isTauriRuntime } from "../../cowork/cowork-helpers";
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

<!--
  PR 3c-ii-b: the preview toggle is gone. The wizard auto-opens on first
  run (server-driven via GET /api/integrations/first-run-needed); this
  button manually reopens it after dismissal.
-->
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
