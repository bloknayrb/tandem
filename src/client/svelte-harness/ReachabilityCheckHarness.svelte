<script lang="ts">
import { untrack } from "svelte";
import {
  createReachabilityCheck,
  type ReachabilityCheckOptions,
  type ReachabilityCheckState,
  type ReachabilityTarget,
} from "../hooks/useReachabilityCheck.svelte.js";

interface Props {
  onReady: (state: ReachabilityCheckState) => void;
  targets?: ReachabilityTarget[];
  active?: boolean;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  opts?: ReachabilityCheckOptions;
}

let {
  onReady,
  targets = [],
  active = true,
  baseUrl = "",
  fetchFn = globalThis.fetch.bind(globalThis),
  opts = {},
}: Props = $props();

// Created once at mount inside a real component context (so the hook's
// onDestroy/setInterval cleanup wires up). Deps read live props so a test can
// flip `active`/`targets` via re-render to exercise (de)activation.
const reachability = untrack(() =>
  createReachabilityCheck(
    () => targets,
    () => active,
    baseUrl,
    fetchFn,
    opts,
  ),
);
$effect(() => {
  onReady(reachability);
});
</script>

<div
  data-testid="reachability-harness"
  data-phase={reachability.phase}
  data-server-up={reachability.serverUp ?? ""}
  data-claude-connected={reachability.claudeConnected}
></div>
