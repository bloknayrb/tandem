<script lang="ts">
import { licenseStore } from "../hooks/useLicense.svelte";
import LicenseActivateForm from "./LicenseActivateForm.svelte";

// Restricted-mode activation wall (#1116). Renders only when the trial has
// ended with no license. The escape hatch holds: the editor underneath is the
// user's document, and open/read/export + chat stay available — this overlay
// gates editing, not access. On successful activation the store flips to
// `licensed`, `ui.showWall` goes false, and the wall unmounts.
const ui = $derived(licenseStore.ui);
</script>

{#if ui.showWall}
  <div
    class="license-wall-backdrop"
    data-testid="license-wall"
    role="dialog"
    aria-modal="true"
    aria-labelledby="license-wall-heading"
  >
    <div class="license-wall-dialog">
      <h2 class="license-wall-heading" id="license-wall-heading">Your trial has ended</h2>
      <p class="license-wall-body">
        Activate a license to keep editing. Your documents stay open — you can still read and
        export them, and chat with Claude.
      </p>
      <LicenseActivateForm />
    </div>
  </div>
{/if}

<style>
.license-wall-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--tandem-z-tooltip);
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
</style>
