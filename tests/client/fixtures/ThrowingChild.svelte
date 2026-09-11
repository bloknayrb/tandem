<script lang="ts">
/**
 * #1824 item L test fixture. Throws inside an `$effect`, matching the
 * ErrorBoundary docblock's stated coverage ("render-time errors, including
 * throws inside `$effect`") rather than a synchronous render-time throw.
 */
$effect(() => {
  throw new Error("boom (#1824 item L fixture)");
});
</script>
