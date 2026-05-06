<script lang="ts">
import ErrorBoundary from "../components/ErrorBoundary.svelte";
import ThrowOnRender from "./ThrowOnRender.svelte";

interface Props {
  shouldThrow?: boolean;
}

let { shouldThrow = true }: Props = $props();
</script>

<ErrorBoundary>
  {#snippet children()}
    <ThrowOnRender {shouldThrow} />
  {/snippet}
</ErrorBoundary>
