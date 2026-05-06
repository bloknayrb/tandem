<script lang="ts">
/**
 * Sentinel rendered as a sibling to children inside `<svelte:boundary>`. It
 * mounts only when the boundary's success branch is active, so its `$effect`
 * fires exactly when children rendered without throwing. Used by
 * `ErrorBoundary.svelte` to reset the per-error recovery-attempt counter.
 *
 * Effect order matters: place this AFTER `{@render children()}` in source
 * order. Svelte 5 runs `$effect`s in document order during the post-render
 * flush, and a throw aborts the rest of the flush — so any throwing child
 * effect prevents this one from firing on a failed cycle.
 */
interface Props {
  onSuccess: () => void;
}

let { onSuccess }: Props = $props();

$effect(() => {
  onSuccess();
});
</script>
