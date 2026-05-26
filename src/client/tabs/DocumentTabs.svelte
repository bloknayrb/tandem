<script lang="ts">
import { createScratchpad } from "../actions/builtin.svelte.js";
import type { ClosedTabRecord } from "../hooks/useClosedTabStack.svelte.js";
import type { OpenTab } from "../types.js";
import { isInActiveDragRegion } from "../utils/dismiss-outside.js";
import {
  addRecentFile,
  loadRecentFilesCached,
  type RecentFileEntry,
  saveRecentFiles,
} from "../utils/recentFiles.js";
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
  /** Reactive head of the closed-tab stack — drives "Reopen last closed". */
  closedTabTop?: ClosedTabRecord | null;
  onReopenClosed?: () => void;
}

const {
  tabs,
  activeTabId,
  onTabSwitch,
  onTabClose,
  reorder,
  reduceMotion = false,
  onRequestOpenDialog,
  closedTabTop = null,
  onReopenClosed,
}: Props = $props();

const scrollBehavior: ScrollBehavior = $derived(reduceMotion ? "auto" : "smooth");

let showRecent = $state(false);
let recentFiles = $state<RecentFileEntry[]>([]);
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

const singleTab = $derived(tabs.length <= 1);

$effect(() => {
  if (!showRecent) return;

  function handlePointerDown(e: PointerEvent) {
    const target = e.target as Node | null;
    if (!target) return;
    if (openBtnEl?.contains(target)) return;
    if ((target as Element).closest?.(".new-tab-menu")) return;
    if (isInActiveDragRegion(target as Element)) return;
    showRecent = false;
  }

  window.addEventListener("pointerdown", handlePointerDown, true);
  return () => window.removeEventListener("pointerdown", handlePointerDown, true);
});
</script>

<!-- Transparent container so pill TabItems read as standalone chips against
     the canvas behind TitleBar's center cluster (the only host).

     Mask-fade overflow: when the scroller has hidden content on either side
     we apply `.has-overflow` (both sides) or `.overflow-left` / `.overflow-right`
     (one side) modifier classes on `.tab-scroll-mask`. The mask is a 22px
     linear-gradient fade matching the v7 design recipe — replaces the prior
     left/right arrow buttons, which became redundant with native trackpad
     scroll + the visual cue from the fade. -->
<div
  style="position: relative; display: flex; align-items: center; background: transparent; min-height: 32px; z-index: var(--tandem-z-base); width: 100%; min-width: 0;"
>
  <div
    bind:this={scrollEl}
    data-testid="tab-scroll-container"
    class={[
      "tab-scroll-hide",
      "tab-scroll-mask",
      canScrollLeft && canScrollRight && "has-overflow",
      canScrollLeft && !canScrollRight && "overflow-left",
      !canScrollLeft && canScrollRight && "overflow-right",
    ]}
    role="tablist"
    aria-label="Open documents"
    style="display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; overflow-x: auto; overflow-y: hidden; padding: 6px 8px;"
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
       scroll container preserves the visual placement at the end of the tab strip.
       28×28 floating-pill recipe matches the v7 .c7-tab-add design. -->
  <button
    bind:this={openBtnEl}
    onclick={() => {
      recentFiles = loadRecentFilesCached();
      showRecent = !showRecent;
    }}
    data-testid="open-file-btn"
    class="tandem-floating-pill tab-add-pill"
    title="Open file"
    aria-label="Open file"
  >
    +
  </button>

  {#if showRecent}
    <NewTabMenu
      {recentFiles}
      {closedTabTop}
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
      onReopenClosed={() => {
        showRecent = false;
        onReopenClosed?.();
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

  /* Mask-fade overflow: 22px linear-gradient fade on whichever edge has
     hidden content. Matches the v7 .c7-tabs design recipe (calm-v7.css). */
  :global(.tab-scroll-mask.has-overflow) {
    mask-image: linear-gradient(
      90deg,
      transparent 0,
      #000 22px,
      #000 calc(100% - 22px),
      transparent 100%
    );
    -webkit-mask-image: linear-gradient(
      90deg,
      transparent 0,
      #000 22px,
      #000 calc(100% - 22px),
      transparent 100%
    );
  }
  :global(.tab-scroll-mask.overflow-right) {
    mask-image: linear-gradient(
      90deg,
      #000 0,
      #000 calc(100% - 22px),
      transparent 100%
    );
    -webkit-mask-image: linear-gradient(
      90deg,
      #000 0,
      #000 calc(100% - 22px),
      transparent 100%
    );
  }
  :global(.tab-scroll-mask.overflow-left) {
    mask-image: linear-gradient(
      90deg,
      transparent 0,
      #000 22px,
      #000 100%
    );
    -webkit-mask-image: linear-gradient(
      90deg,
      transparent 0,
      #000 22px,
      #000 100%
    );
  }

  /* 28×28 floating-pill `+` add-tab button. Inherits the white/dark/warm
     background + border + shadow from `.tandem-floating-pill`; this rule
     only sets the size/shape/hover. */
  .tab-add-pill {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    margin-left: var(--tandem-space-2);
    border-radius: var(--tandem-r-circle);
    color: var(--tandem-fg-subtle);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    flex-shrink: 0;
    padding: 0;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .tab-add-pill:hover {
    color: var(--tandem-accent);
    border-color: var(--tandem-accent-border);
  }
  .tab-add-pill:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
</style>
