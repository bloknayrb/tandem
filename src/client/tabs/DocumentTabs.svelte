<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { createScratchpad } from "../actions/builtin.svelte.js";
import { isTauriRuntime } from "../cowork/cowork-helpers.js";
import { loadInvoke } from "../cowork/cowork-invoke.js";
import type { ClosedTabRecord } from "../hooks/useClosedTabStack.svelte.js";
import { isRenamable, type OpenTab } from "../types.js";
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
import {
  buildTabMenuContext,
  hasRealPath,
  isTabContextMenuActionId,
  type TabContextMenuActionId,
} from "./tab-context-menu.js";
// A29 morph (#798): shared timing tokens + reduced-motion token-zeroing.
import "../panels/morphTiming.css";

interface Props {
  tabs: OpenTab[];
  activeTabId: string | null;
  onTabSwitch: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  /** Close every tab except the given one (tab context menu, #923 Phase 2). */
  onCloseOthers?: (tabId: string) => void;
  /** Close every tab to the right of the given one in display order. */
  onCloseToRight?: (tabId: string) => void;
  reorder?: (fromId: string, toId: string, side?: "left" | "right") => void;
  reduceMotion?: boolean;
  onRequestOpenDialog?: () => void;
  /** Increment to toggle the new-tab menu from a parent keyboard shortcut
   * (Ctrl+T). The mount value 0 is skipped; each change flips the menu. */
  openMenuTrigger?: number;
  /** Commit an inline tab rename (#1017): new basename for the tab. */
  onTabRename?: (tabId: string, newName: string) => void;
  /** Increment to start renaming the ACTIVE tab from a parent shortcut (F2).
   * Mirrors openMenuTrigger; the mount value 0 is skipped. */
  renameTrigger?: number;
  /** Reactive head of the closed-tab stack — drives "Reopen last closed". */
  closedTabTop?: ClosedTabRecord | null;
  onReopenClosed?: () => void;
}

const {
  tabs,
  activeTabId,
  onTabSwitch,
  onTabClose,
  onCloseOthers,
  onCloseToRight,
  reorder,
  reduceMotion = false,
  onRequestOpenDialog,
  openMenuTrigger = 0,
  onTabRename,
  renameTrigger = 0,
  closedTabTop = null,
  onReopenClosed,
}: Props = $props();

// Inline rename (#1017). DocumentTabs is the single source of truth for which
// tab is editing; each TabItem derives `isRenaming` from it. Double-click (via
// onstartrename) and the F2 trigger (below) both flow through `startRename`.
let renamingTabId = $state<string | null>(null);

function startRename(tabId: string) {
  renamingTabId = tabId;
}
function commitRename(tabId: string, newName: string) {
  renamingTabId = null;
  onTabRename?.(tabId, newName);
}
function cancelRename() {
  renamingTabId = null;
}

const scrollBehavior: ScrollBehavior = $derived(reduceMotion ? "auto" : "smooth");

let showRecent = $state(false);
let recentFiles = $state<RecentFileEntry[]>([]);
let openBtnEl: HTMLButtonElement | null = $state(null);
// A29 (#798): the menu body stays mounted through the close collapse so its height
// animates 1fr→0fr together with the shell (a box-collapse, not a height-snap the
// instant it unmounts), then unmounts once the collapse ends. `bodyMounted` also
// keeps the `.filled` card surface (bg/border/shadow/clip) alive through that
// window — geometry (.open) drops at t=0 to drive the collapse, but the fill
// persists so a *filled* card visibly shrinks into the pill instead of an empty
// box. `morphEl` reads the live --morph-p1 + --morph-p2 (the two-phase close total:
// height collapse then width collapse, token-zeroed under reduced-motion) so the
// unmount delay tracks the real collapse duration.
let bodyMounted = $state(false);
let morphEl: HTMLDivElement | null = $state(null);

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

// ---- Native tab context menu (#923 Phase 2) -----------------------------
// Tauri-only: in the browser we let the native WebView menu through. The tab
// id + path are captured at right-click time (plain let — gesture bookkeeping,
// never reactive) and consumed when the action event arrives. The action id
// rides the same `context-menu-action` event as the editor menu; each surface
// validates against its own closed id set and drops the other's ids.
let ctxTabId: string | null = null;
let ctxTabPath: string | null = null;

async function handleTabContextMenu(e: MouseEvent) {
  if (!isTauriRuntime()) return; // browser → native menu
  const el = (e.target as Element | null)?.closest('[data-testid^="tab-"][role="tab"]');
  const id = tabIdFromElement(el);
  if (!id) return;
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;

  ctxTabId = id;
  ctxTabPath = tab.filePath;
  e.preventDefault();

  try {
    const invoke = await loadInvoke();
    await invoke("show_tab_context_menu", { req: buildTabMenuContext(tabs, id) });
  } catch {
    // Tauri unavailable / command error — native menu already suppressed.
  }
}

async function runTabAction(id: TabContextMenuActionId) {
  const tabId = ctxTabId;
  const path = ctxTabPath;
  if (!tabId) return;
  switch (id) {
    case "ctx:tab:close":
      guardedClose(tabId);
      return;
    case "ctx:tab:closeOthers":
      onCloseOthers?.(tabId);
      return;
    case "ctx:tab:closeRight":
      onCloseToRight?.(tabId);
      return;
    case "ctx:tab:copyPath":
      // Re-check the path is real here too — don't trust the menu's enabled
      // state alone (defense-in-depth vs a forged action event).
      if (path && hasRealPath(path)) {
        try {
          await navigator.clipboard.writeText(path);
        } catch {
          /* clipboard denied — best-effort */
        }
      }
      return;
    case "ctx:tab:reveal":
      if (path && hasRealPath(path)) {
        try {
          const invoke = await loadInvoke();
          await invoke("show_in_file_manager", { path });
        } catch {
          /* reveal failed — best-effort */
        }
      }
      return;
  }
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

// contextmenu listener attached imperatively on scrollEl (not an inline
// handler) so the a11y analyzer doesn't demand a tabindex on the role="tablist"
// element — a tablist must not itself be focusable. Delegation: handleTabContextMenu
// resolves the clicked tab via closest([role="tab"]). (#923 Phase 2)
$effect(() => {
  const el = scrollEl;
  if (!el) return;
  el.addEventListener("contextmenu", handleTabContextMenu);
  return () => el.removeEventListener("contextmenu", handleTabContextMenu);
});

// Single Tauri listener for the whole strip. Store the listen() PROMISE and
// await it in teardown so a fast unmount can't leak the global listener.
$effect(() => {
  if (!isTauriRuntime()) return;
  const unlistenP = import("@tauri-apps/api/event").then(({ listen }) =>
    listen<{ id?: string }>("context-menu-action", (event) => {
      const id = event.payload?.id;
      if (!isTabContextMenuActionId(id)) return; // editor ids handled elsewhere
      void runTabAction(id);
    }),
  );
  unlistenP.catch(() => {});
  return () => {
    unlistenP.then((un) => un()).catch(() => {});
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

function tabIdFromElement(el: Element | null | undefined): string | null {
  return el?.getAttribute("data-testid")?.slice("tab-".length) ?? null;
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
  const overId = tabIdFromElement(overEl);
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
// Recent files are (re)loaded only on the open transition. On open we also capture
// the element that had focus (the editor, when opened via Ctrl+T) so focus can be
// RESTORED there on close — returning to the trigger pattern but to the origin, not
// the +, so the + never parks a :focus-visible ring after the morph settles.
function toggleNewTabMenu() {
  const opening = !showRecent;
  if (opening) {
    recentFiles = loadRecentFilesCached();
    previouslyFocused = document.activeElement as HTMLElement | null;
  } else {
    closeMenu();
    return;
  }
  showRecent = opening;
}

// Single close path. Synchronously blur the focused element IF it's inside the
// morph BEFORE flipping showRecent. The body defers its unmount ~820ms and goes
// `inert` while collapsing, but inert's blur is frame-deferred by the browser:
// a Ctrl+W fired in the SAME tick as the close (the CI E2E does exactly this
// after Escape) still lands on the focused search INPUT, where
// shouldIgnoreShortcut swallows it and the tab never closes. A synchronous
// .blur() is the only handle that beats that race; element-removal (the #977
// baseline) blurred synchronously, the deferred-unmount morph does not. The
// contains() guard no-ops the click-outside path (focus already moved out) so
// this doesn't fight closedByPointerOutside.
function closeMenu() {
  const active = document.activeElement as HTMLElement | null;
  if (active && morphEl?.contains(active)) active.blur();
  showRecent = false;
}

// Body mount lifecycle (A29 box-collapse close). Open → mount immediately. Close →
// keep the body mounted while the shell collapses, then unmount when it finishes so
// the height can animate down instead of snapping the instant the content leaves.
let closeUnmountTimer: ReturnType<typeof setTimeout> | null = null;
function readMs(name: string): number {
  if (!morphEl) return Number.NaN;
  const raw = getComputedStyle(morphEl).getPropertyValue(name).trim();
  return raw.endsWith("ms")
    ? parseFloat(raw)
    : raw.endsWith("s")
      ? parseFloat(raw) * 1000
      : parseFloat(raw);
}
function morphCollapseMs(): number {
  if (!morphEl) return 0;
  // Two-phase close total = height collapse (--morph-p2) THEN width collapse
  // (--morph-p1, delayed by p2). The body + .filled fill must stay mounted until the
  // WHOLE collapse ends — else the horizontal capsule-shrink plays on an empty box.
  // So sum both phases. Both are literal tokens (not calc) → getComputedStyle returns
  // parseable values; both "0ms" under reduced-motion → 0 → instant unmount. A
  // malformed *either* token NaN-poisons the sum → guard → 0 (height-snap); low risk
  // (sibling literals, zeroed identically) but the surface now spans both tokens.
  const ms = readMs("--morph-p1") + readMs("--morph-p2");
  // +40ms buffer past transition-end; 0 under reduced-motion (tokens zeroed) → unmount now.
  return Number.isFinite(ms) && ms > 0 ? ms + 40 : 0;
}
$effect(() => {
  if (showRecent) {
    if (closeUnmountTimer) {
      clearTimeout(closeUnmountTimer);
      closeUnmountTimer = null;
    }
    bodyMounted = true;
    return;
  }
  if (!untrack(() => bodyMounted)) return;
  if (closeUnmountTimer) clearTimeout(closeUnmountTimer);
  const delay = morphCollapseMs();
  if (delay <= 0) {
    bodyMounted = false;
    return;
  }
  closeUnmountTimer = setTimeout(() => {
    bodyMounted = false;
    closeUnmountTimer = null;
  }, delay);
});
onDestroy(() => {
  if (closeUnmountTimer) clearTimeout(closeUnmountTimer);
});

// A29 (#798) — close-reason flag. Set ONLY by the click-outside path so focus-return
// can tell "user clicked away" (leave focus where the click landed) from every other
// close (Esc / item-select / Ctrl+T → restore focus to the pre-open element). Plain
// non-reactive let (gesture bookkeeping, same family as `closingIds`).
let closedByPointerOutside = false;
// Element focused immediately before the menu opened (captured in toggleNewTabMenu) —
// focus is restored here on close. Plain non-reactive let.
let previouslyFocused: HTMLElement | null = null;

$effect(() => {
  if (!showRecent) return;

  function handlePointerDown(e: PointerEvent) {
    const target = e.target as Node | null;
    if (!target) return;
    if (openBtnEl?.contains(target)) return;
    if ((target as Element).closest?.(".new-tab-menu")) return;
    if (isInActiveDragRegion(target as Element)) return;
    closedByPointerOutside = true;
    closeMenu();
  }

  window.addEventListener("pointerdown", handlePointerDown, true);
  return () => window.removeEventListener("pointerdown", handlePointerDown, true);
});

// A29 (#798) — on close, RESTORE focus to the element that was focused before the menu
// opened (the editor, when opened via Ctrl+T), EXCEPT when the user closed by clicking
// outside (then leave focus where the click landed). Keyed on `showRecent` true→false (a
// plain `let` latch), NOT on the body unmount: the unmount is deferred ~p1+p2 (~820ms)
// past close, and reading document.activeElement at the flip is fragile (under
// reduced-motion the body is already gone). `previouslyFocused` is a value captured at
// open time, so it's immune to that timing. We deliberately do NOT focus the + here:
// focusing the + after a keyboard close gives it a :focus-visible ring that parks on the
// pill (and was clipped into a stray arc mid-morph). `closeMenu()` already blurred the
// in-morph search input synchronously (and `.nt-cell` is `inert` while collapsing), so if
// there's no valid element to restore to, focus simply falls to <body> rather than the +.
let wasShowing = false;
$effect(() => {
  if (showRecent) {
    wasShowing = true;
    return;
  }
  if (!wasShowing) return;
  wasShowing = false;
  const prev = previouslyFocused;
  previouslyFocused = null;
  if (closedByPointerOutside) {
    closedByPointerOutside = false;
    return;
  }
  // Restore only to a still-connected element that isn't the + or inside the morph
  // (both would re-introduce the parked ring / focus a vanishing node). Otherwise no-op.
  if (prev && prev.isConnected && prev !== openBtnEl && !morphEl?.contains(prev)) {
    prev.focus({ preventScroll: true });
  }
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

// F2 (App-level fixed shortcut) starts renaming the active tab via this counter
// prop. Mirrors openMenuTrigger: only `renameTrigger` is tracked, the mount
// value 0 is skipped, and the body runs under `untrack` so reading/writing
// `renamingTabId`/`activeTabId` can't re-subscribe this effect. App already
// gates F2 on the active tab being a renamable file, but re-check here so a
// stale counter can never open a rename on a read-only/scratchpad tab.
$effect(() => {
  if (renameTrigger > 0) {
    untrack(() => {
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab && isRenamable(tab)) renamingTabId = tab.id;
    });
  }
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
        isRenaming={renamingTabId === tab.id}
        onstartrename={startRename}
        onrename={commitRename}
        onrenamecancel={cancelRename}
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
    <div class="nt-morph" class:open={showRecent} class:filled={showRecent || bodyMounted} bind:this={morphEl}>
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
        <!-- inert whenever not open: the body stays mounted (clipped) through the
             ~820ms close collapse, so block its items from pointer AND keyboard (Tab)
             reach while closing. Open (showRecent) clears inert before the search
             autofocus runs. -->
        <div class="nt-cell" inert={!showRecent}>
          {#if bodyMounted}
            <NewTabMenu
              {recentFiles}
              {closedTabTop}
              onOpen={async (filePath) => {
                closeMenu();
                const result = await openServerPath(filePath);
                if (result.ok) {
                  saveRecentFiles(addRecentFile(loadRecentFilesCached(), filePath));
                } else {
                  console.warn("[tandem] failed to open recent file:", result.error);
                }
              }}
              onNewScratchpad={() => {
                closeMenu();
                void createScratchpad();
              }}
              onBrowse={() => {
                closeMenu();
                onRequestOpenDialog?.();
              }}
              onReopenClosed={() => {
                closeMenu();
                onReopenClosed?.();
              }}
              onClose={closeMenu}
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
    /* 14px = half the 28px pill height → a clean capsule (semicircle ends) at ANY width
       during the phase-1 horizontal unroll (= a circle at 28×28), AND the value that makes
       the phase-2 corner square-off MONOTONIC: rendered radius = min(specified 14→8,
       height/2 ≥14) follows 14→8 with no rise-then-fall kink. Do NOT "fix" to a token:
       r-circle (50%) → ellipse on a wide box (the lozenge); r-pill (9999px) → corners stay
       ~height/2 through phase 2 then snap to 8 only at the very end (a late pop). */
    border-radius: 14px;
    /* closed: overflow visible so the pill's own floating-pill drop-shadow + focus rings
       paint. The clip needed for the body reveal is applied only while .filled (below). */
    overflow: visible;
    /* CLOSE-direction timings (used when .open is removed). Reverse of open: PHASE 1 —
       height collapses (card→capsule), radius rounds back (p2, delay 0). PHASE 2 — width
       shrinks (capsule→circle) + box-shadow fades (p1, delay p2). Total = p1 + p2, which
       morphCollapseMs() MUST match (it returns p1 + p2 + buffer). */
    transition:
      width var(--morph-p1) var(--tandem-ease-out) var(--morph-p2),
      border-radius var(--morph-p2) var(--tandem-ease-out),
      box-shadow var(--morph-p1) var(--tandem-ease-out) var(--morph-p2);
  }
  /* FILL — the card surface (bg + border + clip). Driven by
     `class:filled={showRecent || bodyMounted}`, so it applies with .open on open AND
     persists through the close collapse (bodyMounted stays true until the collapse ends)
     → a *filled* card visibly shrinks back into the pill instead of an empty box. The
     shadow is intentionally NOT here — it lives on .open so it can crossfade with the
     pill's shadow during the morph rather than snapping on/off with the fill. */
  .nt-morph.filled {
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    /* clip the revealing body to the rounded card. `overflow: clip` (not `hidden`)
       is what keeps this from becoming a scroll container (lesson #765); the clip
       edge must stay at the border box (no clip-margin) so the menu's full-width,
       square-cornered header/footer bars are clipped to the card's border-radius
       instead of overpainting the rounded corners (clip-margin == radius read as
       square corners). Nothing focusable sits at the shell edge, so there's no
       focus-ring to bleed past it. */
    overflow: clip;
    overflow-clip-margin: 0;
  }
  /* GEOMETRY + card shadow — the expanded state. OPEN-direction timings live here (the
     target state owns the transition when .open is added): PHASE 1 horizontal — width
     (p1, delay 0) + box-shadow fade-in (p1, delay 0) as the + pill fades out; PHASE 2
     vertical — border-radius squares 14px→r-4 (p2, delay p1) as the height grows. shadow-2
     is an even card shadow (vs the downward-biased pill shadow, lopsided on a big card);
     it crossfades none↔shadow-2 and the base .nt-morph has no shadow, so closed-at-rest
     there's no double shadow under the +. */
  .nt-morph.open {
    width: min(460px, calc(100vw - 16px)); /* clamp at viewport edge (8px each side) */
    border-radius: var(--tandem-r-4);
    box-shadow: var(--tandem-shadow-2);
    transition:
      width var(--morph-p1) var(--tandem-ease-out),
      border-radius var(--morph-p2) var(--tandem-ease-out) var(--morph-p1),
      box-shadow var(--morph-p1) var(--tandem-ease-out);
  }
  .nt-grid {
    display: grid;
    grid-template-rows: 0fr; /* closed: body track collapsed */
    overflow: clip;
    /* CLOSE: height collapses FIRST (phase 1 of close) — delay 0, over p2. */
    transition: grid-template-rows var(--morph-p2) var(--tandem-ease-out);
  }
  .nt-morph.open .nt-grid {
    grid-template-rows: 1fr; /* open: body track at natural height */
    /* OPEN: height is PHASE 2 — delayed by p1 so it starts after the horizontal unroll. */
    transition: grid-template-rows var(--morph-p2) var(--tandem-ease-out) var(--morph-p1);
  }
  .nt-cell {
    min-height: 0; /* allow the 0fr track to clip to zero */
    overflow: clip;
  }
  /* While closing, the body stays mounted (so height animates down) but the shell is
     collapsing — keep it non-interactive so a stray click can't hit a vanishing item. */
  .nt-morph:not(.open) .nt-cell {
    pointer-events: none;
  }

  /* 28×28 floating-pill `+` add-tab button — the closed state of the morph. Inherits the
     white/dark/warm background + border + shadow from `.tandem-floating-pill`; absolute so
     it adds no layout height (the shell height is driven by the grid). Fades out fast as
     the shell opens (phase 1); on close fades back in to COMPLETE exactly at the full
     two-phase collapse-end — delay (p1 + p2 − cascade) then a cascade-long fade ends at
     p1 + p2, so the + is opaque the instant the width collapse finishes and the filled
     card drops. No dead window where neither is visible. */
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
      opacity var(--morph-cascade) var(--tandem-ease-out)
        calc(var(--morph-p2) - var(--morph-cascade));
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
    color: var(--tandem-accent); /* glyph tint — harmless, never clipped into an arc */
  }
  /* Accent edge styling (focus ring + hover border) ONLY while the morph is the bare
     pill (:not(.filled)). During the open/close morph the shell is `overflow: clip`,
     which slices the +'s circular outline/border down to whatever arc falls inside the
     shrinking capsule — a stray accent arc (seen on keyboard close, where focus-return
     gives the + a :focus-visible ring). Suppressing these while .filled keeps the morph
     clean; the ring reappears intact once the shell settles back to the pill (overflow
     visible). The hover *color* (the glyph) is harmless and stays unscoped above. */
  .nt-morph:not(.filled) .tab-add-pill:hover {
    border-color: var(--tandem-accent-border);
  }
  .nt-morph:not(.filled) .tab-add-pill:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
</style>
