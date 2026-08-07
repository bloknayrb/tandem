<script lang="ts">
import { untrack } from "svelte";
import {
  type CwdDriftOptions,
  type CwdDriftState,
  createCwdDrift,
} from "../hooks/useCwdDrift.svelte.js";

/**
 * Mount host for `createCwdDrift` (#1282). The hook owns an `$effect` and an
 * `onDestroy`, so it needs a real component context — a bare call from a test
 * would neither track its inputs nor clean up. Mirrors `ReachabilityCheckHarness`.
 */

interface Props {
  onReady: (state: CwdDriftState) => void;
  cwd?: string | null;
  opts?: CwdDriftOptions;
}

let { onReady, cwd = null, opts = {} }: Props = $props();

// Created once at mount; the dep reads the live prop so a test can drive
// tab switches by re-rendering with a new `cwd`.
const drift = untrack(() => createCwdDrift(() => cwd, opts));

$effect(() => {
  onReady(drift);
});
</script>

<div
  data-testid="cwd-drift-harness"
  data-label={drift.drift?.label ?? ""}
  data-claude-label={drift.drift?.claudeLabel ?? ""}
></div>
