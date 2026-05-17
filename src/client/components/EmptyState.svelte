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
  const timer = setTimeout(() => {
    showDisconnected = true;
  }, DISCONNECT_DEBOUNCE_MS);
  return () => clearTimeout(timer);
});
</script>

<div
  style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 360px; color: var(--tandem-fg-subtle); gap: 10px; font-family: var(--tandem-font-serif); font-size: 17px; line-height: 1.55; text-align: center;"
>
  {#if showDisconnected}
    <span>Cannot reach the Tandem server. Is it running?</span>
  {:else}
    <span>No document open. Click + in the tab bar or drop a file here.</span>
    {#if connected && !claudeActive}
      <span style="font-family: var(--tandem-font-sans); font-size: 13px; color: var(--tandem-fg-subtle);">
        Tandem works alongside Claude (the default integration) or any MCP-capable AI client.
      </span>
    {/if}
  {/if}
</div>
