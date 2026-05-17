<script lang="ts">
import { SELECTION_DWELL_MAX_MS, SELECTION_DWELL_MIN_MS } from "../../../shared/constants";
import { isTauriRuntime } from "../../cowork/cowork-helpers";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// Keep `$props()` as a single proxy variable and read fields via `ctx.foo`.
// Capturing into a local and then destructuring (`let c = $props(); let { settings } = c`)
// would freeze the inner getters at mount (feedback_svelte_getter_destructuring).
let ctx: SettingsTabContext = $props();
</script>

<div>
  <div class="settings-section-label">
    Selection Sensitivity:
    <span style="font-weight: 400; text-transform: none;">
      {(ctx.settings.selectionDwellMs / 1000).toFixed(1)}s
    </span>
  </div>
  <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-bottom: 6px;">
    How long you must hold a selection before Claude notices it
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
