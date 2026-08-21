<script lang="ts">
import ConnectionBanner from "../components/ConnectionBanner.svelte";
import { createConnectionBanner } from "../hooks/useConnectionBanner.svelte";

interface Props {
  disconnectedSince: number | null;
}

let { disconnectedSince = $bindable(null) }: Props = $props();

const banner = createConnectionBanner(() => disconnectedSince);
</script>

<!-- #1431: `visible=`, mirroring App.svelte. The gate moved INTO the component
     so its live region can outlive its message; a harness that kept the `{#if}`
     out here would render the real component with its region permanently
     unmounted, and the only test that mounts it would be testing a shape the
     app no longer has. -->
<ConnectionBanner
  visible={banner.showBanner}
  onDismiss={banner.dismiss}
  onRetry={banner.dismiss}
/>
