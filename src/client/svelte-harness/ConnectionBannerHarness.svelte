<script lang="ts">
import ConnectionBanner from "../components/ConnectionBanner.svelte";
import { createConnectionBanner } from "../hooks/useConnectionBanner.svelte";

interface Props {
  disconnectedSince: number | null;
}

let { disconnectedSince = $bindable(null) }: Props = $props();

const banner = createConnectionBanner(() => disconnectedSince);
</script>

{#if banner.showBanner}
  <ConnectionBanner onDismiss={banner.dismiss} />
{/if}
