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
import type { Editor } from "@tiptap/core";
import type { ComponentProps } from "svelte";
import type { Annotation } from "../../shared/types";
import ChatPanel from "../panels/ChatPanel.svelte";
import type { FilterAuthor, FilterStatus, FilterType } from "../panels/FilterBar.svelte";
import SidePanel from "../panels/SidePanel.svelte";
import OutlinePanel from "./OutlinePanel.svelte";

type ChatSlotProps = { kind: "chat"; visible?: boolean } & ComponentProps<typeof ChatPanel>;
type SideSlotProps = { kind: "side"; visible?: boolean } & ComponentProps<typeof SidePanel>;
type OutlineSlotProps = {
  kind: "outline";
  visible?: boolean;
  editor: Editor | null;
  annotations?: Annotation[];
  focusTrigger?: number;
  activeFilterType?: FilterType;
  activeFilterAuthor?: FilterAuthor;
  activeFilterStatus?: FilterStatus;
};

// biome-ignore lint/suspicious/noExplicitAny: discriminated union prop spread
type Props =
  | ChatSlotProps
  | SideSlotProps
  | OutlineSlotProps
  | { kind: "chat" | "side" | "outline"; visible?: boolean; [key: string]: any };

let { kind, visible, ...rest }: Props = $props();

const wrapStyle = $derived(
  visible !== undefined
    ? `display: ${visible ? "flex" : "none"}; flex-direction: column; flex: 1; min-height: 0;`
    : undefined,
);
</script>

{#if wrapStyle}
  <div style={wrapStyle}>
    {#if kind === "chat"}
      <ChatPanel {...(rest as ComponentProps<typeof ChatPanel>)} {visible} />
    {:else if kind === "outline"}
      <OutlinePanel
        editor={(rest as OutlineSlotProps).editor}
        annotations={(rest as OutlineSlotProps).annotations}
        focusTrigger={(rest as OutlineSlotProps).focusTrigger}
        activeFilterType={(rest as OutlineSlotProps).activeFilterType}
        activeFilterAuthor={(rest as OutlineSlotProps).activeFilterAuthor}
        activeFilterStatus={(rest as OutlineSlotProps).activeFilterStatus}
      />
    {:else}
      <SidePanel {...(rest as ComponentProps<typeof SidePanel>)} />
    {/if}
  </div>
{:else if kind === "chat"}
  <ChatPanel {...(rest as ComponentProps<typeof ChatPanel>)} />
{:else if kind === "outline"}
  <OutlinePanel
    editor={(rest as OutlineSlotProps).editor}
    annotations={(rest as OutlineSlotProps).annotations}
    focusTrigger={(rest as OutlineSlotProps).focusTrigger}
    activeFilterType={(rest as OutlineSlotProps).activeFilterType}
  />
{:else}
  <SidePanel {...(rest as ComponentProps<typeof SidePanel>)} />
{/if}
