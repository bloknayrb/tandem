<script lang="ts">
interface Props {
  shouldThrow: boolean;
}

let { shouldThrow }: Props = $props();

$effect(() => {
  if (shouldThrow) throw new Error("test boundary error");
});
</script>

<span data-testid="throw-on-render-ok">ok</span>
