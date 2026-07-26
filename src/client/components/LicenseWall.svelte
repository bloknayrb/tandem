<script lang="ts">
import { TANDEM_PURCHASE_URL, TANDEM_SUPPORT_EMAIL } from "../../shared/constants";
import { licenseStore } from "../hooks/useLicense.svelte";
import LicenseActivateForm from "./LicenseActivateForm.svelte";

// Restricted-mode activation wall (#1116). Renders only when the trial has
// ended with no license. The escape hatch holds: the editor underneath is the
// user's document, and open/read/export + chat stay available — this overlay
// gates editing, not access. On successful activation the store flips to
// `licensed`, `ui.showWall` goes false, and the wall unmounts.
//
// The escape hatch has to be REACHABLE, not just true. A full-bleed `inset: 0`
// scrim covers the right rail where chat lives and every route to export, so
// the old copy ("you can still read and export them, and chat with Claude")
// was falsified by the thing saying it. Hence the dismiss below: it steps the
// user into read-only mode rather than trapping them behind a promise the
// overlay itself prevents them from acting on.
const ui = $derived(licenseStore.ui);
const status = $derived(licenseStore.status);

let dismissed = $state(false);
let dialogEl = $state<HTMLElement | null>(null);

const visible = $derived(ui.showWall && !dismissed);

// Re-arm the wall if the user leaves restricted mode and comes back (e.g. a
// license activated elsewhere later lapses). Without this, one dismissal would
// suppress the wall for the rest of the session.
$effect(() => {
  if (!ui.showWall) dismissed = false;
});

// Focus the dialog when it appears so the trap below has an anchor and a
// keyboard user isn't left with focus in the now-unreachable editor.
$effect(() => {
  if (visible && dialogEl) dialogEl.focus();
});

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Tab focus trap — the dialog claims `aria-modal="true"`, so it owes one. */
function trapTab(e: KeyboardEvent): void {
  if (e.key !== "Tab" || !dialogEl) return;
  const focusables = Array.from(dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null,
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === dialogEl)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    dismissed = true;
    return;
  }
  trapTab(e);
}
</script>

{#if visible}
  <div
    class="license-wall-backdrop"
    data-testid="license-wall"
    role="dialog"
    aria-modal="true"
    aria-labelledby="license-wall-heading"
    tabindex="-1"
    bind:this={dialogEl}
    onkeydown={onKeydown}
  >
    <div class="license-wall-dialog">
      <h2 class="license-wall-heading" id="license-wall-heading">Your trial has ended</h2>
      {#if status?.licenseUnverifiable}
        <p class="license-wall-body" data-testid="license-wall-unverifiable">
          A license is installed on this device, but Tandem couldn't verify it — it may have
          been issued before a signing-key change, or the file may be damaged. Paste it again
          below, or email
          <a href="mailto:{TANDEM_SUPPORT_EMAIL}">{TANDEM_SUPPORT_EMAIL}</a> to have it reissued.
        </p>
      {:else}
        <p class="license-wall-body">
          Your 14-day trial is over. Activate a license to keep editing — or continue in
          read-only mode, where your documents stay open for reading, exporting, and chatting
          with Claude.
        </p>
      {/if}
      <LicenseActivateForm />
      <div class="license-wall-actions">
        <button
          type="button"
          class="license-wall-dismiss"
          data-testid="license-wall-dismiss"
          onclick={() => (dismissed = true)}
        >
          Continue in read-only mode
        </button>
        <a
          class="license-wall-buy"
          data-testid="license-wall-buy"
          href={TANDEM_PURCHASE_URL}
          target="_blank"
          rel="noopener noreferrer">Buy a license</a
        >
      </div>
      <p class="license-wall-support">
        Trouble activating? Email
        <a href="mailto:{TANDEM_SUPPORT_EMAIL}">{TANDEM_SUPPORT_EMAIL}</a>. Please don't post
        your license key publicly — it contains your name and email address.
      </p>
    </div>
  </div>
{/if}

<style>
.license-wall-backdrop {
  position: fixed;
  inset: 0;
  /* Must clear --tandem-z-titlebar (99999), which tauri-plugin-decorum's
     overlay lifts the title bar to. Every other full-screen modal in the app
     uses this token; --tandem-z-tooltip (10000) left the title bar rendering
     ON TOP of the wall, un-scrimmed. */
  z-index: var(--tandem-z-above-titlebar);
  display: flex;
  align-items: center;
  justify-content: center;
  /* Neutral scrim — exempt from the semantic-token rule. */
  background: rgba(0, 0, 0, 0.5);
}
.license-wall-dialog {
  width: 90%;
  max-width: 460px;
  padding: var(--tandem-space-5);
  background: var(--tandem-surface);
  border: 1px solid var(--tandem-border-strong);
  border-radius: var(--tandem-r-3);
  box-shadow: var(--tandem-shadow-4);
}
.license-wall-heading {
  margin: 0 0 var(--tandem-space-2);
  font-size: var(--tandem-text-lg);
  color: var(--tandem-fg);
}
.license-wall-body {
  margin: 0 0 var(--tandem-space-4);
  font-size: var(--tandem-text-sm);
  line-height: 1.5;
  color: var(--tandem-fg-muted);
}
.license-wall-actions {
  display: flex;
  align-items: center;
  gap: var(--tandem-space-3);
  margin-top: var(--tandem-space-3);
}
.license-wall-dismiss {
  padding: var(--tandem-space-2) var(--tandem-space-3);
  font-size: var(--tandem-text-sm);
  color: var(--tandem-fg-muted);
  background: transparent;
  border: 1px solid var(--tandem-border);
  border-radius: var(--tandem-r-2);
  cursor: pointer;
}
.license-wall-dismiss:hover {
  color: var(--tandem-fg);
  border-color: var(--tandem-border-strong);
}
.license-wall-buy,
.license-wall-support a {
  font-size: var(--tandem-text-sm);
  color: var(--tandem-accent-fg-strong, var(--tandem-fg));
}
.license-wall-support {
  margin: var(--tandem-space-4) 0 0;
  font-size: var(--tandem-text-xs);
  line-height: 1.5;
  color: var(--tandem-fg-muted);
}
</style>
