<script lang="ts">
import { TANDEM_PURCHASE_URL, TANDEM_SUPPORT_EMAIL } from "../../../shared/constants";
import { unverifiableLicenseMessage } from "../../../shared/license-copy";
import { isTauriRuntime } from "../../cowork/cowork-helpers";
import { licenseStore } from "../../hooks/useLicense.svelte";
import LicenseActivateForm from "../LicenseActivateForm.svelte";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// Settings → License (#1116). Shows the current status and reuses the shared
// activation form. Keep `$props()` as a single proxy and read via `ctx.foo`.
// (Destructuring `$props()` directly stays reactive — the compiler rewrites it
// to getters. What breaks is capturing into a local FIRST and then
// destructuring that: `let c = $props(); let { notify } = c` freezes at mount.)
let ctx: SettingsTabContext = $props();

// Captured once at init, not derived: the runtime never changes under a live
// component, and `EditorSettings.svelte` is the precedent for reading this
// discriminant that way.
const isDesktop = isTauriRuntime();

const ui = $derived(licenseStore.ui);
const status = $derived(licenseStore.status);
const statusUnavailable = $derived(licenseStore.statusUnavailable);
// Pre-flip (gate dark) `statusLabel` is "". The old fallback read "No license
// required", which tells a beta tester holding a free license that it's
// unnecessary — so they archive it, and then need it at the v1.0 flip. Say what
// is actually true instead: enforcement is off in THIS version.
// Whether a `tandem activate` would land where the server that answered us
// reads (#1789, review round 1). `isDesktop` alone is a WebView test, and the
// desktop sidecar serves this same client over http://127.0.0.1:3479 — opened
// there in a browser it reads false, so the withdrawn CLI hint came back on the
// one install where running it silently does nothing. Only the server can tell
// the two app-data roots apart, so it answers, and a missing field (LAN-scrubbed
// payload, failed poll, older server) reads as false: hide rather than mislead.
const cliActivateEffective = $derived(status?.cliActivateEffective === true);
const gateDark = $derived(status != null && !status.gateActive);
// On a dark build the gate reports nothing, so `statusLabel` is "". Say whether
// a license is actually installed — otherwise activating one changes nothing on
// screen and the "activate it now" hint below keeps nagging someone who just did.
const darkInstalled = $derived(gateDark && status?.licenseInstalled === true);
// The fallback is gated on `status != null` (#1789). With no status at all —
// a first poll that failed — `gateDark` and `darkInstalled` are both false, so
// the unconditional fallback read "Not enforced in this version": a claim about
// the build flag made from a fetch that never answered. The pill is the
// discriminating surface, so a warning line alone would leave the lie on screen.
const pillLabel = $derived(
  ui.statusLabel ||
    (status == null
      ? "License status unknown"
      : darkInstalled
        ? status.licenseeName
          ? `License installed for ${status.licenseeName} — takes effect at v1.0`
          : "License installed — takes effect at v1.0"
        : "Not enforced in this version"),
);

function onActivated(): void {
  ctx.notify("info", "License activated.");
}
</script>

<div data-testid="license-settings-section">
  <div class="settings-section-label">License status</div>
  <div class="license-pill" data-testid="license-status-pill">{pillLabel}</div>

  {#if gateDark && !darkInstalled}
    <div class="settings-hint" data-testid="license-gate-dark-hint">
      Tandem doesn't require a license yet. If you've already been sent one, activate it now —
      it will be needed in a future version, and a key that's been archived is easy to lose.
    </div>
  {:else if darkInstalled}
    <div class="settings-hint" data-testid="license-dark-installed-hint">
      Your license is saved on this device. Licensing isn't enforced in this version, so nothing
      changes yet — it will take effect automatically at v1.0. Nothing further to do.
    </div>
  {/if}

  {#if status?.gateActive && status.status === "licensed" && !status.updateWindowCurrent}
    <!-- The only in-app signal that updates have stopped. The updater itself
         reports "You're up to date" in this state, because a lapsed window is
         served the same no-update response as having nothing to install — so
         without this line the user has no way to learn it. -->
    <div class="license-warning" data-testid="license-update-window-ended">
      Your update window has ended. Tandem keeps running exactly as it is, forever — but new
      releases are no longer offered on this device.
      <a
        data-testid="license-renew-link"
        href={TANDEM_PURCHASE_URL}
        target="_blank"
        rel="noopener noreferrer">Renew to receive updates again</a
      >.
    </div>
  {/if}

  <!-- The 60 s poll used to swallow every failure (#1789), so this state was
       invisible: either a frozen countdown the server may no longer agree with,
       or — on a first-poll failure — a pill asserting the gate is off. Split on
       whether there is a last known state at all.

       The `role="status"` container is rendered UNCONDITIONALLY and only its
       TEXT is toggled (review round 2). NVDA and JAWS announce changes to a live
       region that was already in the accessibility tree; a node inserted with its
       text already in place is routinely missed — which is the one case this
       block exists for, a screen-reader user sitting on an open Settings →
       License while the poll starts failing. Empty when there is nothing to say,
       so it occupies no space. Polite rather than `role="alert"` (the sibling
       below): it is transient and self-clearing on the next successful poll, so
       it must not interrupt. -->
  <div data-testid="license-status-live-region" role="status">
    {#if statusUnavailable}
      <div class="license-warning" data-testid="license-status-unavailable">
        {#if status != null}
          Tandem couldn't reach its local server, so this is the last known state and it may be
          out of date.
        {:else}
          Tandem hasn't reached its local server yet, so no license state is known on this device.
        {/if}
      </div>
    {/if}
  </div>

  {#if status?.licenseUnverifiable}
    <div class="license-warning" data-testid="license-unverifiable-warning" role="alert">
      {unverifiableLicenseMessage(status.licenseUnverifiable)}
    </div>
  {/if}

  <div class="settings-section-label" style="margin-top: var(--tandem-space-4);">
    Activate a license
  </div>
  <LicenseActivateForm {onActivated} />
  <!-- The CLI clause is browser/npm only (#1789). The desktop bundle ships no
       `tandem` binary — `bundle.resources` carries no `dist/cli` and
       `externalBin` is the two sidecars — and a separately installed npm CLI is
       worse than absent here: it writes `license.json` under its OWN env-paths
       root while the desktop points its sidecar at the Tauri app-data dir, so
       the activation succeeds and the app never sees it. No
       `npm install -g tandem-editor` escape hatch, for that reason.

       BOTH conditions, and the server's is the load-bearing one: `isDesktop` is
       a WebView test, so it misses the desktop's own client served over
       127.0.0.1 in a browser — the same wrong-root no-op, reached by a different
       route. `cliActivateEffective` is the server saying its app-data root is
       the npm one. `isDesktop` stays as the second layer for a desktop build
       whose sidecar somehow resolved the npm root anyway. -->
  <div class="settings-hint" style="margin-top: var(--tandem-space-1);">
    Paste a license key you received by email{#if !isDesktop && cliActivateEffective}, or run
      <code>tandem activate &lt;file&gt;</code> from the command line{/if}. A valid license unlocks
    editing and runs forever; the update window is separate and is shown above once activated.
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
