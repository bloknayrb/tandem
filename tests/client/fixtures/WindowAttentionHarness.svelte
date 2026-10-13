<script lang="ts">
import { createWindowAttention } from "../../../src/client/hooks/useWindowAttention.svelte";

let { visibleCountsAsActive = false }: { visibleCountsAsActive?: boolean } = $props();
const attention = createWindowAttention({
  visibleCountsAsActive: () => visibleCountsAsActive,
});
</script>

<output data-testid="active">{attention.active}</output>
