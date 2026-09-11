<script lang="ts">
/** #1824 item L test harness — wraps a child that throws inside `$effect`. */
import ErrorBoundary from "../../../src/client/components/ErrorBoundary.svelte";
import ThrowingChild from "./ThrowingChild.svelte";
</script>

<ErrorBoundary>
  <ThrowingChild />
</ErrorBoundary>
