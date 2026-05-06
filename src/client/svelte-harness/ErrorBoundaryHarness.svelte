<script lang="ts">
import ErrorBoundary from "../components/ErrorBoundary.svelte";
import ThrowOnRender from "./ThrowOnRender.svelte";

interface Props {
  shouldThrow?: boolean;
}

let { shouldThrow = true }: Props = $props();
</script>

<ErrorBoundary>
  <ThrowOnRender {shouldThrow} />
</ErrorBoundary>
