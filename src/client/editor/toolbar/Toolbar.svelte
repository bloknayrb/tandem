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
import type { Annotation, AnnotationType, HighlightColor, TandemMode } from "../../../shared/types";
import { generateAnnotationId } from "../../../shared/utils";
import { pmPosToFlatOffset } from "../../positions";
import { toggleHighlight } from "./highlight-toggle";
import ModeToggle from "./ModeToggle.svelte";
import {
  attachSelectionToolbarListener,
  computeSelectionToolbarPosition,
} from "./selection-toolbar";
import ToolbarButton from "./ToolbarButton.svelte";

interface Props {
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
  onSettingsOpen?: () => void;
  /** Bindable settings button reference for keyboard-shortcut anchoring. */
  settingsBtn?: HTMLButtonElement | null;
  tandemMode?: TandemMode;
  onModeChange?: (mode: TandemMode) => void;
  selectionToolbar?: boolean;
  suppressSelectionToolbar?: boolean;
}

let {
  editor,
  ydoc,
  onSettingsOpen,
  settingsBtn = $bindable(null),
  tandemMode,
  onModeChange,
  selectionToolbar = true,
  suppressSelectionToolbar = false,
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

function updateSelectionAffordance(ed: TiptapEditor) {
  const { from, to } = ed.state.selection;
  const next = from !== to;
  hasSelection = next;
  if (!next) {
    selectionPosition = null;
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
    });
    if (
      selectionPosition &&
      selectionPosition.left === nextPosition.left &&
      selectionPosition.top === nextPosition.top
    ) {
      return;
    }
    selectionPosition = nextPosition;
  } catch {
    selectionPosition = null;
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
  document.addEventListener("scroll", handleScrollDismiss, true);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", scheduleUpdate);
    document.removeEventListener("scroll", handleScrollDismiss, true);
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

// Capture selection when popup appears, clear on dismiss
$effect(() => {
  if (showPopup && !capturedRange) captureSelectionRange();
  if (!showPopup) {
    capturedRange = null;
    // Only clear draft text if user isn't actively typing (prevents resize-glitch data loss)
    if (document.activeElement !== textareaEl) annotationText = "";
  }
});

// Auto-focus textarea when popup appears (untrack to avoid bind:this reactive loop)
$effect(() => {
  if (showPopup) {
    untrack(() => textareaEl?.focus());
  }
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
  const annotation = {
    id,
    author: "user" as const,
    type,
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

function handleScrollDismiss(event: Event) {
  // Don't dismiss if scroll originated inside the popup (e.g., textarea scrolling)
  if (toolbarEl && event.target instanceof Node && toolbarEl.contains(event.target)) return;
  dismissPopup();
}

function dismissPopup() {
  hasSelection = false;
  selectionPosition = null;
  capturedRange = null;
  annotationText = "";
  editor?.chain().focus().run();
}

function submitAsComment() {
  if (!annotationText.trim()) return;
  createAnnotation("comment", annotationText.trim());
  annotationText = "";
}

function submitAsNote() {
  createAnnotation("note", annotationText.trim());
  annotationText = "";
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
  <div
    bind:this={toolbarEl}
    role="toolbar"
    aria-label="Selection tools"
    style={`position: fixed; left: ${selectionPosition.left}px; top: ${selectionPosition.top}px; transform: translateX(-50%); display: flex; flex-direction: column; background: var(--tandem-surface); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-4); box-shadow: 0 1px 2px color-mix(in srgb, var(--tandem-fg) 4%, transparent), 0 8px 28px color-mix(in srgb, var(--tandem-fg) 10%, transparent); z-index: var(--tandem-z-modal); min-width: 260px; max-width: 320px;`}
  >
    <!-- Row 1: Quick actions (formatting + highlights) -->
    <div style="display: flex; align-items: center; gap: 1px; padding: 4px; border-bottom: 1px solid var(--tandem-border);">
      <button
        type="button"
        aria-label="Bold"
        title="Bold"
        onmousedown={(e) => {
          e.preventDefault();
          editor?.chain().focus().toggleBold().run();
        }}
        onclick={onKeyActivate(() => editor?.chain().focus().toggleBold().run())}
        style="height: 28px; min-width: 28px; padding: 0 8px; border: none; background: transparent; color: var(--tandem-fg); border-radius: var(--tandem-r-2); font-size: 12px; font-weight: 700; cursor: pointer;"
      >B</button>
      <button
        type="button"
        aria-label="Italic"
        title="Italic"
        onmousedown={(e) => {
          e.preventDefault();
          editor?.chain().focus().toggleItalic().run();
        }}
        onclick={onKeyActivate(() => editor?.chain().focus().toggleItalic().run())}
        style="height: 28px; min-width: 28px; padding: 0 8px; border: none; background: transparent; color: var(--tandem-fg); border-radius: var(--tandem-r-2); font-size: 12px; font-style: italic; cursor: pointer;"
      >I</button>
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

    <!-- Row 2: Annotation textarea -->
    <div style="padding: 6px 8px;">
      <textarea
        bind:this={textareaEl}
        data-testid="popup-annotation-input"
        bind:value={annotationText}
        onkeydown={handleTextareaKeyDown}
        placeholder="Write a note or instruction..."
        rows={1}
        style="width: 100%; box-sizing: border-box; field-sizing: content; min-height: 28px; max-height: 120px; overflow-y: auto; resize: none; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); font-size: 12px; padding: 4px 6px; outline: none; font-family: inherit;"
      ></textarea>
    </div>

    <!-- Row 3: Submit buttons -->
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
        disabled={!annotationText.trim()}
        onclick={submitAsComment}
        style={`flex: 1; height: 28px; padding: 0 10px; border: 1px solid var(--tandem-author-user); background: transparent; color: var(--tandem-author-user); border-radius: var(--tandem-r-2); font-size: 12px; font-weight: 600; cursor: pointer; opacity: ${annotationText.trim() ? "1" : "0.4"};`}
      >Comment</button>
    </div>
  </div>
{/if}

<div
  style="display: flex; flex-wrap: wrap; align-items: center; gap: var(--tandem-space-3);
    min-height: 44px; padding: 0 var(--tandem-space-4);
    border-bottom: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted); user-select: none; position: relative; z-index: 5;"
>
  <span
    style="font-weight: 700; font-size: 14px;
      color: var(--tandem-fg); letter-spacing: 0; display: inline-flex; align-items: center; gap: 8px; padding-right: var(--tandem-space-3); border-right: 1px solid var(--tandem-border); height: 22px;"
  >
    <span
      aria-hidden="true"
      style="width: 18px; height: 18px; border-radius: var(--tandem-r-circle); background: conic-gradient(from 210deg, var(--tandem-author-user), var(--tandem-author-user) 44%, transparent 44% 56%, var(--tandem-author-claude) 56%, var(--tandem-author-claude)); display: inline-block;"
    ></span>
    Tandem
  </span>

  <ToolbarButton
    label="Comment"
    testId="toolbar-comment-btn"
    disabled={!canAnnotate}
    disabledTitle="Select text first"
    onMouseDown={(e) => {
      e.preventDefault();
      textareaEl?.focus();
    }}
  />

  <ToolbarButton
    label="Note"
    testId="toolbar-note-btn"
    disabled={!canAnnotate}
    disabledTitle="Select text first"
    onMouseDown={(e) => {
      e.preventDefault();
      textareaEl?.focus();
    }}
  />

  <div style="flex: 1;"></div>
  <div style="display: flex; align-items: center; gap: var(--tandem-space-3);">
    {#if tandemMode && onModeChange}
      <ModeToggle {tandemMode} {onModeChange} />
    {/if}
    {#if onSettingsOpen}
      <button
        bind:this={settingsBtn}
        data-testid="settings-btn"
        onclick={onSettingsOpen}
        title="Settings (Ctrl+,)"
        aria-label="Settings"
        aria-keyshortcuts="Control+Comma"
        style="background: transparent; border: 1px solid transparent;
          border-radius: var(--tandem-r-2); cursor: pointer; color: var(--tandem-fg-muted);
          font-size: 12px; padding: 0 var(--tandem-space-3); min-height: 28px;"
      >
        Settings
      </button>
    {/if}
  </div>
</div>
