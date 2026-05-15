<script lang="ts">
import { createUpdateAvailable } from "../hooks/useUpdateAvailable.svelte";

const updater = createUpdateAvailable();
</script>

{#if updater.showDot}
  <span data-testid="titlebar-update-available-dot"></span>
{/if}
<button type="button" data-testid="harness-acknowledge" onclick={() => updater.acknowledge()}>
  acknowledge
</button>
<output data-testid="harness-version">{updater.availableVersion ?? ""}</output>
