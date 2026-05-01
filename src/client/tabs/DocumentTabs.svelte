<script lang="ts">
import FileOpenDialog from "../components/FileOpenDialog.svelte";
import type { OpenTab } from "../types.js";
import TabItem from "./TabItem.svelte";

interface Props {
  tabs: OpenTab[];
  activeTabId: string | null;
  onTabSwitch: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  reorder?: (fromId: string, toId: string, side?: "left" | "right") => void;
  reduceMotion?: boolean;
}

const {
  tabs,
  activeTabId,
  onTabSwitch,
  onTabClose,
  reorder,
  reduceMotion = false,
}: Props = $props();

const scrollBehavior: ScrollBehavior = $derived(reduceMotion ? "auto" : "smooth");

let showDialog = $state(false);

// Plain let — not reactive UI; just internal close-dedup guard
let closingIds = new Set<string>();

// Clean up stale entries when tabs change (closed tab removed from DOM)
$effect(() => {
  const currentIds = new Set(tabs.map((t) => t.id));
  for (const id of closingIds) {
    if (!currentIds.has(id)) closingIds.delete(id);
  }
});

function guardedClose(tabId: string) {
  if (closingIds.has(tabId)) return;
  closingIds.add(tabId);
  onTabClose(tabId);
}

let scrollEl: HTMLDivElement | undefined = $state();
let canScrollLeft = $state(false);
let canScrollRight = $state(false);
let draggedId = $state<string | null>(null);
let dropTarget = $state<{ id: string; side: "left" | "right" } | null>(null);

function clearDragState() {
  draggedId = null;
  dropTarget = null;
}

function updateScrollState() {
  const el = scrollEl;
  if (!el) return;
  canScrollLeft = el.scrollLeft > 0;
  canScrollRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}

// Set up scroll listeners and resize observer
$effect(() => {
  const el = scrollEl;
  if (!el) return;
  updateScrollState();
  el.addEventListener("scroll", updateScrollState, { passive: true });
  const observer = new ResizeObserver(updateScrollState);
  observer.observe(el);
  return () => {
    el.removeEventListener("scroll", updateScrollState);
    observer.disconnect();
  };
});

// Re-check overflow when tabs change
$effect(() => {
  // Track tabs.length
  void tabs.length;
  updateScrollState();
});

// Auto-scroll active tab into view
$effect(() => {
  if (!activeTabId || !scrollEl) return;
  const el = scrollEl.querySelector(`[data-testid="tab-${activeTabId}"]`);
  if (el) {
    (el as HTMLElement).scrollIntoView({
      inline: "nearest",
      block: "nearest",
      behavior: scrollBehavior,
    });
  }
});

// Clear drag state when tab list changes mid-drag
$effect(() => {
  void tabs.length;
  clearDragState();
});

// DnD handlers
function handleDragStart(e: DragEvent, id: string) {
  draggedId = id;
  if (e.dataTransfer) {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  }
}

function handleDragOver(e: DragEvent, id: string) {
  e.preventDefault();
  if (!draggedId || draggedId === id) {
    dropTarget = null;
    return;
  }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const midX = rect.left + rect.width / 2;
  const side = e.clientX < midX ? "left" : "right";
  dropTarget = { id, side };
}

function handleDrop(e: DragEvent, targetId: string) {
  e.preventDefault();
  const fromId = e.dataTransfer?.getData("text/plain");
  if (fromId && fromId !== targetId && reorder) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const side = e.clientX < midX ? "left" : "right";
    reorder(fromId, targetId, side);
  }
  clearDragState();
}

function handleDragEnd() {
  clearDragState();
}

function handleDragLeave() {
  dropTarget = null;
}

// Keyboard reordering (Alt+Arrow swaps with neighbor)
function handleKeyDown(e: KeyboardEvent, id: string) {
  if (!e.altKey || !reorder) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();

  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;

  if (e.key === "ArrowLeft" && idx > 0) {
    reorder(id, tabs[idx - 1].id);
  } else if (e.key === "ArrowRight" && idx < tabs.length - 1) {
    reorder(tabs[idx + 1].id, id);
  }
}

function scrollLeft() {
  scrollEl?.scrollBy({ left: -150, behavior: scrollBehavior });
}

function scrollRight() {
  scrollEl?.scrollBy({ left: 150, behavior: scrollBehavior });
}

const singleTab = $derived(tabs.length <= 1);
</script>

<div
  style="position: relative; display: flex; align-items: center; background: var(--tandem-surface-muted); border-bottom: 1px solid var(--tandem-border); min-height: 32px;"
>
  {#if canScrollLeft}
    <button
      data-testid="tab-scroll-left"
      onclick={scrollLeft}
      style="display: flex; align-items: center; justify-content: center; width: 28px; min-width: 28px; background: linear-gradient(to right, var(--tandem-surface-muted) 70%, transparent); border: none; cursor: pointer; font-size: 12px; color: var(--tandem-fg-muted); padding: 0; z-index: 1;"
      title="Scroll tabs left"
    >
      ◀
    </button>
  {/if}

  <div
    bind:this={scrollEl}
    data-testid="tab-scroll-container"
    class="tab-scroll-hide"
    style="display: flex; align-items: center; gap: 1px; flex: 1; overflow-x: auto; overflow-y: hidden; padding: 0 4px;"
  >
    {#each tabs as tab (tab.id)}
      <TabItem
        {tab}
        isActive={tab.id === activeTabId}
        onswitch={onTabSwitch}
        onclose={guardedClose}
        draggable={!singleTab}
        ondragstart={handleDragStart}
        ondragover={handleDragOver}
        ondrop={handleDrop}
        ondragend={handleDragEnd}
        ondragleave={handleDragLeave}
        dropIndicator={dropTarget?.id === tab.id ? dropTarget.side : null}
        onkeydown={handleKeyDown}
      />
    {/each}
  </div>

  {#if canScrollRight}
    <button
      data-testid="tab-scroll-right"
      onclick={scrollRight}
      style="display: flex; align-items: center; justify-content: center; width: 28px; min-width: 28px; background: linear-gradient(to left, var(--tandem-surface-muted) 70%, transparent); border: none; cursor: pointer; font-size: 12px; color: var(--tandem-fg-muted); padding: 0; z-index: 1;"
      title="Scroll tabs right"
    >
      ▶
    </button>
  {/if}

  <button
    onclick={() => (showDialog = true)}
    data-testid="open-file-btn"
    title="Open file"
    style="background: none; border: 1px solid var(--tandem-border-strong); border-radius: 4px; cursor: pointer; font-size: 16px; line-height: 1; color: var(--tandem-fg-muted); padding: 2px 8px; margin-left: 4px; margin-right: 8px; flex-shrink: 0;"
    onmouseenter={(e) => {
      (e.currentTarget as HTMLButtonElement).style.color = "var(--tandem-accent)";
      (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--tandem-accent)";
    }}
    onmouseleave={(e) => {
      (e.currentTarget as HTMLButtonElement).style.color = "var(--tandem-fg-muted)";
      (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--tandem-border-strong)";
    }}
  >
    +
  </button>

  {#if showDialog}
    <FileOpenDialog onClose={() => (showDialog = false)} />
  {/if}
</div>

<style>
  :global(.tab-scroll-hide) {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  :global(.tab-scroll-hide::-webkit-scrollbar) {
    display: none;
  }
</style>
