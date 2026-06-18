<script lang="ts">
import { licenseStore } from "../hooks/useLicense.svelte";

// Trial countdown banner (#1116). Only renders during an active trial; the
// store is dormant (and `ui.showTrialBanner` false) when the gate is dark.
const ui = $derived(licenseStore.ui);
</script>

{#if ui.showTrialBanner}
  <div class="license-trial-banner" role="status" aria-live="polite" data-testid="license-trial-banner">
    <span class="license-trial-banner__text">
      {#if ui.trialDaysRemaining != null}
        <strong data-testid="license-trial-days">{ui.trialDaysRemaining}</strong>
        {ui.trialDaysRemaining === 1 ? "day" : "days"} left in your Tandem trial.
      {:else}
        You're trying Tandem.
      {/if}
      Activate a license in Settings → License to keep editing when it ends.
    </span>
  </div>
{/if}

<style>
.license-trial-banner {
  display: flex;
  align-items: center;
  gap: var(--tandem-space-2);
  padding: var(--tandem-space-2) var(--tandem-space-4);
  font-size: var(--tandem-text-sm);
  color: var(--tandem-warning-fg-strong);
  background: var(--tandem-warning-bg);
  border-bottom: 1px solid var(--tandem-warning-border);
}
.license-trial-banner__text strong {
  font-weight: 700;
}
</style>
