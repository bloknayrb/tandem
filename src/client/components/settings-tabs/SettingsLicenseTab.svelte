<script lang="ts">
import { TANDEM_PURCHASE_URL, TANDEM_SUPPORT_EMAIL } from "../../../shared/constants";
import { unverifiableLicenseMessage } from "../../../shared/license-copy";
import { licenseStore } from "../../hooks/useLicense.svelte";
import LicenseActivateForm from "../LicenseActivateForm.svelte";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// Settings → License (#1116). Shows the current status and reuses the shared
// activation form. Keep `$props()` as a single proxy and read via `ctx.foo`.
// (Destructuring `$props()` directly stays reactive — the compiler rewrites it
// to getters. What breaks is capturing into a local FIRST and then
// destructuring that: `let c = $props(); let { notify } = c` freezes at mount.)
let ctx: SettingsTabContext = $props();

const ui = $derived(licenseStore.ui);
const status = $derived(licenseStore.status);
// Pre-flip (gate dark) `statusLabel` is "". The old fallback read "No license
// required", which tells a beta tester holding a free license that it's
// unnecessary — so they archive it, and then need it at the v1.0 flip. Say what
// is actually true instead: enforcement is off in THIS version.
const pillLabel = $derived(ui.statusLabel || "Not enforced in this version");
const gateDark = $derived(status != null && !status.gateActive);

function onActivated(): void {
  ctx.notify("info", "License activated.");
}
</script>

<div data-testid="license-settings-section">
  <div class="settings-section-label">License status</div>
  <div class="license-pill" data-testid="license-status-pill">{pillLabel}</div>

  {#if gateDark}
    <div class="settings-hint" data-testid="license-gate-dark-hint">
      Tandem doesn't require a license yet. If you've already been sent one, activate it now —
      it will be needed in a future version, and a key that's been archived is easy to lose.
    </div>
  {/if}

  {#if status?.gateActive && status.status === "licensed" && !status.updateWindowCurrent}
    <!-- The only in-app signal that updates have stopped. The updater itself
         reports "You're up to date" in this state, because a lapsed window is
         served the same no-update response as having nothing to install — so
         without this line the user has no way to learn it. -->
    <div class="license-warning" data-testid="license-update-window-ended">
      Your update window has ended. Tandem keeps running exactly as it is, forever — but new
      releases are no longer offered on this device. Renew to receive updates again.
    </div>
  {/if}

  {#if status?.licenseUnverifiable}
    <div class="license-warning" data-testid="license-unverifiable-warning" role="alert">
      {unverifiableLicenseMessage(status.licenseUnverifiable)}
    </div>
  {/if}

  <div class="settings-section-label" style="margin-top: var(--tandem-space-4);">
    Activate a license
  </div>
  <LicenseActivateForm {onActivated} />
  <div class="settings-hint" style="margin-top: var(--tandem-space-1);">
    Paste a license key you received by email, or run <code>tandem activate &lt;file&gt;</code> from
    the command line. A valid license unlocks editing and runs forever; the update window is
    separate and is shown above once activated.
  </div>
  <div class="settings-hint" style="margin-top: var(--tandem-space-2);">
    Don't have one yet?
    <a
      data-testid="license-buy-link"
      href={TANDEM_PURCHASE_URL}
      target="_blank"
      rel="noopener noreferrer">Buy a license</a
    >. Trouble activating? Email
    <a href="mailto:{TANDEM_SUPPORT_EMAIL}">{TANDEM_SUPPORT_EMAIL}</a> — please don't post your
    license key publicly, it contains your name and email address.
  </div>
</div>

<style>
.license-warning {
  margin-top: var(--tandem-space-2);
  padding: var(--tandem-space-2) var(--tandem-space-3);
  font-size: var(--tandem-text-sm);
  line-height: 1.5;
  color: var(--tandem-warning-fg-strong);
  background: var(--tandem-warning-bg);
  border: 1px solid var(--tandem-warning-border);
  border-radius: var(--tandem-r-2);
}
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
