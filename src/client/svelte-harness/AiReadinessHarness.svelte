<script lang="ts">
import { untrack } from "svelte";
import { type AiReadiness, createAiReadiness } from "../hooks/useAiReadiness.svelte";

interface Props {
  onReady: (readiness: AiReadiness) => void;
  connected?: boolean;
  firstRunSettled?: boolean;
  soloMode?: boolean;
}

let { onReady, connected = true, firstRunSettled = true, soloMode = false }: Props = $props();

// Created once at mount (inside a real component context so the hook's
// onDestroy/setInterval cleanup wires up). The deps read live prop values so a
// test can flip e.g. soloMode and re-render to exercise reactivity.
const readiness = untrack(() =>
  createAiReadiness({
    connected: () => connected,
    firstRunSettled: () => firstRunSettled,
    soloMode: () => soloMode,
  }),
);
$effect(() => {
  onReady(readiness);
});
</script>

<div
  data-testid="ai-readiness-harness"
  data-state={readiness.state}
  data-chip={readiness.chip ?? ""}
></div>
