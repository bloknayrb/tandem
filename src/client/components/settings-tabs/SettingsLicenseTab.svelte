<script lang="ts">
import { licenseStore } from "../../hooks/useLicense.svelte";
import LicenseActivateForm from "../LicenseActivateForm.svelte";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// Settings → License (#1116). Shows the current status and reuses the shared
// activation form. Keep `$props()` as a single proxy and read via `ctx.foo`
// (destructuring would freeze the getters at mount).
let ctx: SettingsTabContext = $props();

const ui = $derived(licenseStore.ui);
const pillLabel = $derived(ui.statusLabel || "No license required");

function onActivated(): void {
  ctx.notify("info", "License activated.");
}
</script>

<div data-testid="license-settings-section">
  <div class="settings-section-label">License status</div>
  <div class="license-pill" data-testid="license-status-pill">{pillLabel}</div>

  <div class="settings-section-label" style="margin-top: var(--tandem-space-4);">
    Activate a license
  </div>
  <LicenseActivateForm {onActivated} />
  <div class="settings-hint" style="margin-top: var(--tandem-space-1);">
    Paste a license key you received by email, or run <code>tandem activate &lt;file&gt;</code> from
    the command line. A valid license unlocks editing and runs forever.
  </div>
</div>

<style>
.license-pill {
  display: inline-block;
  padding: var(--tandem-space-1) var(--tandem-space-3);
  font-size: var(--tandem-text-sm);
  color: var(--tandem-fg);
  background: var(--tandem-surface-sunken, var(--tandem-surface));
  border: 1px solid var(--tandem-border);
  border-radius: var(--tandem-r-pill);
}
</style>
