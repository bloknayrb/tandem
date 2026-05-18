<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { untrack } from "svelte";
import * as Y from "yjs";
import {
  HIGHLIGHT_COLOR_VARS,
  HIGHLIGHT_COLORS,
  Y_MAP_ANNOTATIONS,
} from "../../../shared/constants";
import { toPmPos } from "../../../shared/positions/types";
import type { Annotation, AnnotationType, HighlightColor } from "../../../shared/types";
import { generateAnnotationId } from "../../../shared/utils";
import { pmPosToFlatOffset } from "../../positions";
import { onOutsideEvent } from "../../utils/dismiss-outside";
import { toggleHighlight } from "./highlight-toggle";
import {
  attachSelectionToolbarListener,
  computeSelectionToolbarPosition,
  type SelectionToolbarPlacement,
} from "./selection-toolbar";
import ToolbarButton from "./ToolbarButton.svelte";

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
}

let {
  editor,
  ydoc,
  selectionToolbar = true,
  suppressSelectionToolbar = false,
  requestCommentFocus = 0,
}: Props = $props();

let hasSelection = $state(false);
let selectionPosition = $state<{ left: number; top: number } | null>(null);
let toolbarEl = $state<HTMLDivElement | null>(null);
let annotationText = $state("");
let capturedRange = $state<{ from: number; to: number } | null>(null);
let textareaEl = $state<HTMLTextAreaElement | null>(null);

let toolbarHeight = $state(0);
let toolbarWidth = $state(0);
let viewportHeight = $state(window.innerHeight);
let viewportWidth = $state(window.innerWidth);

const MINI_HIGHLIGHT_COLORS = Object.keys(HIGHLIGHT_COLORS) as HighlightColor[];

const canAnnotate = $derived(!!editor && !!ydoc && hasSelection);
const showPopup = $derived(
  selectionToolbar && !suppressSelectionToolbar && canAnnotate && selectionPosition !== null,
);
const annotationTextTrimmed = $derived(annotationText.trim());

// Plain `let` — see SelectionToolbarPositionArgs.previousPlacement docstring.
// This is read+written from a Tiptap event listener, NOT from inside a
// Svelte $effect, so it does not need to be reactive and must not be
// $state (would risk effect_update_depth on every selection change).
let lastPlacement: SelectionToolbarPlacement | undefined;

function updateSelectionAffordance(ed: TiptapEditor) {
  const { from, to } = ed.state.selection;
  const next = from !== to;
  hasSelection = next;
  if (!next) {
    selectionPosition = null;
    lastPlacement = undefined;
    return;
  }

  try {
    const start = ed.view.coordsAtPos(from);
    const end = ed.view.coordsAtPos(to);
    const nextPosition = computeSelectionToolbarPosition({
      start,
      end,
      toolbarHeight,
      toolbarWidth,
      viewportHeight,
      viewportWidth,
      previousPlacement: lastPlacement,
    });
    lastPlacement = nextPosition.placement;
    if (
      selectionPosition &&
      selectionPosition.left === nextPosition.left &&
      selectionPosition.top === nextPosition.top
    ) {
      return;
    }
    selectionPosition = { left: nextPosition.left, top: nextPosition.top };
  } catch {
    selectionPosition = null;
    lastPlacement = undefined;
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
  return cleanup;
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
  const unsubscribeOutsideScroll = onOutsideEvent(
    () => toolbarEl,
    ["scroll"],
    () => {
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

  const updateToolbarMetrics = () => {
    // Skip position jitter while textarea is focused
    if (document.activeElement === textareaEl) return;
    const rect = el.getBoundingClientRect();
    toolbarHeight = rect.height;
    toolbarWidth = rect.width;
    updateSelectionAffordance(ed);
  };

  updateToolbarMetrics();
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

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    dismissPopup();
  }

  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
});

function createAnnotation(
  type: AnnotationType,
  content: string,
  extras?: { color?: HighlightColor },
) {
  if (!editor || !ydoc) return;

  const range = capturedRange ?? editor.state.selection;
  const { from, to } = range;
  if (from === to) return;

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

  ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, annotation);
  capturedRange = null;
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
}

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
  editor?.chain().focus().run();
}

function submitAsComment() {
  if (!annotationTextTrimmed) return;
  createAnnotation("comment", annotationTextTrimmed);
  dismissPopup();
}

function submitAsNote() {
  createAnnotation("note", annotationTextTrimmed);
  dismissPopup();
}

function handleTextareaKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitAsComment(); // Enter = primary action (Comment)
  } else if (e.key === "Escape") {
    e.preventDefault();
    dismissPopup();
  }
}
</script>

{#if showPopup && selectionPosition}
  <!-- Wave C: selection popup uses the shared .tandem-floating-pill recipe
       (same shadow + warm/white/dark variants as the formatting bar and
       titlebar pills). Replaces the previous inline 2-layer shadow. -->
  <div
    bind:this={toolbarEl}
    role="toolbar"
    aria-label="Selection tools"
    class="tandem-floating-pill"
    style={`position: fixed; left: ${selectionPosition.left}px; top: ${selectionPosition.top}px; transform: translateX(-50%); display: flex; flex-direction: column; border-radius: var(--tandem-r-4); z-index: var(--tandem-z-modal); min-width: 260px; max-width: 320px;`}
  >
    <div style="display: flex; align-items: center; gap: 1px; padding: 4px; border-bottom: 1px solid var(--tandem-border);">
      <ToolbarButton
        label="B"
        ariaLabel="Bold"
        style="font-weight: 700; min-width: 28px;"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        label="I"
        ariaLabel="Italic"
        style="font-style: italic; min-width: 28px;"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      />
      <div style="width: 1px; height: 18px; background: var(--tandem-border); margin: 0 3px;"></div>
      <div style="display: inline-flex; gap: 3px; padding: 0 4px;" aria-label="Highlight colors">
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
    </div>

    <div style="padding: 6px 8px;">
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
    </div>

    <div style="display: flex; justify-content: space-between; gap: 6px; padding: 4px 8px 6px;">
      <button
        type="button"
        data-testid="popup-note-submit"
        aria-label="Note to self"
        onclick={submitAsNote}
        style="flex: 1; height: 28px; padding: 0 10px; border: 1px solid var(--tandem-border); background: transparent; color: var(--tandem-fg-muted); border-radius: var(--tandem-r-2); font-size: 12px; font-weight: 500; cursor: pointer;"
      >Note to self</button>
      <button
        type="button"
        data-testid="popup-comment-submit"
        aria-label="Comment on selection"
        disabled={!annotationTextTrimmed}
        onclick={submitAsComment}
        style="flex: 1; height: 28px; padding: 0 10px; border: 1px solid var(--tandem-author-user); background: transparent; color: var(--tandem-author-user); border-radius: var(--tandem-r-2); font-size: 12px; font-weight: 600; cursor: pointer;"
      >Comment</button>
    </div>
  </div>
{/if}
