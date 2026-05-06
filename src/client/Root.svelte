<script lang="ts">
import App from "./App.svelte";
import ErrorBoundary from "./components/ErrorBoundary.svelte";
</script>

<ErrorBoundary>
  {#snippet children()}
    <App />
  {/snippet}
</ErrorBoundary>
