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
import type {
  Annotation,
  AnnotationType,
  HighlightColor,
  TandemMode,
  TandemNotification,
} from "../../../shared/types";
import { generateAnnotationId } from "../../../shared/utils";
import { isMacPlatform } from "../../actions/keybindings";
import { createAgentLabel } from "../../hooks/useAgentLabel.svelte";
import { heldInSoloOnCreate } from "../../panels/annotation-actions";
import { ENTER_POPUP_MS, motionOff, popupEnter, registerFlySource } from "../../panels/cardMotion";
import { pmPosToFlatOffset } from "../../positions";
import DecorationsMenu from "../../shell/DecorationsMenu.svelte";
import { onOutsideEvent } from "../../utils/dismiss-outside";
import { escapeIsClaimed } from "../../utils/escape-owner";
import {
  type AnnotationComposerIntent,
  defaultAnnotationIntent,
  resolveAnnotationSubmission,
} from "./annotation-composer-intent";
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
  /** Desktop native-menu request; carries only a local intent kind + nonce. */
  requestAnnotationFocus?: { nonce: number; kind: "comment" | "note" } | null;
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
  /**
   * WS-A2: current Solo/Tandem mode, threaded from App's `modeState`. When
   * "solo", a user-created comment is stamped `heldInSolo: true` so the held
   * badge + fail-closed-restart hold have a persisted signal. Hiding itself is
   * server-authoritative (mode-based) — this marker is the UI/restart substrate,
   * not the hide gate.
   */
  tandemMode?: TandemMode;
  /** Refused-link channel for the popup's format pill — see FormattingToolbar. */
  onNotify?: (n: TandemNotification) => void;
}

let {
  editor,
  ydoc,
  selectionToolbar = true,
  suppressSelectionToolbar = false,
  requestCommentFocus = 0,
  requestAnnotationFocus = null,
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
  tandemMode = "tandem",
  onNotify,
}: Props = $props();

const agentLabel = createAgentLabel();

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
let annotationIntent = $state<AnnotationComposerIntent>(null);
let forcedComposer = $state(false);

// A28 dwell + entrance (#798).
// `dwellSatisfied` gates `showPopup`: the popup appears only after the selection
// has been held steady for DWELL_MS (a NEW client-side intent gate — NOT
// `selectionDwellMs`, which gates the server channel selection event). `entering`
// freezes the width-feedback positioning (see updateToolbarMetrics) for the
// duration of the entrance so the left-clamp can't jitter as the popup's width
// unrolls. Both are plain timers; `beginEntrance()` sets `entering` in the SAME
// synchronous write that flips `dwellSatisfied`/the requestCommentFocus bypass,
// so it is already true when the mount-triggered ResizeObserver effect runs.
const DWELL_MS = 100;
let dwellSatisfied = $state(false);
let entering = $state(false);
let dwellTimer: ReturnType<typeof setTimeout> | undefined;
let enteringTimer: ReturnType<typeof setTimeout> | undefined;
// Selection endpoints the dwell timer is currently armed for. Plain `let` (read
// from a Tiptap listener, not a reactive scope).
let lastDwellFrom = -1;
let lastDwellTo = -1;

// Cursor-origin unroll (#798, Bryan 2026-06-03). The popup unrolls away from the
// user's cursor at popup time. We LATCH the horizontal origin when the entrance
// begins (dwell fires) so it stays put as the popup grows / the selection extends:
//   • pointer selection → the pointerup X (mouse is at the selection end after a
//     drag); `pointerUpSinceDwellArm` is set by the pointerup that ARMS the dwell,
//     so it can only ever be a finished pointer gesture, never a stale click.
//   • keyboard selection → the caret (selection head) X, captured each successful
//     coordsAtPos pass below.
// All in viewport/client coords (same space as coordsAtPos + clientX). `null`
// before the latch — the popup is hidden then, so its `left` doesn't matter.
let pointerUpSinceDwellArm = false;
let pointerAnchorX = 0;
let pointerAnchorY = 0;
let caretAnchorX = 0;
let caretAnchorY = 0;
let latchedAnchorX: number | null = null;
let latchedAnchorY: number | null = null;
// "Wait until the selection gesture finishes" (Bryan 2026-06-03). True between
// pointerdown and pointerup of a pointer selection. While set, the dwell does NOT
// arm — the popup must wait for the user to release the mouse, not merely pause
// mid-drag — so the pointerup handler is what arms it for the completed selection.
// Keyboard selections never set this, so they still arm on dwell-settle below.
let pointerSelecting = false;

function beginEntrance() {
  // Latch the cursor origin (X+Y) for the whole entrance (and until the next
  // selection) so the popup appears where the cursor was when the animation began.
  latchedAnchorX = pointerUpSinceDwellArm ? pointerAnchorX : caretAnchorX;
  latchedAnchorY = pointerUpSinceDwellArm ? pointerAnchorY : caretAnchorY;
  // Reduced motion: `popupEnter` already returns a zero-duration transition, so
  // there's no width-unroll to protect. Skip the freeze entirely — arming it
  // would leave the metrics effect on a stale `toolbarWidth` for ENTER_POPUP_MS
  // (a delayed left-clamp snap near the viewport edge) with no animation to hide.
  if (motionOff(reduceMotion)) return;
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
  latchedAnchorX = null;
  latchedAnchorY = null;
  pointerUpSinceDwellArm = false;
}

// Arm the A28 appearance dwell. DWELL_MS later (with no re-arm in between) the
// popup unrolls. `byPointer` records the cursor-origin source so beginEntrance
// latches the right X (pointerup X vs caret X). The single arming path for both
// the keyboard route (selectionUpdate settle) and the pointer route (pointerup).
function armDwell(from: number, to: number, byPointer: boolean) {
  lastDwellFrom = from;
  lastDwellTo = to;
  pointerUpSinceDwellArm = byPointer;
  clearTimeout(dwellTimer);
  dwellTimer = setTimeout(() => {
    beginEntrance();
    dwellSatisfied = true;
  }, DWELL_MS);
}

// Platform-correct modifier glyph for the commit button's hint. Not a
// remappable shortcut id: Mac uses the symbol glyphs, Windows/Linux the
// spelled-out modifier + the ⏎ key.
//
// Only ONE glyph now, where there used to be two. Ctrl/Cmd+Enter commits to
// whatever the audience toggle is set to (`resolveAnnotationSubmission` reads
// `annotationIntent`), so a single unconditional chip on the commit button is
// accurate in both audiences — it no longer has to change with the intent.
//
// Alt+Enter still forces a note regardless of the toggle, and its rendered
// chip is deliberately gone: it used to be the ONLY affordance for the private
// path, and the toggle is now a one-click replacement for it. It survives as a
// power-user bypass named in the Self segment's tooltip, not as a second chip
// competing for room in a footer that has to hold the toggle as well.
const isMac = isMacPlatform();
const sendHintKbd = isMac ? "⌘⏎" : "Ctrl+⏎";

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
  (selectionToolbar || forcedComposer) &&
    !suppressSelectionToolbar &&
    canAnnotate &&
    selectionPosition !== null &&
    dwellSatisfied,
);
const annotationTextTrimmed = $derived(annotationText.trim());
const primaryAnnotationIntent = $derived(defaultAnnotationIntent(annotationIntent));

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
    // Reset to format-first for the NEXT selection. annotateMode otherwise only
    // resets in dismissPopup (Escape / submit), so after clicking Annotate a
    // brand-new selection stayed stuck in the composer instead of showing the
    // format/annotate popup (pre-existing; also on master). The editor selection
    // collapses (this `!next` path) before every new click/drag selection, but
    // an in-place drag-EXTEND never collapses — so it's preserved. Guard on
    // textarea focus so we never pull the user out of a composer they're typing
    // in (draft text is intentionally left intact for click-away recovery).
    if (document.activeElement !== textareaEl) annotateMode = false;
    return;
  }

  // A28 dwell — KEYBOARD path. Arm the appearance timer when the selection
  // endpoints settle, but ONLY when the user isn't mid pointer-drag: while
  // `pointerSelecting`, the popup must wait for the gesture to FINISH — the
  // pointerup handler arms it then — so a slow or paused drag never pops the
  // toolbar before the user lets go. Keyboard selections (shift+arrows) have no
  // release event, so the dwell-on-settle IS their "finished" signal. Guarded on
  // `!dwellSatisfied` so a drag-extend after the popup is shown just repositions
  // it (keeps it shown). Pinned before the `try` so it's decoupled from the
  // coordsAtPos throw/retry path and the dedup early-return below.
  if (!dwellSatisfied && !pointerSelecting && (from !== lastDwellFrom || to !== lastDwellTo)) {
    armDwell(from, to, false);
  }

  try {
    // Keyboard-selection origin: the caret (selection head) X and bottom. Captured
    // every pass so it's current when beginEntrance latches it (pointer selections
    // override this with the pointerup X/Y). `head` is the moving end of a
    // shift+arrow range. The coordsAtPos call also detects an un-measured view
    // (throws → retry below). `from`/`to` aren't needed for positioning anymore —
    // the popup is anchored at the cursor point, not the selection box.
    const headCoords = ed.view.coordsAtPos(ed.state.selection.head);
    caretAnchorX = headCoords.left;
    caretAnchorY = headCoords.bottom;
    const nextPosition = computeSelectionToolbarPosition({
      // Cursor-origin unroll (#798): anchor at the latched cursor point once the
      // entrance has begun; before that the popup is hidden, so the live caret
      // coords are a harmless placeholder.
      anchorX: latchedAnchorX ?? caretAnchorX,
      anchorY: latchedAnchorY ?? caretAnchorY,
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

  // "Wait until the selection gesture finishes" + cursor-origin unroll (#798,
  // Bryan 2026-06-03). A primary-button pointerdown in the editor opens a pointer
  // selection (`pointerSelecting`); while it's open, updateSelectionAffordance
  // skips arming the dwell, so the popup never appears mid-drag. pointerup ends the
  // gesture: it captures where the mouse came to rest (the X the popup unrolls away
  // from) and arms the dwell for the COMPLETED selection. The release/cancel
  // listeners live on the document so a drag that ends outside the editor still
  // finishes (and never leaves `pointerSelecting` stuck → keyboard popups gated).
  // Keyboard selections never touch any of this, so they arm via the caret path.
  const editorDom = ed.view.dom;
  const ownerDoc = editorDom.ownerDocument;
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || !e.isPrimary) return;
    pointerSelecting = true;
  }
  function onPointerUp(e: PointerEvent) {
    if (!pointerSelecting) return;
    pointerSelecting = false;
    pointerAnchorX = e.clientX;
    pointerAnchorY = e.clientY;
    const { from, to } = ed.state.selection;
    // Real selection → arm now (popup appears DWELL_MS after release). A collapsed
    // selection (plain click) already ran the !next/clearDwell path; don't arm.
    if (from !== to && !dwellSatisfied) armDwell(from, to, true);
  }
  function onPointerCancel() {
    pointerSelecting = false;
  }
  editorDom.addEventListener("pointerdown", onPointerDown);
  ownerDoc.addEventListener("pointerup", onPointerUp);
  ownerDoc.addEventListener("pointercancel", onPointerCancel);

  const cleanup = attachSelectionToolbarListener(ed, onSelectionUpdate);
  onSelectionUpdate();
  return () => {
    editorDom.removeEventListener("pointerdown", onPointerDown);
    ownerDoc.removeEventListener("pointerup", onPointerUp);
    ownerDoc.removeEventListener("pointercancel", onPointerCancel);
    // Cancel before delegating so a pending retry can't fire against a
    // torn-down editor.
    cancelAnimationFrame(pendingAffordanceFrame);
    pendingAffordanceFrame = 0;
    // A28: cancel pending dwell/entrance timers so they can't write $state into
    // an unmounted component (or clear `entering` into a later popup's entrance).
    //
    // The two bare `clearTimeout`s are NOT an oversight, and must not be
    // "tidied" into the `clearDwell()` that wraps them. `clearDwell()` also
    // resets `dwellSatisfied`, and this effect DEPENDS on `dwellSatisfied`:
    // the `onSelectionUpdate()` call below runs synchronously during the
    // effect, reaching the re-arm guard in `updateSelectionAffordance` that
    // reads it. So the dwell timer firing — whose whole job is
    // `dwellSatisfied = true` — invalidates this effect and re-runs it, and a
    // teardown that reset the flag would set it straight back to false. The
    // popup could then never appear at all: measured at 24 of 28 failures in
    // `toolbar-redesign.spec.ts`.
    //
    // What the asymmetry costs is small and, as far as anyone has managed to
    // reproduce, unreachable: the non-reactive `lastDwellFrom`/`lastDwellTo`
    // survive into the next editor, so a replacement that mounted with the
    // *same* non-collapsed range would fail that guard and never arm. Every
    // real path self-heals first — a new editor mounts collapsed, and the
    // `!next` branch of `updateSelectionAffordance` calls `clearDwell()` — which
    // is why a tab switch mid-popup behaves correctly.
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
    // jitter the left-anchor clamp (maxLeft depends on width) as the popup grows.
    // Hold the pre-entrance width until the entrance settles — the left edge stays
    // pinned at the cursor X meanwhile, so there's nothing to correct mid-unroll.
    if (entering) {
      // Exception: the FIRST popup of the session has `toolbarWidth === 0`, so the
      // right-edge clamp (`maxLeft` depends on width) is a no-op and a popup whose
      // cursor anchor is near the right edge unrolls off-screen, only snapping on
      // once the entrance settles (ENTER_POPUP_MS later). Seed the clamp once with the natural
      // content width — `scrollWidth` reports the un-clipped width even mid-entrance
      // (the transition animates a growing `width` under `overflow:clip`). Later
      // appearances retain the last measured width, so this runs at most once.
      if (toolbarWidth === 0) {
        toolbarWidth = el.scrollWidth;
        updateSelectionAffordance(ed);
      }
      return;
    }
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
function openRequestedComposer(kind: "comment" | "note"): void {
  if (!editor) return;
  const { from, to } = editor.state.selection;
  if (from === to || !editor.isEditable) return;
  captureSelectionRange();
  annotationIntent = kind;
  annotateMode = true;
  forcedComposer = true;
  dwellSatisfied = true;
  beginEntrance();
  requestAnimationFrame(() => textareaEl?.focus());
}

$effect(() => {
  if (requestCommentFocus === lastSeenCommentTrigger) return;
  lastSeenCommentTrigger = requestCommentFocus;
  if (requestCommentFocus === 0 || !editor) return;
  untrack(() => openRequestedComposer("comment"));
});

let lastAnnotationRequestNonce = 0;
$effect(() => {
  const request = requestAnnotationFocus;
  if (!request || request.nonce === lastAnnotationRequestNonce) return;
  lastAnnotationRequestNonce = request.nonce;
  untrack(() => openRequestedComposer(request.kind));
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
    // Yield to a nested popover that has claimed Escape (see escape-owner.ts).
    // This listener is capture-phase at `window`, so without this it preempts
    // the formatting bar's own dismissals: a keyboard user with the colour
    // picker open got the POPUP dismissed on the first Escape and had to press
    // it twice (#1302 review).
    if (escapeIsClaimed(e.target)) return;
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
  // WS-A2: mark a comment created in Solo as held (shared predicate — see
  // heldInSoloOnCreate). Only comments qualify; the server hides on live mode
  // regardless, this is the persisted signal for the badge + fail-closed restart.
  const heldInSolo = heldInSoloOnCreate(type, tandemMode);
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
    ...(heldInSolo ? { heldInSolo: true } : {}),
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
  annotationIntent = null;
  forcedComposer = false;
  clearDwell();
  editor?.chain().focus().run();
}

function openAnnotateMode() {
  // Ordinary toolbar entry uses the product default and must not inherit a
  // prior native-menu Private Note / Comment intent.
  annotationIntent = null;
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
  if (id) {
    if (rect) registerFlySource(id, rect);
    // #1018: a comment is outbound (Claude reads it). If no AI is connected, App
    // shows a "saved, will be seen when AI connects" notice. ONLY comments —
    // notes/highlights are user-private (ADR-027) and never sent to AI, so a
    // "no AI connected" notice on those would be misleading.
    //
    // Until #1385 this dispatch sat OUTSIDE the guard, so a create that
    // returned undefined still told the user their comment was saved and would
    // reach Claude. That broke a contract documented on the CONSUMER side —
    // App.svelte's #1018 block states both dispatchers fire "AFTER persisting"
    // — so the defect was invisible from either file alone.
    //
    // Gated on `id` alone, not `id && rect`: a missing rect costs the fly
    // animation, not the write, and must not suppress the notice.
    //
    // All three of `createAnnotation`'s undefined returns are unreachable from
    // here today: no-editor/no-ydoc is gated by `canAnnotate` upstream of
    // `showPopup`, empty content by this function's own early return, and a
    // collapsed range by the fact that the only two collapse sites live in the
    // format block, which is `inert` while the composer is open. The third is
    // the one that stops being true once anything can collapse mid-compose —
    // which the proposed in-card highlight swatches would (#1445).
    window.dispatchEvent(new CustomEvent("tandem:addressed-ai", { detail: { via: "comment" } }));
  }
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
  // Plain Enter inserts a newline. Alt+Enter is always private; the primary
  // Ctrl/Cmd+Enter path follows the native-menu intent and otherwise defaults
  // to an outbound comment.
  if (e.key === "Enter") {
    const submission = resolveAnnotationSubmission(annotationIntent, e);
    if (!submission) return;
    e.preventDefault();
    if (submission === "note") submitAsNote();
    else submitAsComment();
  } else if (e.key === "Escape") {
    e.preventDefault();
    dismissPopup();
  }
}
</script>

{#if showPopup && selectionPosition}
  <!-- Selection popup (A8 two-pill, #798). FORMAT state: the outer shell is
       chrome-less and hosts a column of TWO .tandem-floating-pill capsules — a
       format-controls capsule (FormattingToolbar variant="popup" + the mirrored
       Decorations control + a hide/show-bar swap) over an annotate capsule
       (highlight swatches + Annotate) — separated by a 5px gap the editor shows
       through. ANNOTATE state: the shell itself becomes the note-popover card
       (re-acquiring the .tandem-floating-pill chrome, P1-tweened) around the
       composer. The format capsules mirror the formatting bar so every control
       stays reachable when the bar is hidden; shadow + warm/white/dark variants
       match the bar + titlebar pills via the shared recipe.
       -webkit-app-region: no-drag — it's fixed chrome over the Tauri WebView. -->
  <div
    bind:this={toolbarEl}
    role="toolbar"
    aria-label="Selection tools"
    class="tandem-floating-pill selection-popup"
    class:is-annotate={annotateMode}
    class:is-below={selectionPosition.placement === "below"}
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
      <!-- A8 two-pill (#798): the format state is a transparent column of TWO
           independently-chromed .tandem-floating-pill capsules with a 5px gap the
           editor shows through (matching the bundle's .popup-card). The outer
           shell sheds its chrome in format state and re-acquires it as the note
           card in .is-annotate (P1 tween — see scoped styles). onmousedown
           preventDefault on the column keeps the editor selection alive across
           every non-button chrome region (the gap, capsule padding) so a stray
           click can't blur → collapse the selection → drop capturedRange. -->
      <div class="popup-format-col" onmousedown={(e) => e.preventDefault()} role="presentation">
        <!-- Capsule 1: full mark/block control set (no Undo/Redo — those stay on
             the bar + Ctrl+Z/Y) + the mirrored Decorations control + bar-swap. -->
        <div class="pill-row tandem-floating-pill" data-testid="popup-format-row">
          <FormattingToolbar {editor} variant="popup" {onNotify} />
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
        <!-- Capsule 2: highlight swatches + Annotate. -->
        <div class="pill-row tandem-floating-pill" data-testid="popup-annotate-row">
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
            style="height: 24px; padding: 0 12px; border: 1px solid var(--tandem-author-user); background: transparent; color: var(--tandem-author-user); border-radius: var(--tandem-r-pill); font-size: 12px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;"
          >
            <!-- A8: leading pencil icon on the Annotate affordance. -->
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
            Annotate
          </button>
        </div>
      </div>
      </div>
    </div>
    <div class="morph-block morph-annotate" class:is-active={annotateMode} inert={!annotateMode}>
      <div class="morph-block-inner">
      <!-- Annotate popover. Alt+Enter is always private; Ctrl/Cmd+Enter follows
           the requested menu intent (ordinary opens default to outbound). -->
      <div class="composer-card">
        <textarea
          bind:this={textareaEl}
          data-testid="popup-annotation-input"
          aria-label="Annotation text"
          bind:value={annotationText}
          onkeydown={handleTextareaKeyDown}
          placeholder={primaryAnnotationIntent === "note"
            ? "Write a private note..."
            : "Write an instruction for AI..."}
          rows={1}
          class="composer-input"
        ></textarea>
        <!-- Audience is a TOGGLE, not a choice made at submit time. The two
             segments write `annotationIntent`; one button commits to whatever
             is selected. No keyboard behaviour changes: resolveAnnotationSubmission
             already reads that same state for Ctrl/Cmd+Enter and already forces
             "note" for Alt+Enter regardless of it, so the private fast-path
             survives the toggle and is surfaced in the Self segment's title.

             TESTIDS DRIFT ON PURPOSE. `popup-note-submit` / `popup-comment-submit`
             now sit on segments that SELECT rather than submit. Critical Rule 7
             lets the set gain selectors but never lose one, and the project has
             taken this exact trade before — see `batch-promote-confirm` in
             docs/design-system-impl/conflicts-resolved.md, kept verbatim on a
             button whose meaning had moved. The committing control takes a new
             id rather than stealing either name. -->
        <div class="composer-actions">
          <div class="composer-audience" role="group" aria-label="Annotation audience">
            <!-- Placed BEFORE the segments and aria-hidden: it is the sliding
                 fill, not a control, and it must not sit in the tab order. -->
            <span
              class="audience-thumb"
              class:is-agent={primaryAnnotationIntent === "comment"}
              aria-hidden="true"
            ></span>
            <!-- Exactly ONE direct child <span> per segment, and the label is a
                 bare text node. tests/e2e/forced-colors.spec.ts locates each
                 destination marker as the segment's only direct child span and
                 asserts a count of 1 — wrapping the label in a span silently
                 breaks that spec's locator rather than its assertion.
                 (Written without a literal testid-attribute spelling on
                 purpose: testid-coverage.test.ts scans this file for that
                 spelling and reports a prose one as an unparseable value.) -->
            <button
              type="button"
              class="audience-seg"
              class:on={primaryAnnotationIntent === "note"}
              data-testid="popup-note-submit"
              aria-pressed={primaryAnnotationIntent === "note"}
              title={`Keep private — never sent to ${agentLabel.family}. Alt+Enter always submits privately, whatever this is set to.`}
              onclick={() => (annotationIntent = "note")}
            ><span class="composer-dest composer-dest-user" aria-hidden="true"></span>Self</button>
            <button
              type="button"
              class="audience-seg"
              class:on={primaryAnnotationIntent === "comment"}
              data-testid="popup-comment-submit"
              aria-pressed={primaryAnnotationIntent === "comment"}
              title={`Send to ${agentLabel.family} as an outbound comment`}
              onclick={() => (annotationIntent = "comment")}
            ><span class="composer-dest" aria-hidden="true"></span>{agentLabel.family}</button>
          </div>
          <!-- "Add" rather than "Send"/"Save": the toggle owns the destination,
               so naming it here would state it twice, and "Send" would be a lie
               in the private case. "Save" was rejected for colliding with
               document save. The key hint is unconditional now — Ctrl/Cmd+Enter
               commits in BOTH audiences, so unlike the old Send button there is
               no state where printing it would claim something untrue. -->
          <button
            type="button"
            class="composer-btn"
            data-testid="popup-annotation-submit"
            aria-label={primaryAnnotationIntent === "note"
              ? "Add private note (Ctrl+Enter)"
              : `Send to ${agentLabel.family} (Ctrl+Enter)`}
            disabled={!annotationTextTrimmed}
            onclick={primaryAnnotationIntent === "note" ? submitAsNote : submitAsComment}
          >
            Add
            <kbd class="composer-kbd">{sendHintKbd}</kbd>
          </button>
        </div>
      </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* A26 morph (#798): the selection popup morphs in place between its format
     state (two chrome-less capsules) and its annotate (note-popover) state (a
     single chromed card). Structural/animation CSS lives here (class-toggled on
     persistent DOM identity); per the family decision (option B) width is NOT
     morphed — it's constant at the natural format width, so P1 animates the shell
     chrome (border-radius + the bg/border/shadow fade-in as it becomes the card)
     and P2 animates the block unfurl. The width unroll belongs to M2's
     fresh-mount entrance. Timing tokens + the dual reduced-motion guard come from
     morphTiming.css (imported above). */
  .selection-popup {
    position: fixed;
    /* Cursor-origin unroll (#798): left-anchored at the cursor X (no centering
       transform). `left` + `top`/`bottom` from popupPositionStyle pin the
       cursor-side corner; popupEnter grows width/height from there. */
    display: flex;
    flex-direction: column;
    z-index: var(--tandem-z-modal);
    /* Fixed chrome over the Tauri WebView — never part of the drag region. */
    -webkit-app-region: no-drag;
    border-radius: var(--tandem-r-3);
    /* A8 two-pill: the shell is CHROME-LESS in the format state — the two
       .pill-row capsules carry their own border/shadow and the editor shows
       through the 5px gap. These scoped rules override the global
       .tandem-floating-pill recipe (higher specificity). `border` stays
       `1px solid transparent` (not none) so border-color can interpolate during
       P1. The recipe carries no backdrop-filter, so the shell needs no reset
       here — it used to set `backdrop-filter: none` to cancel the recipe's blur,
       but lightningcss collapsed that reset to `-webkit-`-only at minify time
       (Chromium ignores the prefixed form; #1188), so in production the blur
       leaked through this transparent shell as a stray frosted rect. The reset
       is gone WITH the recipe's blur, not in favour of it — re-adding either
       brings the bug back. The shell re-acquires the full card chrome in
       .is-annotate (= the note popover), and P1 tweens all of it. P1 fires only
       on the .is-annotate toggle, never on mount (a transition never animates an
       initial value), and there is no annotate→format reverse, so the chrome
       tweens transparent→card exactly once. */
    background: transparent;
    border: 1px solid transparent;
    box-shadow: none;
    transition:
      border-radius var(--morph-p1) var(--tandem-ease-out),
      background-color var(--morph-p1) var(--tandem-ease-out),
      border-color var(--morph-p1) var(--tandem-ease-out),
      box-shadow var(--morph-p1) var(--tandem-ease-out);
  }
  /* r-5, not r-4: the design system's `components-inputs` annotation popup is
     the reference for this surface and carries a 16px corner. 16 is off the
     radius scale (2/4/6/8/12), so this takes the nearest token rather than
     introducing a ninth value — the card reads notably rounder than it did at
     r-4 without leaving the system. Morph-safe either way: `border-radius` is
     one of the four properties P1 already tweens, so this only changes the
     target the pill-shaped format state animates toward. */
  .selection-popup.is-annotate {
    border-radius: var(--tandem-r-5);
    background: var(--tandem-surface);
    border-color: var(--tandem-border);
    box-shadow: var(--c7-pill-shadow);
  }

  /* A8 two-pill: format-state column of two capsules. The gap lives HERE (inside
     morph-format), never on .selection-popup — a shell-level flex gap would
     render a phantom 5px against the 0fr-collapsed annotate block. Capsules are
     width:max-content so the narrower annotate row doesn't stretch to the format
     row's width (column children stretch by default). Each capsule pulls its
     chrome from the global .tandem-floating-pill class; here we add only layout.
     Capsules keep the default `overflow: visible` and create NO stacking context
     (no z-index/transform/isolation) so capsule-1's heading/Decorations
     dropdowns escape clipping AND paint over capsule 2. */
  .popup-format-col {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 5px;
  }
  .popup-format-col .pill-row {
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 4px 6px;
    width: max-content;
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

  /* Unfurl direction must follow the anchor. A "below" popup is top-anchored
     (`top` set, `bottom: auto`), so the composer must grow DOWNWARD from a fixed
     top edge — which means the annotate block has to be the TOP flex child.
     Without this swap the format block (source-first) collapses ABOVE the
     annotate block, dragging the composer's top edge upward as it grows, so it
     reads as unfurling up regardless of placement (#798 M1 spot-check). An
     "above" popup is bottom-anchored and keeps source order (annotate is the
     bottom child, grows upward from the fixed bottom). `order` is purely visual —
     DOM/tab/AT order is unchanged. */
  .selection-popup.is-below .morph-annotate {
    order: 0;
  }
  .selection-popup.is-below .morph-format {
    order: 1;
  }

  /* #1006: annotate composer in the A8 design language. The card shell chrome
     (pill body --tandem-surface, hairline --tandem-border, --c7-pill-shadow)
     is already applied by .selection-popup.is-annotate above; these rules
     cover the composer internals. Controls follow A8's format-button sizing
     (28px height).

     #1444 superseded #1006's colour and shape decisions here. #1006 gave Send a
     tinted-coral treatment and left Note ghost/monochrome; the annotation card
     independently gave its Send an accent treatment, so the same action shipped
     in two colour families with two written rationales. Neither family wins:
     both buttons are colour-neutral and CO-EQUAL (there is no primary — the
     audience choice is a fork, not a recommendation), and a destination marker
     carries what the fill used to. Radius is --tandem-r-pill, not the A8
     --tandem-r-3, so the shape matches the card and batch-bar Sends.
     ADR-027 structure (Note = private, Send = outbound) and keybindings are
     unchanged. See docs/design-system-impl/conflicts-resolved.md. */
  /* Padding is space-3 with a shorter bottom, following the design system's
     `preview/components-inputs.html` annotation popup (12/12/10). The bottom is
     lighter than the sides on purpose: the action row's own `padding-top`
     already supplies space under the divider, so a symmetric 12 would read as a
     double gutter at the card's foot. */
  .composer-card {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-2);
    padding: var(--tandem-space-3) var(--tandem-space-3) var(--tandem-space-2);
    min-width: 260px;
    /* 420px, inherited from #1444 and now VESTIGIAL — it is kept as a ceiling,
       not as a fitting constraint, and nothing here is sized to it.

       #1444 raised this from 360 because the footer was two labelled pills in a
       `justify-content: flex-end` row that clipped on its LEFT when they
       overflowed (a silent truncation, since `.morph-block` is `overflow:
       clip`). The audience toggle deleted that geometry. Measured in the
       running app: the footer needs 254px of content — toggle 149 + gap 8 +
       commit 97 — plus 24px of card padding, against a card that renders at
       414px because the shell pins it to the format row's natural width. Some
       142px of slack, and the card is not content-sized in the first place.

       #1123's longer agent names do not bring the old risk back. The segments
       are `minmax(0, 1fr)`, so they stay equal (72px each here) and a longer
       family name widens the toggle by a few px per segment rather than pushing
       a sibling off the start edge. "GPT-5 Codex" lands around 278px total.

       Left in place rather than deleted because it still bounds the card if the
       shell ever stops governing, and `computeSelectionToolbarPosition` derives
       maxLeft from the MEASURED toolbarWidth either way, so a wider card is
       clamped into the viewport rather than overflowing it. */
    max-width: 420px;
  }
  /* 52px, up from 28px, per the design system's annotation popup: a one-line
     well made the card feel like a search field, and the reference gives the
     draft about three lines of resting room before it grows.

     This DOES move a number the position math reads. The card's resting height
     goes up by ~24px, but SELECTION_POPUP_HEIGHT_RESERVE is 240 against a card
     that measured ~111px, so the headroom absorbs it several times over.
     `field-sizing: content` still grows from here; `max-height` is unchanged,
     so the scroll ceiling has not moved. */
  .composer-input {
    width: 100%;
    box-sizing: border-box;
    field-sizing: content;
    min-height: 52px;
    max-height: 120px;
    overflow-y: auto;
    resize: none;
    /* #1385: un-boxed — the draft reads as content, not as a form field. The
       border is kept at 1px `transparent` rather than removed so the
       forced-colors rule below can paint a resting boundary without shifting
       layout by a pixel; with no boundary at all, a borderless textarea is
       indistinguishable from static text in HCM. The global token remap in
       index.html cannot reach this one, because `transparent` is a keyword
       rather than a token — and forced-colors deliberately exempts
       `transparent`, so the explicit override below is what does the work.
       Same shape as ToastContainer's `.toast-card`. */
    border: 1px solid transparent;
    background: none;
    color: var(--tandem-fg);
    font-size: var(--tandem-text-base);
    /* 1.5 per the reference. Horizontal padding stays 0 even though the
       reference insets its textarea by 6px: that inset is relative to a card
       whose eyebrow is inset too, and here only the textarea would move —
       leaving the draft hanging 6px right of the label above it. */
    line-height: 1.5;
    font-family: inherit;
    padding: var(--tandem-space-1) 0;
  }
  .composer-input::placeholder {
    color: var(--tandem-fg-subtle);
  }
  /* Until #1385 this was a three-layer composite — a *transparent* outline, a
     border-color swap, and a 10%-alpha ring — of which the border was the only
     part carrying normal-mode weight. Un-boxing the field removed it, and a
     10%-alpha box-shadow alone is far under SC 1.4.11's 3:1, so the outline is
     now opaque and does the whole job.
     `--tandem-accent`, not the author-claude family the old border used. A8
     keys the annotation *chrome* to coral, which is what the old rule read as
     on a border; on an `outline` it reads as a focus ring instead, and the
     sibling `.composer-btn:focus-visible` a few rules below is accent — so
     coral here would put two focus hues in one component. Accent is also the
     better choice in HCM, mapping to `Highlight` (the system focus color)
     where `--tandem-author-claude-border` maps to `ButtonText`. The dropped
     box-shadow used `--tandem-claude-focus-bg`, which despite the name is
     Claude's *presence* tint (paragraph background in `awareness.ts`, the
     typing pill, the working pill), not a keyboard-focus token.

     THE RING IS NOW FORCED-COLORS ONLY. In normal mode the caret is the focus
     indicator and there is no drawn ring at all.

     Why the drawn ring had to go: it and #1385's un-boxing pull against each
     other. An opaque 2px rectangle standing 2px off a borderless well re-draws
     exactly the box that was removed, and at the reference's 52px well height
     that rectangle is the largest object on the card. It is also lit ~100% of
     the time — the composer auto-focuses this field on open — so it never
     reads as "focused", only as chrome. A card-edge ring was tried instead and
     fails the same way for the same reason: always-on, so always decoration.

     This is a deliberate departure from the usual "never remove a focus ring"
     rule, and the thing that makes it defensible is narrow, so do not
     generalise it. A text-entry field renders a blinking caret at the
     insertion point whenever it holds focus; that caret is a real, moving,
     author-independent focus indicator, and it is the only control type that
     has one. The two audience segments and the commit button keep their
     `:focus-visible` rings precisely because they do not.

     `outline: none` is REQUIRED, not tidying. Deleting the author rule does not
     leave the field ringless — it uncovers Chromium's UA default, which
     computes to `rgb(16,16,16) auto 1px`: a near-black rectangle in the same
     place, worse than the accent one it replaced. That is what this line
     suppresses, and it is why "just delete the rule" is not the fix.

     Forcing keeps a real ring, and that is not a hedge. HCM users may be
     running a theme where the caret is low-contrast or a screen magnifier
     where it is off-screen, the aesthetic argument above does not apply there,
     and an outline is forcing's own idiom. `Highlight` is the system focus
     color; `--tandem-accent` would have mapped to it anyway. */
  .composer-input:focus {
    outline: none;
  }
  @media (forced-colors: active) {
    .composer-input {
      border-color: ButtonText;
    }
    .composer-input:focus {
      outline: 2px solid Highlight;
      outline-offset: 2px;
    }
  }
  /* #1385: a full-bleed hairline separates the action row instead of whitespace
     alone, and doubles as the bottom edge the un-boxed textarea scrolls against
     once its content passes max-height. Negative horizontal margins cancel
     .composer-card's padding so the rule reaches the card edges; the flex `gap`
     still supplies the space ABOVE the border, and `padding-top` adds the
     matching space below it.

     THE MARGIN AND THE CARD'S SIDE PADDING MUST BE THE SAME TOKEN. They are
     both space-3. Change one without the other and the divider either stops
     short of the card edge or overhangs it into the shell's rounded corner —
     visible, but easy to mistake for a radius artefact rather than a margin
     bug, which is why this is stated rather than left to be inferred.

     The codebase's other edge-to-edge dividers (ChatPanel, CommandPalette,
     FindReplaceBar) avoid this cancellation by keeping horizontal padding on
     the sections rather than the container. That is the tidier shape, but here
     it would push .composer-input's box out to the card edges, and its focus
     outline sits at `outline-offset: 2px` — which `.morph-block`'s
     `overflow: clip` would then cut. Left as-is deliberately. */
  /* space-between, not flex-end: the audience toggle takes the left half that
     the old two-button row left empty, and the single commit button holds the
     right. */
  .composer-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--tandem-space-2);
    margin: 0 calc(-1 * var(--tandem-space-3));
    padding: var(--tandem-space-2) var(--tandem-space-3) 0;
    border-top: 1px solid var(--tandem-border);
  }

  /* ── Audience toggle ─────────────────────────────────────────────────────
     A deliberate copy of ModeToggle's recipe (Solo/Tandem), because this is the
     same control doing the same job on a different axis, and two segmented
     controls that look almost-but-not-quite alike is worse than either.
     What is copied and WHY it is copied, since each one is load-bearing there:

       - `repeat(2, minmax(0, 1fr))`, not `1fr`. A bare `1fr` floors each column
         at min-content, so unequal labels ("Self" vs "Assistant") produce
         unequal columns and the thumb — which IS column 1 — lands on a segment
         of a different width. That was #1383/#1384 on the mode toggle, and the
         agent family name makes this control MORE exposed to it, not less.
       - `position: relative` establishes the thumb's containing block. Without
         it the grid placement below silently stops applying.
       - `gap: 0`. The thumb slides exactly one column, so any gutter desyncs
         `translateX(100%)` from the column pitch.

     Metrics are this card's, not the title bar's: text-2xs against the mode
     toggle's 11px, because it sits next to a 26px pill rather than in a 44px
     strip. */
  .composer-audience {
    display: inline-grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    position: relative;
    gap: 0;
    padding: 2px;
    background: var(--tandem-surface-sunk);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-pill);
    font-size: var(--tandem-text-2xs);
    font-weight: 600;
    min-width: 0;
  }
  /* Both axes' grid lines are written out. On an absolutely-positioned grid
     child an `auto` end line resolves to the container's PADDING EDGE rather
     than `span 1`, so a two-line `grid-area: 1 / 1` stretches the thumb across
     the whole track. `inset: 0` is required too — without it the abspos box
     shrink-to-fits and renders 0x0. */
  .audience-thumb {
    position: absolute;
    grid-area: 1 / 1 / 2 / 2;
    inset: 0;
    background: var(--tandem-surface);
    border-radius: var(--tandem-r-pill);
    box-shadow: var(--tandem-shadow-1);
    pointer-events: none;
    z-index: 0;
    transition: transform 220ms var(--tandem-ease-out);
  }
  :global(body.tandem-reduce-motion) .audience-thumb {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .audience-thumb {
      transition: none;
    }
  }
  .audience-thumb.is-agent {
    transform: translateX(100%);
  }
  .audience-seg {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--tandem-space-1);
    padding: 3px var(--tandem-space-2);
    border-radius: var(--tandem-r-pill);
    color: var(--tandem-fg-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    font: inherit;
    /* `normal`, not `1`: at line-height 1 the line box is shorter than the
       glyph box and the label rides against the top of the pill. */
    line-height: normal;
    white-space: nowrap;
    min-width: 0;
    /* Above the thumb — the thumb, not the button, carries the active fill. */
    position: relative;
    z-index: 1;
    transition: color 140ms ease;
  }
  :global(body.tandem-reduce-motion) .audience-seg {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .audience-seg {
      transition: none;
    }
  }
  .audience-seg.on {
    color: var(--tandem-fg);
  }
  .audience-seg:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
  /* Not cosmetic. Under forced colors the thumb's `--tandem-surface` and the
     track's `--tandem-surface-sunk` both map to Canvas, so the sliding fill
     disappears and this outline becomes the ONLY indication of which audience
     is selected. Same rule, same reason, as ModeToggle. */
  @media (forced-colors: active) {
    .audience-seg.on {
      outline: 2px solid ButtonText;
    }
  }
  /* #1444: one rule, both buttons — there is no primary variant to override it.
     #1385's `flex: 1` removal stands (content-sized, so the row's width is the
     sum of two labels). The border is unconditional now: #1385 made it
     `transparent` so the row would not reflow when a `.is-primary` variant
     swapped in an opaque one, and with no variants left there is nothing to
     reflow against.

     muted -> sunk on hover darkens in every theme and always AWAY from the
     --tandem-surface card behind it, which is why rest is `muted` rather than
     the `sunk` an earlier draft used. */
  .composer-btn {
    border: 1px solid var(--tandem-border-strong);
    background: var(--tandem-surface-muted);
    color: var(--tandem-fg);
    font-weight: 500;
    /* `nowrap` keeps a long agent family name from wrapping text out of the
       fixed height; the destination markers cost another 10px + gap each,
       which is why .composer-card's cap moved to 420px. */
    white-space: nowrap;
    /* 26/11px, down from 28/12px. Two references agree on the smaller size and
       the old one agreed with neither: the design system's annotation popup
       sets 26px at 11.5px, and .aca-btn — the card twin this is deliberately
       colour-matched to — is text-xs. The composer was the only surface in the
       app running text-sm on an action of this kind.

       This SHRINKS the actions row, so #1444's 420px cap keeps its headroom
       rather than losing it; the cap is not re-derived here because it was
       measured, and a narrower row cannot invalidate a measurement taken
       against a wider one. */
    height: 26px;
    padding: 0 var(--tandem-space-3);
    border-radius: var(--tandem-r-pill);
    font-size: var(--tandem-text-xs);
    font-family: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* space-1, not space-2: at 26px the marker, label and key chip are one
       tight cluster. `.aca-btn--send` uses 6px for the same reason. */
    gap: var(--tandem-space-1);
    transition:
      background 120ms,
      color 120ms;
  }
  /* Reduced motion: literal 120ms tweens with no --morph-* term, so the token
     zeroing that flattens the A8 morph above leaves them running. Re-declare
     `none` on the exact selector, once for the in-app
     `body.tandem-reduce-motion` (class on <body>, so :global(...)) and once for
     the OS pref — media half last, its specificity only ties. */
  :global(body.tandem-reduce-motion) .composer-btn {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .composer-btn {
      transition: none;
    }
  }
  .composer-btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .composer-btn:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
  .composer-btn:hover:not(:disabled) {
    background: var(--tandem-surface-sunk);
  }
  /* #1444 destination marker. Filled disc = the agent, ring = yourself.
     SHAPE, not just colour: --tandem-author-user and --tandem-author-claude
     BOTH map to CanvasText under forced colors (index.html), so a colour-only
     marker collapses to two identical dots. The filled one carries a border in
     its own colour so that under forcing the border resolves to CanvasText on
     both while the background stays filled on one and `transparent` — which is
     forcing-exempt — on the other. No forced-colors rule needed.

     10px/2px, not 8px/2px: an 8px box leaves a 4px aperture that reads as a
     filled dot at 100% zoom, which would defeat the whole shape argument.

     The colours are LITERAL rather than agentColor(): the destination is known,
     but agentColor keys on a per-record AgentIdentity no prospective control
     has, and the per-agent palette is inert while BYO_MODELS_ENABLED is false.
     "Send to GPT" would therefore get a coral disc — unreachable today, #1123
     M4's problem.

     Declared per component on purpose. Svelte scopes and prunes per compound
     selector, so grouping this with .aca-dest across files would emit
     css_unused_selector and fail `svelte-check --fail-on-warnings`. The twin
     copies live in AnnotationCardActions.svelte and BatchPromoteBar.svelte —
     nothing enforces the sync, so change all three together. */
  .composer-dest {
    box-sizing: border-box;
    width: 10px;
    height: 10px;
    border-radius: var(--tandem-r-circle);
    border: 2px solid var(--tandem-author-claude);
    background: var(--tandem-author-claude);
    flex-shrink: 0;
  }
  .composer-dest-user {
    border-color: var(--tandem-author-user);
    background: transparent;
  }
  /* A chip, not bare text — the design system's annotation popup sets its key
     hint on its own tinted ground, and on a neutral pill that is what stops the
     glyphs reading as part of the label.

     `surface-sunk` is the same token the button's own hover uses, so a hovered
     button and its chip converge to one surface instead of the chip staying a
     lighter island. The reference tints with a white alpha, which would vanish
     on the dark theme's muted pill; a token holds in both. */
  .composer-kbd {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    background: var(--tandem-surface-sunk);
    border-radius: var(--tandem-r-2);
    padding: 1px var(--tandem-space-1);
    /* -muted, not -subtle. With the primary treatment gone this hint is the
       only element stating which key commits which action, so it takes the
       louder of the two quiet tokens. */
    color: var(--tandem-fg-muted);
  }
</style>
