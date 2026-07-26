<script lang="ts">
import { TANDEM_PURCHASE_URL } from "../../shared/constants";
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
        of 14 {ui.trialDaysRemaining === 1 ? "day" : "days"} left in your Tandem trial.
      {:else}
        You're on a 14-day Tandem trial.
      {/if}
      <!-- A purchase link, not just "activate a license": telling someone their
           trial is ending without saying where to buy one is a dead end. -->
      <a
        class="license-trial-banner__buy"
        data-testid="license-trial-buy"
        href={TANDEM_PURCHASE_URL}
        target="_blank"
        rel="noopener noreferrer">Buy a license</a
      >
      to keep editing when it ends, or activate one in Settings → License.
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
.license-trial-banner__buy {
  color: inherit;
  font-weight: 600;
  text-decoration: underline;
}
</style>
