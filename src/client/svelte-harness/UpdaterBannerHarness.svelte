<script lang="ts">
import { createUpdaterBanner } from "../hooks/useUpdaterBanner.svelte";

const banner = createUpdaterBanner();
</script>

{#if banner.showBanner}
  <span data-testid="updater-banner-visible"></span>
{/if}
<button type="button" data-testid="harness-banner-dismiss" onclick={() => banner.dismiss()}>
  dismiss
</button>
<output data-testid="harness-banner-version">{banner.availableVersion ?? ""}</output>
