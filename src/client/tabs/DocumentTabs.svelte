<script lang="ts">
import { onDestroy, untrack } from "svelte";
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
// A29 morph (#798): shared timing tokens + reduced-motion token-zeroing.
import "../panels/morphTiming.css";

interface Props {
  tabs: OpenTab[];
  activeTabId: string | null;
  onTabSwitch: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  reorder?: (fromId: string, toId: string, side?: "left" | "right") => void;
  reduceMotion?: boolean;
  onRequestOpenDialog?: () => void;
  /** Increment to toggle the new-tab menu from a parent keyboard shortcut
   * (Ctrl+T). The mount value 0 is skipped; each change flips the menu. */
  openMenuTrigger?: number;
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
  openMenuTrigger = 0,
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
// Reactive: drive the per-tab drop indicator.
let draggedId = $state<string | null>(null);
let dropTarget = $state<{ id: string; side: "left" | "right" } | null>(null);

// Non-reactive gesture bookkeeping — read only inside imperative handlers,
// never in the template or a $derived (same pattern as `closingIds`).
let pointerId: number | null = null;
let pointerStartX = 0;
let pointerStartY = 0;
let dragging = false; // crossed the movement threshold?
let captureEl: HTMLElement | null = null;

const DRAG_THRESHOLD_PX = 5;

function onWindowPointerMove(e: PointerEvent) {
  handlePointerMove(e);
}
function onWindowPointerUp(e: PointerEvent) {
  handlePointerUp(e);
}
function onWindowPointerCancel(e: PointerEvent) {
  if (pointerId !== null && e.pointerId === pointerId) clearDragState();
}
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") clearDragState();
}

function clearDragState() {
  if (captureEl && pointerId !== null) {
    try {
      captureEl.releasePointerCapture(pointerId);
    } catch {
      // capture may already be lost (element unmounted) — ignore
    }
  }
  window.removeEventListener("pointermove", onWindowPointerMove);
  window.removeEventListener("pointerup", onWindowPointerUp);
  window.removeEventListener("pointercancel", onWindowPointerCancel);
  window.removeEventListener("keydown", onWindowKeyDown);
  draggedId = null;
  dropTarget = null;
  pointerId = null;
  dragging = false;
  captureEl = null;
}

// Safety net: a component unmount (or HMR) mid-drag would otherwise leak the
// window listeners, since clearDragState is only reached via pointer/keyboard
// events that won't fire after teardown. clearDragState is idempotent.
onDestroy(clearDragState);

// Clear drag state if the dragged or target tab is unmounted mid-drag.
// pointerup doesn't fire reliably when the source element leaves the DOM.
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

// Pointer-based reorder. HTML5 DnD can't be used: in the Tauri desktop app
// `dragDropEnabled: true` (required by native file-drop-to-open) makes the
// WebView swallow all HTML5 drag events. Pointer events are not suppressed and
// work identically in the browser, so this single path covers both.
function handleTabPointerDown(e: PointerEvent, id: string) {
  if (e.button !== 0 || singleTab) return;
  pointerId = e.pointerId;
  pointerStartX = e.clientX;
  pointerStartY = e.clientY;
  dragging = false;
  draggedId = id;
  captureEl = e.currentTarget as HTMLElement;
  try {
    captureEl.setPointerCapture(e.pointerId);
  } catch {
    // setPointerCapture can throw if the pointer is already gone — ignore
  }
  // Listeners live on window (not captureEl) so cleanup is reliable even if
  // the source tab unmounts mid-gesture.
  window.addEventListener("pointermove", onWindowPointerMove);
  window.addEventListener("pointerup", onWindowPointerUp);
  window.addEventListener("pointercancel", onWindowPointerCancel);
  window.addEventListener("keydown", onWindowKeyDown);
  // Deliberately no preventDefault here: a press with no movement must still
  // fire the tab's onclick → switch.
}

function tabElementAtPoint(clientX: number, clientY: number): HTMLElement | null {
  const el = document
    .elementFromPoint(clientX, clientY)
    ?.closest('[data-testid^="tab-"][role="tab"]');
  return (el as HTMLElement) ?? null;
}

function handlePointerMove(e: PointerEvent) {
  if (pointerId === null || e.pointerId !== pointerId || !draggedId) return;
  if (!dragging) {
    const dx = e.clientX - pointerStartX;
    const dy = e.clientY - pointerStartY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    dragging = true;
  }
  e.preventDefault();
  const overEl = tabElementAtPoint(e.clientX, e.clientY);
  const overId = overEl?.getAttribute("data-testid")?.slice("tab-".length) ?? null;
  if (!overEl || !overId || overId === draggedId) {
    dropTarget = null;
    return;
  }
  const rect = overEl.getBoundingClientRect();
  const midX = rect.left + rect.width / 2;
  const side = e.clientX < midX ? "left" : "right";
  dropTarget = { id: overId, side };
}

function handlePointerUp(e: PointerEvent) {
  if (pointerId === null || e.pointerId !== pointerId) return;
  const wasDragging = dragging;
  // Capture into a const so the narrowing holds inside the `.some` closure below
  // (a `$state` `let` isn't narrowed across a nested function boundary).
  const target = dropTarget;
  if (
    wasDragging &&
    draggedId &&
    target &&
    target.id !== draggedId &&
    reorder &&
    tabs.some((t) => t.id === draggedId) &&
    // A closing tab lingers ~200ms during its s3 `out:` collapse with its tab
    // testid and role intact, so it can still be picked as a drop target — guard
    // against reordering onto an id no longer in `tabs`.
    tabs.some((t) => t.id === target.id)
  ) {
    reorder(draggedId, target.id, target.side);
  }
  if (wasDragging) {
    // A finished drag may emit a trailing synthetic click that would fire the
    // tab's onclick → switch. Swallow it. A no-move press installs nothing, so
    // plain click-to-switch is unaffected. The setTimeout(0) fallback removes
    // the listener if no click arrives (a drag ending over a different tab
    // often fires no click at all) so it can never eat a later legit click.
    let timer: ReturnType<typeof setTimeout>;
    const suppress = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
      window.removeEventListener("click", suppress, true);
      clearTimeout(timer);
    };
    window.addEventListener("click", suppress, true);
    timer = setTimeout(() => window.removeEventListener("click", suppress, true), 0);
  }
  clearDragState();
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

// Single source of truth for opening/closing the new-tab menu. Shared by the
// `+` button (direct call) and the Ctrl+T trigger effect (wrapped in untrack).
// Recent files are (re)loaded only on the open transition.
function toggleNewTabMenu() {
  const opening = !showRecent;
  if (opening) recentFiles = loadRecentFilesCached();
  showRecent = opening;
}

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

// A29 (#798) — return focus to the + trigger when the dialog body unmounts on close,
// but ONLY when focus would otherwise be lost (Escape / item-select leave focus on the
// now-removed body → activeElement falls back to <body>). On click-outside the user's
// click already moved focus elsewhere → leave it there. `wasOpen` is a plain (non-reactive)
// latch so this only fires on a true→false transition, never on initial mount.
let wasOpen = false;
$effect(() => {
  if (showRecent) {
    wasOpen = true;
    return;
  }
  if (!wasOpen) return;
  wasOpen = false;
  const active = document.activeElement;
  if (!active || active === document.body) openBtnEl?.focus({ preventScroll: true });
});

// Ctrl+T (App-level shortcut) toggles the new-tab menu via this counter prop.
// Only `openMenuTrigger` is a tracked dependency; the mount value 0 is skipped.
// `toggleNewTabMenu` reads + writes `showRecent`; running it under `untrack`
// keeps showRecent out of this effect's deps (subscribing would self-retrigger
// → update-depth loop) so only the counter — not the other paths that mutate
// showRecent directly (Esc, click-outside, the + toggle) — re-fires it.
$effect(() => {
  if (openMenuTrigger > 0) untrack(toggleNewTabMenu);
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
        onpointerdown={handleTabPointerDown}
        dropIndicator={dropTarget?.id === tab.id ? dropTarget.side : null}
        onkeydown={handleKeyDown}
        {reduceMotion}
      />
    {/each}
  </div>

  <!-- A29 (#798): the "+" is the closed state of a persistent single-shell morph. Clicking
       it morphs the pill in place into the new-tab menu (un-portaled — no <body> portal).
       The shell lives OUTSIDE role="tablist" (a tablist may only contain role="tab"
       children — axe `aria-required-children`) AND outside the .tab-scroll-mask scroller,
       so its growth is never clipped by the horizontal tab overflow. The 28×28 .nt-wrap
       placeholder holds the in-flow slot stable while the absolute .nt-morph grows
       down-and-left from the + slot. -->
  <div class="nt-wrap">
    <div class="nt-morph" class:open={showRecent}>
      <button
        bind:this={openBtnEl}
        onclick={toggleNewTabMenu}
        data-testid="open-file-btn"
        class="tandem-floating-pill tab-add-pill"
        title="Open file"
        aria-label="Open file"
        aria-haspopup="dialog"
        aria-expanded={showRecent}
      >
        +
      </button>
      <div class="nt-grid">
        <div class="nt-cell">
          {#if showRecent}
            <NewTabMenu
              {recentFiles}
              {closedTabTop}
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
      </div>
    </div>
  </div>
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

  /* A29 single-shell morph (#798). The 28×28 .nt-wrap holds the in-flow slot stable
     (so tabs never shift) while the absolute .nt-morph grows down-and-left from the +
     slot into the 460px menu. Timing tokens (--morph-p1/p2/cascade) + the reduced-motion
     token-zeroing come from morphTiming.css (imported in the script). */
  .nt-wrap {
    position: relative;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    margin-left: var(--tandem-space-2);
  }
  .nt-morph {
    position: absolute;
    top: 0;
    right: 0; /* anchor at the + slot — grow left + down */
    width: 28px;
    min-height: 28px; /* closed floor for the pill; height is auto and follows the grid */
    border-radius: var(--tandem-r-circle);
    /* closed: overflow visible so the pill's own floating-pill drop-shadow + focus rings
       paint. The clip needed for the body reveal is applied only while .open (below). */
    overflow: visible;
    /* CLOSE: width + radius wait for the height collapse (delay P2) */
    transition:
      width var(--morph-p1) var(--tandem-ease-out) var(--morph-p2),
      border-radius var(--morph-p1) var(--tandem-ease-out) var(--morph-p2);
  }
  .nt-morph.open {
    width: 460px; /* production menu width */
    border-radius: var(--tandem-r-4);
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    box-shadow: var(--tandem-shadow-2);
    /* clip the revealing body; clip-margin (not hidden) keeps it from being a scroll
       container (lesson #765) and lets descendant focus rings paint past the edge */
    overflow: clip;
    overflow-clip-margin: var(--tandem-space-2);
    /* OPEN: width + radius lead (no delay) */
    transition:
      width var(--morph-p1) var(--tandem-ease-out),
      border-radius var(--morph-p1) var(--tandem-ease-out);
  }
  .nt-grid {
    display: grid;
    grid-template-rows: 0fr; /* closed: body track collapsed */
    overflow: clip;
    /* CLOSE: height collapses first (no delay) */
    transition: grid-template-rows var(--morph-p1) var(--tandem-ease-out);
  }
  .nt-morph.open .nt-grid {
    grid-template-rows: 1fr; /* open: body track at natural height */
    /* OPEN: height unfurls AFTER the width lead (delay P1) */
    transition: grid-template-rows var(--morph-p2) var(--tandem-ease-out) var(--morph-p1);
  }
  .nt-cell {
    min-height: 0; /* allow the 0fr track to clip to zero */
    overflow: clip;
  }

  /* 28×28 floating-pill `+` add-tab button — the closed state of the morph. Inherits the
     white/dark/warm background + border + shadow from `.tandem-floating-pill`; absolute so
     it adds no layout height (the shell height is driven by the grid). Fades out as the
     shell opens; fades back in only after the width has collapsed on close (delay P2). */
  .tab-add-pill {
    position: absolute;
    top: 0;
    right: 0;
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: var(--tandem-r-circle);
    color: var(--tandem-fg-subtle);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
    transition:
      color 0.15s,
      border-color 0.15s,
      background 0.15s,
      opacity var(--morph-cascade) var(--tandem-ease-out) var(--morph-p2);
  }
  .nt-morph.open .tab-add-pill {
    opacity: 0;
    pointer-events: none;
    transition:
      color 0.15s,
      border-color 0.15s,
      background 0.15s,
      opacity var(--morph-cascade) var(--tandem-ease-out); /* fade out fast on open */
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
