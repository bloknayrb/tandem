<script lang="ts">
  import { DISCONNECT_DEBOUNCE_MS } from "../../shared/constants";

  interface Props {
    connected: boolean;
    claudeActive: boolean;
  }

  let { connected, claudeActive }: Props = $props();

  let showDisconnected = $state(false);

  $effect(() => {
    if (connected) {
      showDisconnected = false;
      return;
    }
    const timer = setTimeout(() => { showDisconnected = true; }, DISCONNECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });
</script>

<div
  style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--tandem-fg-subtle); gap: 8px;"
>
  {#if showDisconnected}
    <span>Cannot reach the Tandem server. Is it running?</span>
  {:else}
    <span>No document open. Click + in the tab bar or drop a file here.</span>
    {#if connected && !claudeActive}
      <span style="font-size: 0.85em; color: var(--tandem-fg-subtle);">
        Tip: open Claude Code in this directory to start collaborating
      </span>
    {/if}
  {/if}
</div>
