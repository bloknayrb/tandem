<script lang="ts">
/**
 * Svelte 5 port of `PanelSlot.tsx`.
 *
 * Deviation from 1:1 map: PanelSlot.tsx exports two components (ChatSlot,
 * SideSlot). A .svelte file has one default export, so both are unified here
 * under a `kind` discriminator prop. This matches the intended usage in
 * App.svelte (issue #472).
 *
 * When `visible` is provided the slot wraps its child in a CSS display-flex/none
 * div so the panel stays mounted (preserving local state) while toggling
 * visibility. When `visible` is omitted the panel renders bare (three-panel
 * layout, where both panels are always visible).
 */
import type { ComponentProps } from "svelte";
import ChatPanel from "../panels/ChatPanel.svelte";
import SidePanel from "../panels/SidePanel.svelte";

type ChatSlotProps = { kind: "chat"; visible?: boolean } & ComponentProps<typeof ChatPanel>;
type SideSlotProps = { kind: "side"; visible?: boolean } & ComponentProps<typeof SidePanel>;

// biome-ignore lint/suspicious/noExplicitAny: discriminated union prop spread
type Props =
  | ChatSlotProps
  | SideSlotProps
  | { kind: "chat" | "side"; visible?: boolean; [key: string]: any };

let { kind, visible, ...rest }: Props = $props();

const wrapStyle =
  visible !== undefined
    ? `display: ${visible ? "flex" : "none"}; flex-direction: column; flex: 1; min-height: 0;`
    : undefined;
</script>

{#if wrapStyle}
  <div style={wrapStyle}>
    {#if kind === "chat"}
      <ChatPanel {...(rest as ComponentProps<typeof ChatPanel>)} {visible} />
    {:else}
      <SidePanel {...(rest as ComponentProps<typeof SidePanel>)} />
    {/if}
  </div>
{:else if kind === "chat"}
  <ChatPanel {...(rest as ComponentProps<typeof ChatPanel>)} />
{:else}
  <SidePanel {...(rest as ComponentProps<typeof SidePanel>)} />
{/if}
