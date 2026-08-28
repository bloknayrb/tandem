<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { flip } from "svelte/animate";
import { createScratchpad } from "../actions/builtin.svelte.js";
import { isTauriRuntime } from "../cowork/cowork-helpers.js";
import { loadInvoke } from "../cowork/cowork-invoke.js";
import type { ClosedTabRecord } from "../hooks/useClosedTabStack.svelte.js";
import { easeOut, motionOff, tabEnter, tabExit } from "../panels/cardMotion.js";
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
import { measureTabFloor } from "./tab-floor.js";
import { gapFromRects, resolveDragFrame, type TabStripSnapshot } from "./tabDragMotion.js";
// A29 morph (#798): shared timing tokens + reduced-motion token-zeroing.
import "../panels/morphTiming.css";
// A30 tab-reorder drag: --a30-lift/shift/settle/shadow + reduced-motion zeroing.
import "./tabDragMotion.css";

interface Props {
  tabs: OpenTab[];
  activeTabId: string | null;
  onTabSwitch: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  /** Close every tab to the left of the clicked live tab. */
  onCloseToLeft?: (tabId: string) => void;
  /** Close every tab except the given one (tab context menu, #923 Phase 2). */
  onCloseOthers?: (tabId: string) => void;
  /** Close every tab to the right of the given one in display order. */
  onCloseToRight?: (tabId: string) => void;
  /** Target-aware save contract owned by App. */
  onSaveTarget?: (tabId: string, intent: "save" | "save-as") => void | Promise<void>;
  /** Target-aware source-view toggle; activates clicked inactive tabs first. */
  onToggleSourceViewTarget?: (tabId: string) => void | Promise<void>;
  isTabInSourceView?: (tabId: string) => boolean;
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
  /** `tandem:settings.uniformTabWidth`. True clamps every tab to TAB_FLOOR_PX
   * via `.tab-flip.uniform` (CSS only); false runs the measured per-tab floor
   * below. Defaults false so `svelte-harness/registry.ts`, which mounts this
   * component with no props, keeps its adaptive-by-default smoke render. */
  uniformTabWidth?: boolean;
}

const {
  tabs,
  activeTabId,
  onTabSwitch,
  onTabClose,
  onCloseToLeft,
  onCloseOthers,
  onCloseToRight,
  onSaveTarget,
  onToggleSourceViewTarget,
  isTabInSourceView = () => false,
  reorder,
  reduceMotion = false,
  onRequestOpenDialog,
  openMenuTrigger = 0,
  onTabRename,
  renameTrigger = 0,
  closedTabTop = null,
  onReopenClosed,
  uniformTabWidth = false,
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
// A29: the menu is right-anchored and grows LEFT by default (the `+` is normally near
// the right of the tab strip). When the `+` slot sits too close to the viewport's left
// edge to fit the menu growing left (few tabs / narrow window), flip to grow RIGHT so
// the menu never spills off-screen. Decided once per open in toggleNewTabMenu; the class
// flips both the shell anchor (right:0→left:0) and the `+`'s own anchor so the pill stays
// pinned at the slot either way.
let openRight = $state(false);
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
let ctxTabYdoc: OpenTab["ydoc"] | null = null;

async function handleTabContextMenu(e: MouseEvent) {
  if (!isTauriRuntime()) return; // browser → native menu
  const el = (e.target as Element | null)?.closest('[data-testid^="tab-"][role="tab"]');
  const id = tabIdFromElement(el);
  if (!id) return;
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;

  ctxTabId = id;
  ctxTabYdoc = tab.ydoc;
  e.preventDefault();

  try {
    const invoke = await loadInvoke();
    await invoke("show_tab_context_menu", {
      req: buildTabMenuContext(tabs, id, isTabInSourceView(id)),
    });
  } catch {
    // Tauri unavailable / command error — native menu already suppressed.
  }
}

async function runTabAction(id: TabContextMenuActionId) {
  const tabId = ctxTabId;
  if (!tabId) return;
  // Re-resolve the exact right-clicked target for every event. A closed/reopened
  // or otherwise stale menu target no-ops; no action falls back to the active tab.
  const tab = tabs.find((candidate) => candidate.id === tabId);
  // Stable ids may be reused if the same path closes and reopens while a menu
  // event is pending; Y.Doc identity distinguishes that new live incarnation.
  if (!tab || tab.ydoc !== ctxTabYdoc) return;
  switch (id) {
    case "ctx:tab:close":
      guardedClose(tabId);
      return;
    case "ctx:tab:closeLeft":
      onCloseToLeft?.(tabId);
      return;
    case "ctx:tab:closeOthers":
      onCloseOthers?.(tabId);
      return;
    case "ctx:tab:closeRight":
      onCloseToRight?.(tabId);
      return;
    case "ctx:tab:rename":
      if (isRenamable(tab)) startRename(tabId);
      return;
    case "ctx:tab:save":
      if (!tab.readOnly) {
        const intent = tab.source === "upload" ? "save-as" : "save";
        await onSaveTarget?.(tabId, intent);
      }
      return;
    case "ctx:tab:copyFileName":
      try {
        await navigator.clipboard.writeText(tab.fileName);
      } catch {
        /* clipboard denied — best-effort */
      }
      return;
    case "ctx:tab:copyPath":
      // Re-check the path is real here too — don't trust the menu's enabled
      // state alone (defense-in-depth vs a forged action event).
      if (hasRealPath(tab.filePath)) {
        try {
          await navigator.clipboard.writeText(tab.filePath);
        } catch {
          /* clipboard denied — best-effort */
        }
      }
      return;
    case "ctx:tab:reveal":
      if (hasRealPath(tab.filePath)) {
        try {
          const invoke = await loadInvoke();
          await invoke("show_in_file_manager", { path: tab.filePath });
        } catch {
          /* reveal failed — best-effort */
        }
      }
      return;
    case "ctx:tab:toggleSourceView":
      if (tab.format === "md" && !tab.readOnly) await onToggleSourceViewTarget?.(tabId);
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

// ---- A30 tab-reorder drag motion ("lift, part, drop") -------------------
// The dragged tab tracks the pointer, its siblings part to open the slot it
// would land in, and `animate:flip` settles it there on release. Three rules
// make that work, and all three are load-bearing:
//
//  1. The transforms go on `.tab-flip` (the flip host), never on the pill.
//     `getBoundingClientRect()` reflects an element's OWN transform, so a
//     sibling parted by exactly the distance the reorder is about to move it
//     satisfies flip's `from === to` and flip creates no animation for it at
//     all; the dragged tab, measured mid-air and then cleared, gets a correct
//     200ms settle from wherever the pointer left it. The parting IS the settle.
//  2. The transform layer stays IMPERATIVE DOM. Any $effect-driven part of it
//     would run inside the flush — before flip's queued apply() and before our
//     clear — silently inverting rule 1. The one deliberate exception is
//     `invalidateDragGeometry`, where that inversion is exactly what we want.
//  3. The drop target is computed from `dragSnapshot`, not from
//     `elementFromPoint`. See tabDragMotion.ts for why the two are incompatible.
/** The dragged tab, while the transform layer is live. Drives TabItem's lift. */
let liftedId = $state<string | null>(null);
/**
 * No usable geometry: no layout at all (happy-dom, a `display: none` strip), or
 * the snapshot went stale mid-gesture. Deliberately ONE flag rather than two —
 * if parting kept running while targeting fell back to live hit-testing, the
 * void-under-the-pointer defect would come back with the indicator hidden.
 * Degraded ⇒ no lift, no parting, drop indicator shown, live hit-testing.
 */
let dragDegraded = $state(false);

// Non-reactive drag-motion bookkeeping (same family as `pointerId` above).
let dragSnapshot: TabStripSnapshot | null = null;
/** Index-parallel to `dragSnapshot.ids`. */
let dragWrappers: HTMLElement[] = [];
let dragIdSeed: string | null = null;
let dragSlot: number | null = null;
let dragStartScrollLeft = 0;
let dragLastClientX = 0;
let revertTimer: ReturnType<typeof setTimeout> | null = null;
let revertWrappers: HTMLElement[] = [];

/** `--a30-settle` plus slack — when the cancel glide has finished. */
const A30_REVERT_STRIP_MS = 260;

/**
 * The `.tab-flip` wrappers currently in the strip, in render order. Walks live
 * children rather than querying by tab id for the same reason the adaptive-floor
 * pass does: a closing tab lingers ~200ms with its testid intact.
 */
function tabWrappers(el: HTMLElement): HTMLElement[] {
  return Array.from(el.children).filter(
    (c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains("tab-flip"),
  );
}

/**
 * The wrappers this gesture may touch: everything except a tab on its way out.
 *
 * `inert` is Svelte's synchronous outro signal (`transitions.js` `out()`), and
 * excluding those is load-bearing — `fix()` *appends* to the same inline
 * `transform`, so clearing it would fling a closing tab to the container origin
 * for the rest of its collapse.
 *
 * Deliberately NOT filtered on `isConnected`. Writing inline style to a
 * detached node is an unobservable no-op, so the check buys nothing — while on
 * the teardown path it would skip every wrapper and silently turn the destroy
 * clear into a no-op (which is exactly what the unmount test caught).
 */
function liveWrappers(wrappers: HTMLElement[]): HTMLElement[] {
  return wrappers.filter((w) => !w.inert);
}

function captureSnapshot(wrappers: HTMLElement[]): TabStripSnapshot | null {
  if (wrappers.length < 2) return null;
  const ids: string[] = [];
  const lefts: number[] = [];
  const widths: number[] = [];
  for (const w of wrappers) {
    const id = tabIdFromElement(w.querySelector('[role="tab"]'));
    const rect = w.getBoundingClientRect();
    if (!id || rect.width <= 0) return null;
    ids.push(id);
    lefts.push(rect.left);
    widths.push(rect.width);
  }
  return { ids, lefts, widths, gap: gapFromRects(lefts, widths) };
}

/** Pointer travel in SNAPSHOT space: viewport delta plus any strip scroll since. */
function dragOffsetX(): number {
  return dragLastClientX - pointerStartX + ((scrollEl?.scrollLeft ?? 0) - dragStartScrollLeft);
}

function beginDragMotion() {
  const el = scrollEl;
  // Seeded HERE, not inside the $effect that consumes it: that effect
  // early-returns before it reads `tabs`, so a seed maintained there would be a
  // whole gesture stale, and hoisting the read above its guard would make
  // `tabs` a permanent dependency — which its own comment forbids.
  dragIdSeed = tabs.map((t) => t.id).join("\0");
  dragStartScrollLeft = el?.scrollLeft ?? 0;
  dragSlot = null;

  // 1. Take back animation control before measuring. A running Web Animation
  //    outranks normal-priority inline style, so a tab re-grabbed within 200ms
  //    of any settle/open/close would not follow the pointer at all — and the
  //    snapshot would be measured mid-glide. This is also what settles an
  //    INTROING neighbour, whose `tabEnter` animates width 0→w and corrupts
  //    both its own width and every left to its right.
  //    cancel(), not finish(): finish() on an `out:` transition runs Svelte's
  //    completion callback → pause_effect → the node is destroyed, so a closing
  //    tab would vanish instead of collapsing; and finish() only QUEUES its
  //    notification while `fill: forwards` stays applied, so the precedence
  //    problem isn't actually resolved on the next line. cancel() is synchronous.
  const wrappers = el ? liveWrappers(tabWrappers(el)) : [];
  for (const w of wrappers) {
    let anims: Animation[] = [];
    try {
      anims = w.getAnimations();
    } catch {
      // getAnimations() is absent in happy-dom and can throw on a detached node.
    }
    // Per-animation, not around the loop: one InvalidStateError must not skip
    // the rest of this wrapper's animations, or a re-grab mid-settle would find
    // a surviving Web Animation still outranking the inline transform.
    for (const anim of anims) {
      try {
        anim.cancel();
      } catch {
        // cancel() can throw InvalidStateError, and getAnimations() also returns
        // CSS transitions — including this module's own revert.
      }
    }
  }

  // 2. Measure. Probe the ENVIRONMENT, not a proxy for it: happy-dom's
  //    `clientWidth` getter returns a field initialised to 0 and never updated,
  //    so it holds unconditionally and no per-test rect stub can perturb it.
  const snap = el && el.clientWidth > 0 ? captureSnapshot(wrappers) : null;
  if (!snap || !draggedId || !snap.ids.includes(draggedId)) {
    dragSnapshot = null;
    dragWrappers = [];
    dragDegraded = true;
    return;
  }
  dragSnapshot = snap;
  dragWrappers = wrappers;
  dragDegraded = false;
  liftedId = draggedId;

  // The dragged wrapper tracks per-frame, so it must carry no transition.
  // `z-index` as a token, per CLAUDE.md — `check:tokens` only scans hex/rgba,
  // so a bare `1` would ship silently. No `position: relative`: flex items
  // honour z-index at `static`, and it would only add another property for
  // fix()/unfix() to capture and restore.
  const dragged = wrappers[snap.ids.indexOf(draggedId)];
  dragged.style.transition = "none";
  dragged.style.zIndex = "var(--tandem-z-base)";
}

function updateDragMotion() {
  const snap = dragSnapshot;
  const id = draggedId;
  if (!snap || !id) return;
  const dx = dragOffsetX();
  const frame = resolveDragFrame(snap, pointerStartX + dx, id);
  if (frame.slot !== dragSlot) {
    dragSlot = frame.slot;
    dropTarget = frame.target ? { id: frame.target.toId, side: frame.target.side } : null;
    // Pure writes: every number came from the snapshot, so there is no read to
    // interleave and no forced layout per sibling.
    for (let i = 0; i < dragWrappers.length; i++) {
      if (snap.ids[i] === id) continue;
      const w = dragWrappers[i];
      w.style.transition = "transform var(--a30-shift) var(--tandem-ease-out)";
      w.style.transform = frame.shifts[i] === 0 ? "" : `translateX(${frame.shifts[i]}px)`;
    }
  }
  const dragged = dragWrappers[snap.ids.indexOf(id)];
  if (dragged) dragged.style.transform = `translateX(${dx}px)`;
}

function clearDragMotion(wrappers: HTMLElement[]) {
  for (const w of liveWrappers(wrappers)) {
    w.style.removeProperty("transition");
    w.style.removeProperty("transform");
    w.style.removeProperty("z-index");
  }
}

/** The no-reorder release: glide everything home under CSS, then strip it. */
function revertDragMotion(wrappers: HTMLElement[]) {
  const live = liveWrappers(wrappers);
  if (!live.length) return;
  endRevert();
  revertWrappers = live;
  for (const w of live) {
    // Same-batch is enough: per CSS Transitions §"Starting of transitions" the
    // AFTER-change style supplies transition-property, so declaring the
    // transition and clearing the transform together does animate. No forced
    // reflow, and none should be added back.
    w.style.transition = "transform var(--a30-settle) var(--tandem-ease-out)";
    w.style.removeProperty("transform");
  }
  revertTimer = setTimeout(endRevert, A30_REVERT_STRIP_MS);
}

/**
 * Strip the revert's leftovers. Runs on the timer, and eagerly on the next
 * pointerdown / teardown. Stripping the TRANSITION matters as much as the
 * transform: left behind it stays on the wrapper for good, and `fix()`
 * early-returns when `getAnimations()` is non-empty — so a tab closed later
 * would skip its position pinning and jump instead of collapsing in place.
 */
function endRevert() {
  if (revertTimer) {
    clearTimeout(revertTimer);
    revertTimer = null;
  }
  for (const w of revertWrappers) {
    w.style.removeProperty("transition");
    w.style.removeProperty("z-index");
  }
  revertWrappers = [];
}

/**
 * The snapshot no longer describes the strip. Fall back to degraded mode for
 * the rest of the gesture rather than re-measuring mid-flight: a fresh snapshot
 * taken while the transforms are applied would measure transformed rects, and
 * one taken after clearing them would visibly jump.
 */
function invalidateDragGeometry() {
  if (!dragSnapshot) return;
  // Same reason `buildDecorations()` warns on a CRDT fallback: the feature
  // degrades to a visibly poorer mode with no other signal, and "the tabs
  // stopped animating mid-drag" is otherwise unreproducible from a bug report.
  // Only this path warns — a strip that never had geometry is zero-width, i.e.
  // not on screen, so nobody is dragging it and there is nothing to report.
  console.warn("[tandem] tab strip geometry changed mid-drag; falling back to hit-testing");
  // The one $effect-driven write into the transform layer, and the inversion is
  // the point: measure() runs with the transforms still on, this clears them
  // inside the same flush, apply() then reads an untransformed `to` — so the
  // dragged tab glides home and the siblings un-part instead of snapping.
  clearDragMotion(dragWrappers);
  dragSnapshot = null;
  dragWrappers = [];
  dragIdSeed = null; // fire once per gesture
  dragSlot = null;
  // Also drop the resolved target: it was computed against the snapshot this
  // function just discarded, and handlePointerUp reads it unconditionally. An
  // immediate pointerup with no intervening pointermove to re-resolve a fresh
  // target must fall through to the "no valid drop target" revert path below,
  // not commit a reorder against geometry that no longer exists.
  dropTarget = null;
  liftedId = null;
  dragDegraded = true;
}

// A finished drag may emit a trailing synthetic click that would fire the tab's
// onclick → switch. Swallow it. A no-move press installs nothing, so plain
// click-to-switch is unaffected. The setTimeout(0) fallback removes the listener
// if no click arrives (a drag ending over a different tab often fires no click
// at all) so it can never eat a later legit click.
function installClickSuppressor() {
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

function onWindowPointerMove(e: PointerEvent) {
  handlePointerMove(e);
}
function onWindowPointerUp(e: PointerEvent) {
  handlePointerUp(e);
}
function onWindowPointerCancel(e: PointerEvent) {
  if (pointerId === null || e.pointerId !== pointerId) return;
  // No click suppressor: a cancelled pointer emits no trailing click.
  if (dragging) revertDragMotion(dragWrappers);
  clearDragState();
}
function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (dragging) {
    revertDragMotion(dragWrappers);
    // clearDragState() nulls pointerId, so the real pointerup early-returns and
    // never installs this — the trailing click reaches onswitch and the tab
    // activates. Under A30 that reads as "I cancelled, it flew back, and then
    // it switched anyway."
    installClickSuppressor();
  }
  clearDragState();
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
  // Deliberately does NOT clear the transforms: the caller decides between the
  // flip settle and the CSS revert, and both outlive this call.
  liftedId = null;
  dragDegraded = false;
  dragSnapshot = null;
  dragWrappers = [];
  dragIdSeed = null;
  dragSlot = null;
}

// Safety net: a component unmount (or HMR) mid-drag would otherwise leak the
// window listeners, since clearDragState is only reached via pointer/keyboard
// events that won't fire after teardown. clearDragState is idempotent.
//
// The transform layer has to be stripped FIRST and explicitly. Every other exit
// path decides between the flip settle and the CSS revert before calling
// clearDragState, which is why clearDragState deliberately leaves the styles
// alone — but a teardown makes no such decision, and clearDragState empties
// `dragWrappers` on its way out. A full unmount takes the nodes with it, so this
// only bites under HMR, where svelte-hmr can keep the elements alive: a leftover
// inline `transition` there keeps `getAnimations()` non-empty, and `fix()`
// early-returns on that, so the next tab close would jump instead of collapsing.
onDestroy(() => {
  clearDragMotion(dragWrappers);
  endRevert();
  clearDragState();
});

// Clear drag state if the dragged or target tab is unmounted mid-drag.
// pointerup doesn't fire reliably when the source element leaves the DOM.
// No-op unless an id has actually disappeared — must NOT become a broad
// clearDragState() (would null draggedId on every Yjs awareness ping).
$effect(() => {
  if (!draggedId && !dropTarget) return;
  const ids = tabs.map((t) => t.id);
  const idSet = new Set(ids);
  if (draggedId && !idSet.has(draggedId)) draggedId = null;
  if (dropTarget && !idSet.has(dropTarget.id)) dropTarget = null;
  // A30: any change to the ORDERED id list invalidates the snapshot's midpoints
  // and parting magnitudes — not just the removal of a participant, and order
  // deliberately counts (a reorder from another surface moves every left). Gated
  // on the seed being non-null because `draggedId` is set at pointerdown, up to
  // 5px before the seed exists — an ungated compare would read the PREVIOUS
  // gesture's seed and drop every drag after the first into degraded mode.
  // The drop itself is not caught here: `clearDragState()` nulls the seed
  // synchronously, before the reorder's flush ever reaches this effect.
  if (dragIdSeed !== null && ids.join("\0") !== dragIdSeed) invalidateDragGeometry();
});

// A30: width-only snapshot invalidation. The id-set detector above is blind to
// changes that move lefts without changing the set, and the adaptive-floor pass
// below makes those routine — `activeTabId` changing re-renders that name at
// font-weight 500, measurably wider than the 400 it was measured at, and with
// `flex-shrink: 1` every left and width moves with it. Stale midpoints open the
// gap at the wrong index AND break flip's `from === to` cancellation on drop,
// leaving a residual glide.
//
// The deps are read BEFORE the guard on purpose: an effect that early-returns
// before reading a signal registers no dependency on it and never re-runs.
// `tabs` is deliberately NOT among them — `orderedTabs` is a `$derived.by`
// returning a fresh array on every evaluation, so tracking it here would fire on
// every Yjs awareness ping and degrade every drag. A local rename is covered by
// `renamingTabId`; a remote one isn't. That's not just a cosmetic gap: `dropTarget`
// is resolved against the same stale snapshot, so a remote rename mid-drag can
// misplace the COMMITTED reorder, not only the animation. Accepted, deferred gap
// (see PR's "Deferred, flagged back to design" table) — do not fix here.
$effect(() => {
  void activeTabId;
  void renamingTabId;
  void fontsSettled;
  void uniformTabWidth;
  if (dragSnapshot) invalidateDragGeometry();
});

// The tab strip's width floor, mirrored by `.tab-flip`'s `min-width` below.
// Uniform mode pins every tab here; adaptive mode clamps each measured per-tab
// floor to it, so no tab is ever wider than this on a crowded strip.
// Owned by `./tab-floor.js` — imported above — since `tabEnter` (cardMotion.ts)
// needs the exact same value and measurement logic synchronously at transition
// setup, before this component's own $effect below has run. Keep the numeric
// rationale (chrome + filename) there, not here.

function updateScrollState() {
  const el = scrollEl;
  if (!el) return;
  canScrollLeft = el.scrollLeft > 0;
  canScrollRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}

// A30: `scrollBehavior` is "smooth" and the auto-scroll effect below fires on a
// remote `activeTabId` change (Claude calling tandem_open / tandem_switchDocument),
// animating `scrollLeft` over ~300ms while emitting ZERO pointermove events. The
// snapshot's lefts are frozen viewport values, so without recomputing here the
// dragged tab would slide out from under the cursor and the midpoints would drift.
function onScrollerScroll() {
  updateScrollState();
  if (dragging && !dragDegraded) updateDragMotion();
}

// Set up scroll listeners and resize observer
$effect(() => {
  const el = scrollEl;
  if (!el) return;
  updateScrollState();
  el.addEventListener("scroll", onScrollerScroll, { passive: true });
  const observer = new ResizeObserver(() => {
    // A30: the scroller's own box changed, so every snapshot left is stale.
    // (Child width changes don't reach here — the scroller's box doesn't move
    // when its children resize — which is why the width-only invalidation
    // effect above exists as well.)
    if (dragSnapshot) invalidateDragGeometry();
    updateScrollState();
  });
  observer.observe(el);
  return () => {
    el.removeEventListener("scroll", onScrollerScroll);
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

// Webfonts are `font-display: swap` (index.html) and session restore opens tabs
// before the real faces land, so every filename's advance width changes shortly
// after first paint. Without re-measuring on that event the adaptive floors
// below would freeze at fallback-font widths for the whole session — the
// default startup path, not an edge case.
let fontsSettled = $state(false);
$effect(() => {
  let cancelled = false;
  document.fonts?.ready.then(() => {
    if (!cancelled) fontsSettled = true;
  });
  return () => {
    cancelled = true;
  };
});

// Adaptive tab widths (`uniformTabWidth: false`). CSS cannot express
// "floor at min(my own natural width, TAB_FLOOR_PX)" — the name span's
// explicit `min-width: 0` zeroes its min-content contribution outright (this
// is the override, not the `min-width: auto` + `overflow: hidden` automatic-
// minimum rule, which would reach the same zero by a different route), so the
// filename never reaches the wrapper's min-content. Hence a measured floor.
// Uniform mode needs none of this: `.tab-flip.uniform` pins the wrapper in CSS.
$effect(() => {
  const el = scrollEl;
  if (!el) return;
  // Tracked deps. `activeTabId` is load-bearing: the active tab's name renders
  // at font-weight 500 and is measurably wider than the 400 it was measured at.
  void uniformTabWidth;
  // .map alone registers the dep on every fileName AND every readOnly (the RO
  // badge is folded into the chrome measurement below) — nothing consumes the
  // mapped result itself. A single `.map` (not two) keeps both deps tied to
  // one array walk. Every writer of `tab.readOnly` reassigns the whole
  // `tabsState` array today, so `fileName` alone would still invalidate this
  // effect correctly — but that's an implicit convention elsewhere, not a
  // guarantee this effect should lean on; tracking `readOnly` explicitly here
  // removes the footgun regardless of how tabsState gets mutated in the future.
  void tabs.map((t) => [t.fileName, t.readOnly]);
  void activeTabId;
  void renamingTabId;
  void fontsSettled;

  // Walk live children rather than querying by tab id. Originally justified
  // here as: "a closing tab lingers ~200ms with its testid intact, so a
  // close-then-reopen of the same document would otherwise resolve to the
  // dying node" — that premise doesn't hold. Tab ids are stable per file path,
  // so a close-then-reopen of the same file reuses the same `{#each (tab.id)}`
  // key, and Svelte 5's keyed-each reconcile RESURRECTS the still-outroing
  // effect for a reappearing key rather than mounting a second one (see
  // `reconcile()` in svelte/src/internal/client/dom/blocks/each.js, and the
  // pinned regression test in tests/client/DocumentTabs.svelte.test.ts,
  // "same-key close-then-reopen"). There is only ever one DOM node per id, so
  // an id-based query would resolve to the same live node this walk does.
  // Kept anyway because it's the more direct way to get "every tab-flip
  // wrapper currently in the DOM, in visual order" without cross-referencing
  // the `tabs` prop per id — not because of the dying-node hazard above.
  const wrappers = tabWrappers(el);

  if (uniformTabWidth) {
    for (const w of wrappers) w.style.removeProperty("min-width");
    updateScrollState();
    return;
  }

  // Pass 1 — measure only (via the SAME helper `tabEnter` calls synchronously
  // for a just-opened tab — see cardMotion.ts). Writing inside this loop would
  // dirty layout and force a fresh reflow for every subsequent tab (O(n)
  // synchronous layouts).
  const floors = wrappers.map(measureTabFloor);

  // Pass 2 — write. Deliberately NOT `!important`: cardMotion's exit keyframes
  // carry `min-width: 0`, and the animation origin outranks an inline value
  // only while that value is not important. Marking these would freeze the
  // close/open collapse at the floor — rev 1's bug by another route.
  wrappers.forEach((w, i) => {
    w.style.minWidth = `${floors[i]}px`;
  });

  // The ResizeObserver above watches the scroller, not its children, and the
  // scroller's own box doesn't move when child widths do — so without this the
  // mask-fade classes go stale after a rename, a font swap, or a mode toggle.
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
  // A30: never start a gesture on the tab being renamed. A drag from the pill's
  // padding pulls focus off the input, whose blur commits `finish(false)` — the
  // rename would be silently discarded by the act of grabbing the tab.
  if (renamingTabId === id) return;
  // A cancelled drag's glide is still stripping itself; a new grab supersedes it.
  endRevert();
  // So does a gesture that never ended. A second finger on another tab, or a
  // pointerup swallowed by the OS, would otherwise leave the previous gesture's
  // lift and parting on the strip while this one overwrites the latch that was
  // the only handle on them. Tear it down rather than refusing to start: a
  // guard on `pointerId !== null` would make one lost release kill dragging for
  // the rest of the session.
  if (pointerId !== null) {
    clearDragMotion(dragWrappers);
    clearDragState();
  }
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
    // A30 fires the lift here rather than on a 150ms hold. A hold gate needs a
    // "lifted but never moved" terminal state, and without one a deliberate slow
    // click would lift the tab, set `dragging`, install the click suppressor —
    // and the tab would not switch, breaking the contract two lines below.
    beginDragMotion();
  }
  e.preventDefault();
  dragLastClientX = e.clientX;
  if (!dragDegraded && dragSnapshot) {
    updateDragMotion();
    return;
  }
  // Degraded: the pre-A30 live hit-test, kept intact. It is only reachable when
  // nothing is parting, so the void it would otherwise read as "no target"
  // cannot exist here.
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
  const from = draggedId;
  const wrappers = dragWrappers;
  // Drop the lift before the commit. This is a $state write, so it schedules the
  // very flush the reorder below will reconcile in.
  liftedId = null;
  let invoked = false;
  if (
    wasDragging &&
    from &&
    target &&
    target.id !== from &&
    reorder &&
    tabs.some((t) => t.id === from) &&
    // A closing tab lingers ~200ms during its s3 `out:` collapse with its tab
    // testid and role intact, so it can still be picked as a drop target — guard
    // against reordering onto an id no longer in `tabs`.
    tabs.some((t) => t.id === target.id)
  ) {
    try {
      reorder(from, target.id, target.side);
      invoked = true;
    } catch (err) {
      // `reorder` is a host prop — this component can't know what it does. A
      // throw here used to skip everything below it, stranding the transform
      // layer, the pointer latch and the window listeners for the rest of the
      // session. Treat it as not-invoked: no reorder means no reconcile, so the
      // revert path is the correct one, and the gesture still tears down.
      console.warn("[tandem] tab reorder threw; reverting the drag", err);
    }
  }
  if (wasDragging) {
    // The discriminator is "was `reorder` INVOKED", not "did the order change".
    // `applyReorder` returns `order.filter(...)` — a new array even when it
    // changes nothing — so any invocation dirties `localOrder`, re-derives
    // `orderedTabs` and reconciles the each block; and measure()/apply() run on
    // ALL surviving items on every reconcile, not only the ones that moved. It
    // cannot be a return value either: `reorder` is typed `void`, so
    // `const committed = reorder(...)` would be undefined on every call and send
    // 100% of drops down the revert path.
    if (invoked) {
      // Between flip's measure() (already run, with the transforms on, during
      // this flush's each-reconcile) and its apply() (queued at the end of that
      // reconcile). Clearing EARLIER makes measure() read the untransformed
      // original slot, so flip computes a full (w + gap) delta and the drop jumps
      // backwards then glides forwards; leaving it on at apply() time bakes the
      // transform into the css flip prepends, and the tab snaps 200ms later.
      // A flushSync landing between here and the microtask — tick(), an {#await}
      // resolving — would run measure() AND apply() with the transform still on.
      queueMicrotask(() => clearDragMotion(wrappers));
    } else {
      // No call ⇒ the each collection is never re-evaluated ⇒ the block never
      // reconciles ⇒ measure()/apply() do not run at all. There is no flip to
      // settle the tab, so an unconditional clear would snap it home from
      // mid-air — and equally no flip for this CSS revert to race.
      revertDragMotion(wrappers);
    }
    installClickSuppressor();
  }
  clearDragState();
}

// Keyboard reordering (Alt+Arrow swaps with neighbor)
function handleKeyDown(e: KeyboardEvent, id: string) {
  if (!e.altKey || !reorder) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  // A30: Alt+Arrow stays live mid-drag (pointerdown focuses the tab, and
  // onWindowKeyDown only intercepts Escape). Interleaving them would commit a
  // keyboard reorder against the pointer gesture's snapshot, leave the parted
  // siblings gliding toward a drop that will no longer happen, and layer a
  // second reorder on release. Gate on `dragging` — the flag set past the 5px
  // threshold — NOT on `pointerId !== null`: that is a latch cleared only by
  // pointerup/pointercancel/Escape/onDestroy, so it would block keyboard
  // reorder during a press-and-hold, and any missed release would silently kill
  // keyboard reorder for the rest of the session.
  if (dragging) return;

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
    openRight = shouldOpenRight();
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

// Open-direction edge guard. The menu width matches the CSS clamp `min(460px,
// 100vw - 16px)`. Default = grow left (return false). Flip to grow right only when the
// menu would clip the left viewport edge growing left AND growing right has the room;
// if neither side fits the full width (very narrow window), grow toward the larger gap.
const NT_MENU_MAX_WIDTH = 460;
const NT_VIEWPORT_MARGIN = 8;
function shouldOpenRight(): boolean {
  if (!openBtnEl) return false;
  const rect = openBtnEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const width = Math.min(NT_MENU_MAX_WIDTH, vw - 2 * NT_VIEWPORT_MARGIN);
  if (rect.right - width >= NT_VIEWPORT_MARGIN) return false; // fits growing left
  if (rect.left + width <= vw - NT_VIEWPORT_MARGIN) return true; // fits growing right
  return vw - rect.left > rect.right; // neither fits — pick the side with more room
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
     the canvas behind TitleBar's center cluster (its only production host —
     `svelte-harness/registry.ts` also mounts it standalone for visual smoke
     tests, so don't assume TitleBar's context is always present).

     Mask-fade overflow: when the scroller has hidden content on either side
     we apply `.has-overflow` (both sides) or `.overflow-left` / `.overflow-right`
     (one side) modifier classes on `.tab-scroll-mask`. The mask is a 22px
     linear-gradient fade matching the v7 design recipe — replaces the prior
     left/right arrow buttons, which became redundant with native trackpad
     scroll + the visual cue from the fade. -->
<div
  style="position: relative; display: flex; align-items: center; background: transparent; min-height: 32px; z-index: var(--tandem-z-base); width: 100%; min-width: 0;"
>
  <!-- `flex: 0 1 auto` (content-sized, shrinkable) — NOT `flex: 1`. The center
       cluster now stretches nearly to the actions cluster, so a growing scroller
       would push `.nt-wrap` to the far right, detaching "+" from the last tab and
       flipping `shouldOpenRight()`; it would also make `clientWidth` permanently
       >= `scrollWidth`, so overflow would never be detected and the mask fade
       below would never appear. `min-width: 0` belongs here (unlike on the tabs):
       yielding and scrolling is exactly this element's job.

       `data-tauri-drag-region="false"` is load-bearing twice over. For Tauri: a
       click that lands on a *pill* already blocks on its own role="tab", but one
       that lands in the 6px gap between pills hits this container, which carries
       no interactive role and would otherwise fall through to TitleBar's `deep`.
       For Tandem's own `isInActiveDragRegion` — a naive `closest()` lookup that
       knows nothing about Tauri's self-only or clickable-blocks rules — even a
       click on a pill resolves to the `deep` region, reads as "on drag surface",
       and stops dismissing an open new-tab menu. -->
  <div
    bind:this={scrollEl}
    data-testid="tab-scroll-container"
    data-tauri-drag-region="false"
    class={[
      "tab-scroll-hide",
      "tab-scroll-mask",
      canScrollLeft && canScrollRight && "has-overflow",
      canScrollLeft && !canScrollRight && "overflow-left",
      !canScrollLeft && canScrollRight && "overflow-right",
    ]}
    role="tablist"
    aria-label="Open documents"
    style="display: flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden; padding: 6px 8px;"
  >
    {#each tabs as tab (tab.id)}
      <!-- s3 reorder (#798): a `role="presentation"` flex wrapper carries
           `animate:flip` so the non-dragged tabs glide to their new slots when
           the list reorders on drop. `animate:` must sit on the keyed each's
           immediate child *element* (TabItem is a component, so it can't take
           the directive directly); the presentation role keeps the tablist→tab
           ownership intact (axe traverses the transparent wrapper). Drag
           hit-testing (closest on the tab-prefixed testid + role=tab) and
           scroll-into-view (querySelector on the active tab testid) both
           resolve to the TabItem root inside — the wrapper carries no testid
           and role="presentation", so it's invisible to them.

           The s3 open/close transitions live here too, NOT on the TabItem root,
           and that placement is load-bearing: they animate `width` to 0 and
           inject `min-width: 0` to clear the compression floor on the way down,
           and that floor is on THIS element (see `.tab-flip` below). Left on the
           pill inside, the transition released a floor that wasn't there while
           this wrapper stayed pinned at 142px — so a closing tab's footprint
           collapsed 257→142 and then snapped to 0, and its neighbours jumped
           instead of gliding (measured). -->
      <div
        class="tab-flip"
        class:uniform={uniformTabWidth}
        role="presentation"
        animate:flip={{ duration: motionOff(reduceMotion) ? 0 : 200, easing: easeOut }}
        in:tabEnter={{ reduceMotion, uniformTabWidth }}
        out:tabExit={{ reduceMotion }}
      >
        <!-- A30: the parted gap IS the drop indicator, so the 2px accent wedge
             renders only in degraded mode — where nothing parts, and where
             removing it would leave a mid-drag `tabs` change with no feedback at
             all for the rest of the gesture. `dropIndicator` and `lifted` are
             mutually exclusive by construction, so this isn't double-signalling. -->
        <TabItem
          {tab}
          isActive={tab.id === activeTabId}
          onswitch={onTabSwitch}
          onclose={guardedClose}
          onpointerdown={handleTabPointerDown}
          dropIndicator={dragDegraded && dropTarget?.id === tab.id ? dropTarget.side : null}
          lifted={liftedId === tab.id}
          onkeydown={handleKeyDown}
          isRenaming={renamingTabId === tab.id}
          onstartrename={startRename}
          onrename={commitRename}
          onrenamecancel={cancelRename}
        />
      </div>
    {/each}
  </div>

  <!-- A29 (#798): the "+" is the closed state of a persistent single-shell morph. Clicking
       it morphs the pill in place into the new-tab menu (un-portaled — no <body> portal).
       The shell lives OUTSIDE role="tablist" (a tablist may only contain role="tab"
       children — axe `aria-required-children`) AND outside the .tab-scroll-mask scroller,
       so its growth is never clipped by the horizontal tab overflow. The 28×28 .nt-wrap
       placeholder holds the in-flow slot stable while the absolute .nt-morph grows
       down-and-left from the + slot. -->
  <!-- `data-tauri-drag-region="false"` is load-bearing for Tauri here (unlike on
       the scroller): the expanded menu's root is role="dialog" tabindex="-1" and
       its chrome is plain divs, none of which Tauri counts as interactive — so
       under TitleBar's `deep` region every one of them would become a window-drag
       handle and swallow mousedown inside an open menu. -->
  <div class="nt-wrap" data-tauri-drag-region="false">
    <div class="nt-morph" class:open={showRecent} class:filled={showRecent || bodyMounted} class:grow-right={openRight} bind:this={morphEl}>
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
                void createScratchpad({ announceBusy: true });
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
  /* s3 reorder (#798): transparent flex wrapper that carries `animate:flip`.
     It must not introduce box geometry of its own — `display: contents` would
     drop it from the flex layout (and break the FLIP measurement), so it's a
     zero-padding flex item that wraps the TabItem pill.

     `flex-shrink: 1` so compression reaches the pill: with room to spare tabs
     sit at their natural width, and when the strip fills they narrow together
     before it falls back to scrolling. In adaptive mode a short-named tab's
     measured floor EQUALS its natural width, so a strip of short names cannot
     compress at all — it goes straight to scrolling. That is intended
     (a tab is never wider than its own filename needs).

     The explicit `min-width` is the tab strip's compression floor in uniform
     mode, and the CEILING the adaptive floor is clamped to in the other (see
     the measured per-tab pass in the script — it writes a smaller inline
     `min-width` on tabs whose own filename doesn't need this much). Either way
     it has to live here — on the outermost shrinking box — rather than on the
     pill inside. Two rules make that non-obvious:
       - Left at `auto`, this wrapper's minimum is the pill's min-content
         *contribution*, which a `min-width` can only raise, never lower. So the
         floor would track the filename and a long-named tab could never give a
         pixel back (measured: pinned at 259px).
       - Put the floor on the pill instead and this wrapper shrinks straight
         past it, so the pill overflows its own wrapper and tabs overlap
         (measured: wrapper 129.5px around a 142px pill).
     So: floor here, `min-width: 0` on the pill AND on its name span (the two
     nodes that would otherwise contribute a content-based minimum), and the
     pill flexes to whatever width this box settles at. The value must stay a
     real number — it is also what makes the scroller overflow, which is what
     keeps the mask fade and horizontal scroll alive.

     142px is TabItem's chrome (indicator + gaps + close + padding + borders,
     ~60px) plus ~80px of filename, the least that still reads as a name; the
     total is the measured resting width, the split is approximate. Keep it in
     sync with TabItem's pill if that chrome changes.
     `tests/e2e/tab-overflow.spec.ts` pins the floor against the 259px
     no-compression regression. */
  .tab-flip {
    display: flex;
    flex-shrink: 1;
    min-width: 142px;
  }

  /* Uniform mode: pin the WRAPPER to a single width. (`true` is the SETTINGS
     default, in `useTandemSettings`'s DEFAULTS — this component's own prop
     defaults to `false` so the props-less harness mount stays adaptive. See
     the `uniformTabWidth` Props JSDoc.) Matching min and max is what makes it
     uniform — the floor
     alone only rescues tabs that are too narrow, and nothing capped the ones
     that are too wide.

     The pin deliberately clamps this box rather than sizing the name span,
     because two pill layouts put width outside that span: a read-only tab adds
     an RO badge plus a gap (~29px) beside it, and an inline rename replaces the
     span entirely with an input carrying its own 80px minimum. Measured sparse,
     sizing the span gave 246.3 / 287.7 / 221.4 for plain / read-only /
     renaming; clamping here gives 142 / 142 / 142. Clamping the wrapper is
     indifferent to all of it, since the pill and its name span already carry
     `min-width: 0` and simply ellipsize.

     Safe against the open/close motion: cardMotion animates `width` down to 0
     and a max-width never blocks shrinking. Do NOT convert this to a flex-basis
     (`flex: 1 1 0`) — a non-auto basis overrides the inline `width` those
     transitions animate and the collapse goes inert. */
  .tab-flip.uniform {
    min-width: 142px;
    max-width: 142px;
  }

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
  /* Edge guard: when the + slot is too close to the left viewport edge to fit the menu
     growing left, openRight flips the anchor so the shell grows RIGHT instead. The + must
     re-anchor to the same (now left) edge so the pill stays pinned at the slot. The width
     animation and capsule radius are direction-symmetric, so the morph reads identically. */
  .nt-morph.grow-right {
    right: auto;
    left: 0;
  }
  .nt-morph.grow-right .tab-add-pill {
    right: auto;
    left: 0;
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
  /* ...but `.nt-cell` is only the body. The FILLED shell itself keeps its card
     surface for the whole ~860ms close collapse, and while it is wide it sits
     over the tab strip — so the tabs underneath stay unhittable long after the
     menu visually left. An A29 correctness bug in its own right; A30 makes it
     reachable, because a grab that lands on the shell never starts a gesture at
     all. The `+` must opt back in: it lives inside the same shell. */
  .nt-morph.filled:not(.open) {
    pointer-events: none;
  }
  .nt-morph.filled:not(.open) .tab-add-pill {
    pointer-events: auto;
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
  /* Reduced motion: this shorthand MIXES a token-driven opacity term with three
     LITERAL 0.15s terms, so zeroing --morph-cascade/--morph-p2 reaches the fade
     and nothing else — the colour/border/background tweens survive. Re-declare
     the whole shorthand as `none` on the exact selector. Dual guard: the in-app
     `body.tandem-reduce-motion` (class on <body>, so :global(...)) AND the OS
     pref; the media half must come AFTER the rule it guards, since its
     specificity only ties. #1530. */
  :global(body.tandem-reduce-motion) .tab-add-pill {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .tab-add-pill {
      transition: none;
    }
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
  /* The open-state variant carries the same mixed shorthand, and a guard on the
     bare `.tab-add-pill` loses to it on specificity — so repeat the full
     descendant selector verbatim in both halves. */
  :global(body.tandem-reduce-motion) .nt-morph.open .tab-add-pill {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .nt-morph.open .tab-add-pill {
      transition: none;
    }
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
