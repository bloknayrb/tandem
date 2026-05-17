<script lang="ts">
import { createScratchpad } from "../actions/builtin.svelte.js";
import type { OpenTab } from "../types.js";
import { addRecentFile, loadRecentFilesCached, saveRecentFiles } from "../utils/recentFiles.js";
import { openServerPath } from "../utils/server-paths.js";
import NewTabMenu from "./NewTabMenu.svelte";
import TabItem from "./TabItem.svelte";

interface Props {
  tabs: OpenTab[];
  activeTabId: string | null;
  onTabSwitch: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  reorder?: (fromId: string, toId: string, side?: "left" | "right") => void;
  reduceMotion?: boolean;
  onRequestOpenDialog?: () => void;
}

const {
  tabs,
  activeTabId,
  onTabSwitch,
  onTabClose,
  reorder,
  reduceMotion = false,
  onRequestOpenDialog,
}: Props = $props();

const scrollBehavior: ScrollBehavior = $derived(reduceMotion ? "auto" : "smooth");

let showRecent = $state(false);
let recentFiles = $state<string[]>([]);
let openBtnEl: HTMLButtonElement | null = $state(null);

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

// Clear drag state if the dragged or target tab is unmounted mid-drag.
// dragend doesn't fire reliably when the source element leaves the DOM.
// No-op unless an id has actually disappeared — must NOT become a broad
// clearDragState() (would null draggedId on every Yjs awareness ping).
$effect(() => {
  if (!draggedId && !dropTarget) return;
  const ids = new Set(tabs.map((t) => t.id));
  if (draggedId && !ids.has(draggedId)) draggedId = null;
  if (dropTarget && !ids.has(dropTarget.id)) dropTarget = null;
});

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

// DnD handlers
function handleDragStart(e: DragEvent, id: string) {
  draggedId = id;
  if (e.dataTransfer) {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  }
}

function handleDragOver(e: DragEvent, id: string) {
  // Gate preventDefault on draggedId so foreign drags (file from Explorer,
  // reachable because tauri dragDropEnabled is false) get the OS no-drop
  // cursor instead of being silently swallowed.
  if (!draggedId) return;
  e.preventDefault();
  if (draggedId === id) {
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
  const fromId = draggedId || e.dataTransfer?.getData("text/plain") || "";
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

$effect(() => {
  if (!showRecent) return;

  function handlePointerDown(e: PointerEvent) {
    const target = e.target as Node | null;
    if (!target) return;
    if (openBtnEl?.contains(target)) return;
    if ((target as Element).closest?.(".new-tab-menu")) return;
    if ((target as Element).closest?.("[data-tauri-drag-region]")) return;
    showRecent = false;
  }

  window.addEventListener("pointerdown", handlePointerDown, true);
  return () => window.removeEventListener("pointerdown", handlePointerDown, true);
});
</script>

<div
  style="position: relative; display: flex; align-items: stretch; background: var(--tandem-surface-muted); border-bottom: 1px solid var(--tandem-border); min-height: 32px; padding: 0 var(--tandem-space-3); z-index: var(--tandem-z-base);"
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
    role="tablist"
    aria-label="Open documents"
    style="display: flex; align-items: stretch; gap: 2px; flex: 1; overflow-x: auto; overflow-y: hidden;"
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

  <!-- The "+" button lives OUTSIDE role="tablist" — a tablist is only allowed to contain
       role="tab" children (axe `aria-required-children`). Keeping it adjacent to the
       scroll container preserves the visual placement at the end of the tab strip. -->
  <button
    bind:this={openBtnEl}
    onclick={() => {
      recentFiles = loadRecentFilesCached();
      showRecent = !showRecent;
    }}
    data-testid="open-file-btn"
    title="Open file"
    style="background: none; border: none; border-radius: var(--tandem-r-2); cursor: pointer; font-size: 16px; line-height: 1; color: var(--tandem-fg-subtle); padding: 0 8px; margin-left: 4px; flex-shrink: 0;"
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

  {#if showRecent}
    <NewTabMenu
      {recentFiles}
      anchorEl={openBtnEl}
      onOpen={async (filePath) => {
        showRecent = false;
        const result = await openServerPath(filePath);
        if (result.ok) {
          saveRecentFiles(addRecentFile(loadRecentFilesCached(), filePath));
        } else {
          console.warn("[tandem] failed to open recent file:", result.error);
        }
      }}
      onNewScratchpad={() => {
        showRecent = false;
        void createScratchpad();
      }}
      onBrowse={() => {
        showRecent = false;
        onRequestOpenDialog?.();
      }}
      onClose={() => (showRecent = false)}
    />
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
