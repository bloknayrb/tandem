<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { untrack } from "svelte";
import * as Y from "yjs";
import {
  HIGHLIGHT_COLOR_VARS,
  HIGHLIGHT_COLORS,
  Y_MAP_ANNOTATIONS,
} from "../../../shared/constants";
import { withBrowser } from "../../../shared/origins";
import { toPmPos } from "../../../shared/positions/types";
import type { Annotation, AnnotationType, HighlightColor } from "../../../shared/types";
import { generateAnnotationId } from "../../../shared/utils";
import { createAgentLabel } from "../../hooks/useAgentLabel.svelte";
import { createTandemSettings } from "../../hooks/useTandemSettings.svelte";
import { ENTER_POPUP_MS, popupEnter, registerFlySource } from "../../panels/cardMotion";
import { pmPosToFlatOffset } from "../../positions";
import DecorationsMenu from "../../shell/DecorationsMenu.svelte";
import { onOutsideEvent } from "../../utils/dismiss-outside";
import FormattingToolbar from "./FormattingToolbar.svelte";
import { clearHighlight, toggleHighlight } from "./highlight-toggle";
import {
  attachSelectionToolbarListener,
  computeSelectionToolbarPosition,
  SELECTION_POPUP_HEIGHT_RESERVE,
  type SelectionToolbarPlacement,
} from "./selection-toolbar";
// A26 morph (#798): shared timing tokens + reduced-motion token-zeroing.
import "../../panels/morphTiming.css";

interface Props {
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
  selectionToolbar?: boolean;
  suppressSelectionToolbar?: boolean;
  /**
   * Counter prop — when it changes, the comment popup is shown (if there's a
   * non-empty editor selection) and focus moves to its textarea. Used by the
   * Ctrl+Alt+M global shortcut in App.svelte.
   */
  requestCommentFocus?: number;
  // 1.11: decoration display state, threaded through so the popup can mirror
  // the formatting bar's Decorations split button (the reachability guarantee
  // when the bar is hidden). Same prop shape as FormattingBar/DecorationsMenu.
  showAuthorship?: boolean;
  showComments?: boolean;
  showHighlights?: boolean;
  showNotes?: boolean;
  decorationsMuted?: boolean;
  onUpdateDecorations?: (partial: {
    showAuthorship?: boolean;
    showComments?: boolean;
    showHighlights?: boolean;
    showNotes?: boolean;
    decorationsMuted?: boolean;
  }) => void;
  onOpenSettings?: () => void;
  // 1.11 / A8: whether the persistent formatting bar is currently shown. The
  // popup always surfaces a swap control that toggles it (hide when shown, show
  // when hidden) — so the bar is reachable without the command palette /
  // Appearance settings, and hideable straight from the popup. (A8 spec: the
  // swap lives in the format row; the bar mirrors the format row.)
  formattingBarVisible?: boolean;
  onToggleFormattingBar?: () => void;
  /** App `reduceMotion` setting, threaded to the A28 popup entrance transition. */
  reduceMotion?: boolean;
}

let {
  editor,
  ydoc,
  selectionToolbar = true,
  suppressSelectionToolbar = false,
  requestCommentFocus = 0,
  showAuthorship = true,
  showComments = true,
  showHighlights = true,
  showNotes = true,
  decorationsMuted = false,
  onUpdateDecorations,
  onOpenSettings,
  formattingBarVisible = true,
  onToggleFormattingBar,
  reduceMotion = false,
}: Props = $props();

const agentLabel = createAgentLabel(createTandemSettings());

let hasSelection = $state(false);
let selectionPosition = $state<{
  left: number;
  top: number;
  bottom: number;
  placement: SelectionToolbarPlacement;
} | null>(null);
let toolbarEl = $state<HTMLDivElement | null>(null);
let annotationText = $state("");
let capturedRange = $state<{ from: number; to: number } | null>(null);
let textareaEl = $state<HTMLTextAreaElement | null>(null);
let annotateMode = $state(false);

// A28 dwell + entrance (#798).
// `dwellSatisfied` gates `showPopup`: the popup appears only after the selection
// has been held steady for DWELL_MS (a NEW client-side intent gate — NOT
// `selectionDwellMs`, which gates the server channel selection event). `entering`
// freezes the width-feedback positioning (see updateToolbarMetrics) for the
// duration of the entrance so the left-clamp can't jitter as the popup's width
// unrolls. Both are plain timers; `beginEntrance()` sets `entering` in the SAME
// synchronous write that flips `dwellSatisfied`/the requestCommentFocus bypass,
// so it is already true when the mount-triggered ResizeObserver effect runs.
const DWELL_MS = 360;
let dwellSatisfied = $state(false);
let entering = $state(false);
let dwellTimer: ReturnType<typeof setTimeout> | undefined;
let enteringTimer: ReturnType<typeof setTimeout> | undefined;
// Selection endpoints the dwell timer is currently armed for. Plain `let` (read
// from a Tiptap listener, not a reactive scope).
let lastDwellFrom = -1;
let lastDwellTo = -1;

function beginEntrance() {
  entering = true;
  clearTimeout(enteringTimer);
  enteringTimer = setTimeout(() => {
    entering = false;
  }, ENTER_POPUP_MS);
}

function clearDwell() {
  clearTimeout(dwellTimer);
  clearTimeout(enteringTimer);
  dwellSatisfied = false;
  entering = false;
  lastDwellFrom = -1;
  lastDwellTo = -1;
}

// A26 morph (#798). The popup's two content blocks are ALWAYS mounted (so the
// unfurl has a "from" value and so focus/draft handlers never race a swap-mount);
// the inactive one is collapsed via `grid-template-rows: 0fr` and made `inert`.
// The unfurl animates grid rows 0fr→1fr (to the natural content height, with a
// correct ease-out settle, tracking textarea growth for free — no measurement,
// no max-height cap, no clip-on-typing). CSS transitions never fire on an
// element's initial computed value, so the popup mounts in format state with no
// animation — no `.ready` gate needed. See the scoped style block and morphTiming.css.

// Render anchor: `below` is top-anchored (grows down); `above` is bottom-anchored
// (grows up) so the popup never repositions or grows over the selection as its
// height animates. Placement is decided with a constant height-reserve (see
// updateSelectionAffordance) so it can't flip mid-morph.
const popupPositionStyle = $derived.by(() => {
  const p = selectionPosition;
  if (!p) return "";
  const vertical =
    p.placement === "above"
      ? `bottom: ${p.bottom}px; top: auto;`
      : `top: ${p.top}px; bottom: auto;`;
  return `left: ${p.left}px; ${vertical}`;
});

let toolbarWidth = $state(0);
let viewportHeight = $state(window.innerHeight);
let viewportWidth = $state(window.innerWidth);

const MINI_HIGHLIGHT_COLORS = Object.keys(HIGHLIGHT_COLORS) as HighlightColor[];

const canAnnotate = $derived(!!editor && !!ydoc && hasSelection);
const showPopup = $derived(
  selectionToolbar &&
    !suppressSelectionToolbar &&
    canAnnotate &&
    selectionPosition !== null &&
    dwellSatisfied,
);
const annotationTextTrimmed = $derived(annotationText.trim());

// Plain `let` — see SelectionToolbarPositionArgs.previousPlacement docstring.
// This is read+written from a Tiptap event listener, NOT from inside a
// Svelte $effect, so it does not need to be reactive and must not be
// $state (would risk effect_update_depth on every selection change).
let lastPlacement: SelectionToolbarPlacement | undefined;

let pendingAffordanceFrame = 0;
// Bounded retry counter: prevents a 60Hz infinite-rAF loop if `coordsAtPos`
// keeps throwing (e.g. editor mounted in a detached / display:none subtree).
// Reset on every non-throwing path; capped at MAX_AFFORDANCE_RETRIES.
let affordanceRetryCount = 0;
const MAX_AFFORDANCE_RETRIES = 3;

function updateSelectionAffordance(ed: TiptapEditor) {
  const { from, to } = ed.state.selection;
  const next = from !== to;
  hasSelection = next;
  if (!next) {
    selectionPosition = null;
    lastPlacement = undefined;
    affordanceRetryCount = 0;
    clearDwell();
    return;
  }

  // A28 dwell: (re)arm the appearance timer when the selection endpoints change,
  // but only while not yet satisfied — so a drag-extend AFTER the popup is shown
  // keeps it shown (and just repositions) instead of hiding it. Pinned before the
  // `try` so it's decoupled from the coordsAtPos throw/retry path and the
  // dedup early-return below. Once it fires, `beginEntrance()` + `dwellSatisfied`
  // are set in one batched write (so `entering` wins the mount RO race).
  if (!dwellSatisfied && (from !== lastDwellFrom || to !== lastDwellTo)) {
    lastDwellFrom = from;
    lastDwellTo = to;
    clearTimeout(dwellTimer);
    dwellTimer = setTimeout(() => {
      beginEntrance();
      dwellSatisfied = true;
    }, DWELL_MS);
  }

  try {
    const start = ed.view.coordsAtPos(from);
    const end = ed.view.coordsAtPos(to);
    const nextPosition = computeSelectionToolbarPosition({
      start,
      end,
      // A26 morph (#798): decide placement with a CONSTANT height-reserve, not
      // the live (animating) `toolbarHeight`. Keeps above/below stable across
      // the morph and lets the height-independent edge-anchor grow the popup
      // without any reposition — so the ResizeObserver recompute below is a
      // no-op during the morph and no freeze flag is needed.
      toolbarHeight: SELECTION_POPUP_HEIGHT_RESERVE,
      toolbarWidth,
      viewportHeight,
      viewportWidth,
      previousPlacement: lastPlacement,
    });
    lastPlacement = nextPosition.placement;
    affordanceRetryCount = 0;
    if (
      selectionPosition &&
      selectionPosition.left === nextPosition.left &&
      selectionPosition.top === nextPosition.top &&
      selectionPosition.bottom === nextPosition.bottom &&
      selectionPosition.placement === nextPosition.placement
    ) {
      return;
    }
    selectionPosition = {
      left: nextPosition.left,
      top: nextPosition.top,
      bottom: nextPosition.bottom,
      placement: nextPosition.placement,
    };
  } catch {
    // `coordsAtPos` throws when the PM view hasn't finished its measurement
    // pass yet — common on a slow CI runner where the selectionUpdate event
    // fires before the view's update cycle completes. The previous behavior
    // ("set selectionPosition = null") permanently hid the popup until
    // *another* selectionUpdate event arrived, which never happens for a
    // one-shot `selectText()` in an E2E. Retry on the next paint, bounded by
    // MAX_AFFORDANCE_RETRIES so a persistently-unmeasured view (hidden /
    // detached editor) can't pin the main thread.
    if (affordanceRetryCount >= MAX_AFFORDANCE_RETRIES) {
      affordanceRetryCount = 0;
      selectionPosition = null;
      lastPlacement = undefined;
      return;
    }
    affordanceRetryCount += 1;
    cancelAnimationFrame(pendingAffordanceFrame);
    pendingAffordanceFrame = requestAnimationFrame(() => {
      if (!ed.isDestroyed) updateSelectionAffordance(ed);
    });
  }
}

$effect(() => {
  if (!editor) return;
  const ed = editor;

  function onSelectionUpdate() {
    updateSelectionAffordance(ed);
  }

  const cleanup = attachSelectionToolbarListener(ed, onSelectionUpdate);
  onSelectionUpdate();
  return () => {
    // Cancel before delegating so a pending retry can't fire against a
    // torn-down editor.
    cancelAnimationFrame(pendingAffordanceFrame);
    pendingAffordanceFrame = 0;
    // A28: cancel pending dwell/entrance timers so they can't write $state into
    // an unmounted component (or clear `entering` into a later popup's entrance).
    clearTimeout(dwellTimer);
    clearTimeout(enteringTimer);
    cleanup();
  };
});

$effect(() => {
  if (!editor || !selectionPosition) return;
  const ed = editor;
  let frame = 0;

  function scheduleUpdate() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      viewportHeight = window.innerHeight;
      viewportWidth = window.innerWidth;
      updateSelectionAffordance(ed);
    });
  }

  window.addEventListener("resize", scheduleUpdate);
  // Grace period: PM auto-scrolls the selection into view after a programmatic
  // selection change. That scroll bubbles to document-level with capture=true
  // and would fire dismissPopup() before the user has a chance to interact
  // with the freshly-mounted popup. Ignore scroll events for one paint after
  // mount — by then any programmatic scroll has settled and only user-initiated
  // scrolls remain. (Also closes a CI flake where this race was deterministic.)
  let scrollDismissArmed = false;
  requestAnimationFrame(() => {
    scrollDismissArmed = true;
  });
  const unsubscribeOutsideScroll = onOutsideEvent(
    () => toolbarEl,
    ["scroll"],
    () => {
      if (!scrollDismissArmed) return;
      // Don't dismiss while the user is composing in the textarea
      if (document.activeElement === textareaEl) return;
      dismissPopup();
    },
  );
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", scheduleUpdate);
    unsubscribeOutsideScroll();
  };
});

$effect(() => {
  const ed = editor;
  const el = toolbarEl;
  if (!ed || !el || !selectionPosition) return;
  // A28: read `entering` so this effect re-runs when the entrance settles
  // (true→false). That re-run re-invokes the synchronous measure below, replacing
  // the width held during the unroll with the real measured width — the
  // guaranteed settle the ResizeObserver alone can't promise (its final fire can
  // race the entering-clear timer).
  const frozen = entering;

  const updateToolbarMetrics = () => {
    // Skip position jitter while textarea is focused
    if (document.activeElement === textareaEl) return;
    // While the popup's width is unrolling (entrance), the ResizeObserver fires
    // every frame; writing the mid-animation width into `toolbarWidth` would
    // jitter the left-clamp as the popup grows. Hold the pre-entrance width until
    // the entrance settles (the centered translateX(-50%) keeps the popup
    // visually centered meanwhile).
    if (entering) return;
    const rect = el.getBoundingClientRect();
    // Only width feeds positioning now (left-edge clamp). Height is decoupled
    // from placement (A26 morph uses SELECTION_POPUP_HEIGHT_RESERVE), so the
    // animating morph height never perturbs the popup's anchor.
    toolbarWidth = rect.width;
    updateSelectionAffordance(ed);
  };

  // Skip the initial synchronous measure while frozen (it would no-op anyway);
  // the post-settle re-run does the real measure.
  if (!frozen) updateToolbarMetrics();
  const observer = new ResizeObserver(updateToolbarMetrics);
  observer.observe(el);
  return () => observer.disconnect();
});

$effect(() => {
  if (showPopup && !capturedRange) captureSelectionRange();
  if (!showPopup) {
    capturedRange = null;
    // Only clear draft text if user isn't actively typing (prevents resize-glitch data loss)
    if (document.activeElement !== textareaEl) annotationText = "";
  }
});

// Counter-trigger from App.svelte's Ctrl+Alt+M handler. Captures the current
// editor selection and focuses the textarea once Svelte commits the popup DOM.
// Plain `let`, not `$state` — only `requestCommentFocus` is reactive. Tracking
// the cursor in $state would create a self-triggering effect loop (the $effect
// writes to the cursor inside its own reactive scope on every fire).
let lastSeenCommentTrigger = 0;
$effect(() => {
  if (requestCommentFocus === lastSeenCommentTrigger) return;
  lastSeenCommentTrigger = requestCommentFocus;
  if (requestCommentFocus === 0 || !editor) return;
  const { from, to } = editor.state.selection;
  if (from === to) return; // No selection → no-op
  untrack(() => captureSelectionRange());
  annotateMode = true;
  // A28: explicit "give me a comment box now" intent bypasses the dwell — show
  // the popup immediately. `selectionPosition` is already non-null here (the live
  // selection ran updateSelectionAffordance), so flipping `dwellSatisfied`
  // mounts the popup at once; `beginEntrance()` arms the width-freeze in the same
  // batched write so it wins the mount ResizeObserver race. Bare writes — no
  // `untrack` needed (untrack guards reads, not writes).
  dwellSatisfied = true;
  beginEntrance();
  requestAnimationFrame(() => textareaEl?.focus());
});

// Selection-popup focus policy (#653): do NOT auto-focus the textarea on popup
// mount. Auto-focus stole focus from the editor, which (a) cleared the browser's
// native ::selection visual and (b) made it impossible for the user to extend the
// selection by mouse drag (the editor was no longer the focus owner). Users now
// click the textarea explicitly to type — the popup itself stays out of the way.
//
// Selection visibility while focus is elsewhere is handled by
// SelectionDecorationExtension (#652).
//
// requestCommentFocus (Ctrl+Alt+M shortcut, lines 175–183) still focuses the
// textarea — that's an explicit "give me a comment input now" intent, not a
// passive selection.

// Re-capture the selection range whenever it changes while the popup is open,
// so a user who drag-extends past the initial selection ends up annotating the
// extended range. Skip when the textarea has focus — the editor's selection
// won't be moving in that case (the textarea owns the cursor), and re-capturing
// would race the submit handlers.
$effect(() => {
  if (!editor || !showPopup) return;
  const ed = editor;
  const onSelChange = () => {
    if (document.activeElement === textareaEl) return;
    captureSelectionRange();
  };
  ed.on("selectionUpdate", onSelChange);
  return () => {
    if (!ed.isDestroyed) ed.off("selectionUpdate", onSelChange);
  };
});

$effect(() => {
  if (!showPopup) return;

  // Capture phase + stopPropagation so this preempts the global bubble-phase
  // Escape-to-deselect handler (App.svelte) — same-target window listeners fire
  // in registration order, and App's is registered first, so a bubble listener
  // here would let Escape both close the popup AND clear the active annotation.
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    dismissPopup();
  }

  window.addEventListener("keydown", handleKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
});

// Returns the new annotation id (so the A27 fly-to-margin can launch the card
// from the popover footprint), or `undefined` if any creation guard trips.
function createAnnotation(
  type: AnnotationType,
  content: string,
  extras?: { color?: HighlightColor },
): string | undefined {
  if (!editor || !ydoc) return undefined;
  // Structural empty-content guard (defense-in-depth): the textarea handlers
  // already guard, but keep the invariant at the write seam so no future caller
  // can persist a zero-content note/comment. Highlights carry no text.
  if (type !== "highlight" && !content.trim()) return undefined;

  const range = capturedRange ?? editor.state.selection;
  const { from, to } = range;
  if (from === to) return undefined;

  const flatFrom = pmPosToFlatOffset(editor.state.doc, toPmPos(from));
  const flatTo = pmPosToFlatOffset(editor.state.doc, toPmPos(to));

  const id = generateAnnotationId();
  // highlights and notes are user-private; comments are Claude-visible
  const audience = type === "highlight" || type === "note" ? "private" : "outbound";
  const annotation = {
    id,
    author: "user" as const,
    type,
    audience,
    range: { from: flatFrom, to: flatTo },
    content,
    status: "pending" as const,
    timestamp: Date.now(),
    ...(extras?.color ? { color: extras.color } : {}),
  } as Annotation;

  // ADR-031: browser-initiated user edit — must be origin-tagged.
  withBrowser(ydoc, () => ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, annotation));
  capturedRange = null;
  return id;
}

function captureSelectionRange() {
  if (!editor) return;
  const { from, to } = editor.state.selection;
  capturedRange = { from, to };
}

function handleHighlight(color: HighlightColor) {
  if (!editor || !ydoc) return;

  const range = capturedRange ?? editor.state.selection;
  const { from, to } = range;
  if (from === to) return;

  const flatFrom = pmPosToFlatOffset(editor.state.doc, toPmPos(from));
  const flatTo = pmPosToFlatOffset(editor.state.doc, toPmPos(to));

  toggleHighlight(ydoc, { from: flatFrom, to: flatTo }, color);
  capturedRange = null;

  // #768 Bug 1: collapse the ProseMirror selection to its end so the newly
  // applied highlight color is immediately visible. Without this, the blue
  // selection rectangle paints on top of the highlight span and the user
  // gets no feedback that the highlight was applied until they click away.
  //
  // We must collapse the *PM* selection — not just clear the native DOM
  // selection. The swatch handler calls `editor.chain().focus().run()` right
  // after this, and Tiptap's `.focus()` → `view.focus()` → `selectionToDOM()`
  // restores the PM selection (still spanning from..to, since the highlight
  // was written to the Y.Map, not a PM transaction) back into the DOM. A bare
  // `window.getSelection().removeAllRanges()` would be undone immediately.
  // Collapsing the PM selection leaves `view.focus()` nothing to restore.
  editor.chain().setTextSelection(to).run();
}

// A8 "none"/eraser swatch — clear any user highlight on the selection, any
// color. Mirrors handleHighlight's coordinate handling exactly: capturedRange
// holds *PM* positions, but stored highlights use *flat* offsets, so we must
// convert via pmPosToFlatOffset before matching (a raw capturedRange would
// silently no-op). Same collapse-after so the cleared range is visible.
function handleClearHighlight() {
  if (!editor || !ydoc) return;

  const range = capturedRange ?? editor.state.selection;
  const { from, to } = range;
  if (from === to) return;

  const flatFrom = pmPosToFlatOffset(editor.state.doc, toPmPos(from));
  const flatTo = pmPosToFlatOffset(editor.state.doc, toPmPos(to));

  clearHighlight(ydoc, { from: flatFrom, to: flatTo });
  capturedRange = null;
  editor.chain().setTextSelection(to).run();
}

// Keyboard activation (Enter / Space on a focused button) fires `click` with
// `detail === 0`. The mouse path uses `mousedown` so the editor selection
// survives. Pair `onmousedown` (mouse, preventDefault) with
// `onclick={onKeyActivate(...)}` (keyboard, filtered) so both routes fire
// without double-firing. Used by the highlight swatches.
function onKeyActivate(handler: (e: MouseEvent) => void) {
  return (e: MouseEvent) => {
    if (e.detail === 0) handler(e);
  };
}

function dismissPopup() {
  hasSelection = false;
  selectionPosition = null;
  capturedRange = null;
  annotationText = "";
  annotateMode = false;
  clearDwell();
  editor?.chain().focus().run();
}

function openAnnotateMode() {
  annotateMode = true;
  requestAnimationFrame(() => textareaEl?.focus());
}

function submitAsComment() {
  if (!annotationTextTrimmed) return;
  // A27: capture the popover footprint BEFORE create (it's still mounted), then
  // register the fly-source AFTER a successful create — dismissPopup() unmounts
  // the popover, so the rect must be read first.
  const rect = toolbarEl?.getBoundingClientRect();
  const id = createAnnotation("comment", annotationTextTrimmed);
  if (id && rect) registerFlySource(id, rect);
  dismissPopup();
}

function submitAsNote() {
  if (!annotationTextTrimmed) return;
  const rect = toolbarEl?.getBoundingClientRect();
  const id = createAnnotation("note", annotationTextTrimmed);
  if (id && rect) registerFlySource(id, rect);
  dismissPopup();
}

function handleTextareaKeyDown(e: KeyboardEvent) {
  // Keybindings (Conflict #5, overridden by Bryan 2026-05-26): plain Enter =
  // newline (no submit — let the textarea insert it), Alt+Enter = Note to self
  // (private), Ctrl/Cmd+Enter = Send to Claude (outbound). Test the modifier
  // branches first so a note-intent keystroke can never fall through to a
  // comment submit. Plain/Shift+Enter hit no branch → default newline.
  if (e.key === "Enter" && e.altKey) {
    e.preventDefault();
    submitAsNote();
  } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submitAsComment();
  } else if (e.key === "Escape") {
    e.preventDefault();
    dismissPopup();
  }
}
</script>

{#if showPopup && selectionPosition}
  <!-- Selection popup uses the shared .tandem-floating-pill recipe so its
       shadow + warm/white/dark variants match the formatting bar and
       titlebar pills. 1.11: always the full stacked surface — a format pill
       (FormattingToolbar variant="popup" + the mirrored Decorations control,
       plus a "show formatting bar" button when the bar is hidden) over an
       annotate pill (highlight swatches + Annotate). The format pill mirrors the
       formatting bar so every control stays reachable when the bar is hidden.
       -webkit-app-region: no-drag — it's fixed chrome over the Tauri WebView. -->
  <div
    bind:this={toolbarEl}
    role="toolbar"
    aria-label="Selection tools"
    class="tandem-floating-pill selection-popup"
    class:is-annotate={annotateMode}
    style={popupPositionStyle}
    in:popupEnter={{ reduceMotion }}
  >
    <!-- A26 morph (#798): BOTH blocks are always mounted; the inactive one is
         collapsed via `grid-template-rows: 0fr` (see scoped styles below) and `inert`
         (so its clipped controls are neither focusable nor AT-readable, and a
         clipped textarea can't capture focus and preserve a stale draft — the
         L257 clear-guard stays valid). Clicking Annotate unfurls the annotate
         block while the format block collapses, in place. -->
    <div class="morph-block morph-format" class:is-active={!annotateMode} inert={annotateMode}>
      <div class="morph-block-inner">
      <!-- Format pill: full mark/block control set (no Undo/Redo — those stay
           on the bar + Ctrl+Z/Y) + the mirrored Decorations control. Every
           FormattingToolbar button already binds onMouseDown+withPreventDefault
           so clicking one cannot blur the editor / collapse the selection. -->
      <div style="display: flex; align-items: center; gap: 1px; padding: 4px 4px 2px;">
        <FormattingToolbar {editor} variant="popup" />
        {#if onUpdateDecorations}
          <div style="width: 1px; height: 18px; background: var(--tandem-border); margin: 0 3px; flex-shrink: 0;"></div>
          <!-- preventDefault on mousedown keeps the editor selection alive while
               interacting with the (onclick-based) Decorations control, so a
               toggle can't dismiss the popup before a follow-up Annotate.
               click still fires — preventDefault on mousedown only blocks the
               focus shift, not the click. -->
          <div
            style="display: inline-flex; align-items: center;"
            onmousedown={(e) => e.preventDefault()}
            role="presentation"
          >
            <DecorationsMenu
              {showAuthorship}
              {showComments}
              {showHighlights}
              {showNotes}
              {decorationsMuted}
              onUpdate={onUpdateDecorations}
              {onOpenSettings}
            />
          </div>
        {/if}
        {#if onToggleFormattingBar}
          <!-- A8 swap: persistent hide/show-bar toggle at the far right of the
               format row. Chevron-up = hide (bar shown), chevron-down = show
               (bar hidden) — mirrors the bar's own hide button, opposite
               direction. Always present (unlike the old show-only affordance),
               so the bar is both hideable and reachable from the popup. testid
               kept for the E2E contract though it now toggles both ways.
               onmousedown preventDefault keeps the editor selection alive so
               toggling doesn't dismiss the popup mid-interaction; onclick
               (filtered to keyboard activation) covers Enter/Space. -->
          <div style="width: 1px; height: 18px; background: var(--tandem-border); margin: 0 3px; flex-shrink: 0;"></div>
          <button
            type="button"
            data-testid="popup-show-formatbar-btn"
            aria-label={formattingBarVisible ? "Hide formatting bar" : "Show formatting bar"}
            title={formattingBarVisible ? "Hide formatting bar" : "Show formatting bar"}
            onmousedown={(e) => {
              e.preventDefault();
              onToggleFormattingBar?.();
            }}
            onclick={onKeyActivate(() => onToggleFormattingBar?.())}
            style="height: 26px; min-width: 26px; padding: 0 6px; border: 1px solid transparent; background: transparent; color: var(--tandem-fg-muted); border-radius: var(--tandem-r-pill); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0;"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d={formattingBarVisible ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
            </svg>
          </button>
        {/if}
      </div>
      <div style="height: 1px; background: var(--tandem-border); margin: 0 6px;"></div>
      <!-- Annotate pill: highlight swatches + Annotate. -->
      <div style="display: flex; align-items: center; gap: 1px; padding: 2px 4px 4px;">
        <div style="display: inline-flex; gap: 3px; padding: 0 4px;" aria-label="Highlight colors">
          <!-- A8: the strip leads with a "none" swatch so clearing a highlight
               is one click (any color), not a same-color re-click. preventDefault
               keeps the selection alive; clearHighlight resolves PM→flat inside
               handleClearHighlight (capturedRange holds PM positions). -->
          <button
            type="button"
            data-testid="popup-highlight-none"
            aria-label="No highlight"
            title="No highlight"
            onmousedown={(e) => {
              e.preventDefault();
              handleClearHighlight();
              editor?.chain().focus().run();
            }}
            onclick={onKeyActivate(() => {
              handleClearHighlight();
              editor?.chain().focus().run();
            })}
            style="width: 16px; height: 16px; border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-border); background: var(--tandem-surface); cursor: pointer; padding: 0; display: inline-flex; align-items: center; justify-content: center;"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <line x1="3.5" y1="12.5" x2="12.5" y2="3.5" stroke="var(--tandem-fg-muted)" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
          {#each MINI_HIGHLIGHT_COLORS as color}
            <button
              type="button"
              data-testid={`popup-highlight-${color}`}
              aria-label={`Highlight ${color}`}
              title={`Highlight ${color}`}
              onmousedown={(e) => {
                e.preventDefault();
                handleHighlight(color);
                editor?.chain().focus().run();
              }}
              onclick={onKeyActivate(() => {
                handleHighlight(color);
                editor?.chain().focus().run();
              })}
              style={`width: 16px; height: 16px; border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-border); background: ${HIGHLIGHT_COLOR_VARS[color]}; cursor: pointer; padding: 0;`}
            ></button>
          {/each}
        </div>
        <div style="width: 1px; height: 18px; background: var(--tandem-border); margin: 0 3px;"></div>
        <button
          type="button"
          data-testid="popup-annotate-btn"
          aria-label="Annotate"
          onmousedown={(e) => {
            e.preventDefault();
            openAnnotateMode();
          }}
          onclick={onKeyActivate(() => openAnnotateMode())}
          style="height: 24px; padding: 0 12px; border: 1px solid var(--tandem-author-user); background: transparent; color: var(--tandem-author-user); border-radius: var(--tandem-r-pill); font-size: 12px; font-weight: 600; cursor: pointer;"
        >Annotate</button>
      </div>
      </div>
    </div>
    <div class="morph-block" class:is-active={annotateMode} inert={!annotateMode}>
      <div class="morph-block-inner">
      <!-- Annotate popover. Keybindings: Alt+Enter = Note to self (private),
           Ctrl/Cmd+Enter = Send to Claude (outbound), plain Enter = newline. -->
      <div style="display: flex; flex-direction: column; gap: 6px; padding: 6px 8px; min-width: 260px; max-width: 360px;">
        <textarea
          bind:this={textareaEl}
          data-testid="popup-annotation-input"
          aria-label="Annotation text"
          bind:value={annotationText}
          onkeydown={handleTextareaKeyDown}
          placeholder="Write a note or instruction..."
          rows={1}
          style="width: 100%; box-sizing: border-box; field-sizing: content; min-height: 28px; max-height: 120px; overflow-y: auto; resize: none; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); font-size: 12px; padding: 4px 6px; outline: none; font-family: inherit;"
        ></textarea>
        <div style="display: flex; justify-content: space-between; gap: 6px;">
          <button
            type="button"
            data-testid="popup-note-submit"
            aria-label="Note to self (Alt+Enter)"
            title="Note to self — private, not sent to {agentLabel.family} (Alt+Enter)"
            disabled={!annotationTextTrimmed}
            onclick={submitAsNote}
            style="flex: 1; height: 28px; padding: 0 10px; border: 1px solid var(--tandem-border); background: transparent; color: var(--tandem-fg-muted); border-radius: var(--tandem-r-2); font-size: 12px; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px;"
          >
            Note to self
            <kbd style="font-family: var(--tandem-font-mono); font-size: 10px; color: var(--tandem-fg-subtle);">⌥⏎</kbd>
          </button>
          <button
            type="button"
            data-testid="popup-comment-submit"
            aria-label="Send to {agentLabel.family} (Ctrl+Enter)"
            title="Send to {agentLabel.family} — outbound comment (Ctrl/Cmd+Enter)"
            disabled={!annotationTextTrimmed}
            onclick={submitAsComment}
            style="flex: 1; height: 28px; padding: 0 10px; border: 1px solid var(--tandem-author-user); background: transparent; color: var(--tandem-author-user); border-radius: var(--tandem-r-2); font-size: 12px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px;"
          >
            Send to {agentLabel.family}
            <kbd style="font-family: var(--tandem-font-mono); font-size: 10px; color: var(--tandem-author-user);">⌘⏎</kbd>
          </button>
        </div>
      </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* A26 morph (#798): the selection popup morphs in place between its format
     state and its annotate (note-popover) state. Structural/animation CSS lives
     here (class-toggled on persistent DOM identity); per the family decision
     (option B) width is NOT morphed — it's constant at the natural format width,
     so only border-radius (P1) and the block unfurl (P2) animate. The width
     unroll belongs to M2's fresh-mount entrance. Timing tokens + the dual
     reduced-motion guard come from morphTiming.css (imported above). */
  .selection-popup {
    position: fixed;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    z-index: var(--tandem-z-modal);
    /* Fixed chrome over the Tauri WebView — never part of the drag region. */
    -webkit-app-region: no-drag;
    border-radius: var(--tandem-r-3);
    /* P1. Only fires on the is-annotate class toggle, never on mount (a CSS
       transition never animates an element's initial computed value). */
    transition: border-radius var(--morph-p1) var(--tandem-ease-out);
  }
  .selection-popup.is-annotate {
    border-radius: var(--tandem-r-4);
  }

  /* P2. Each block animates its grid row 0fr→1fr — to the NATURAL content
     height, with a correct ease-out settle, tracking the textarea's
     field-sizing growth for free (no max-height cap, no measurement, no
     clip-on-type). `overflow: clip` (not `hidden`) so the inactive block never
     becomes a scroll container — focusing the textarea via rAF while it unfurls
     must not trigger focus-autoscroll (lesson #765). clip does not cut the
     shell's shadow (only clip-path would). Degrades to an instant swap on any
     WebView that doesn't interpolate grid-template-rows. */
  .morph-block {
    display: grid;
    grid-template-rows: 0fr;
    overflow: clip;
    transition: grid-template-rows var(--morph-p2) var(--tandem-ease-out);
  }
  .morph-block.is-active {
    grid-template-rows: 1fr;
  }
  .morph-block-inner {
    min-height: 0;
    overflow: clip;
  }
  /* The format block hosts absolutely-positioned dropdowns (the heading + list
     menus in FormattingToolbar, the Decorations menu) that open BELOW their
     button, beyond the block's box. While the format block is shown
     (is-active = format state) it must NOT clip them, or the menu items are cut
     off and the editor underneath intercepts their clicks. Safe to drop the clip
     only here because `annotateMode → false` always co-occurs with popup
     dismiss/unmount — there is no annotate→format *expand* transition — so the
     format block is never mid-animation while its overflow is visible. The
     annotate block keeps `clip` (clean unfurl; it hosts no escaping dropdowns). */
  .morph-format.is-active,
  .morph-format.is-active > .morph-block-inner {
    overflow: visible;
  }
</style>
