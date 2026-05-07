<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
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
import FormattingToolbar from "./FormattingToolbar.svelte";
import HighlightColorPicker from "./HighlightColorPicker.svelte";
import { toggleHighlight } from "./highlight-toggle";
import InputGroup from "./InputGroup.svelte";
import ModeToggle from "./ModeToggle.svelte";
import {
  attachSelectionToolbarListener,
  computeSelectionToolbarPosition,
} from "./selection-toolbar";
import ToolbarButton from "./ToolbarButton.svelte";

type ToolbarMode = "idle" | "comment" | "note";

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
let inputPosition = $state<{ left: number; top: number } | null>(null);
let toolbarEl = $state<HTMLDivElement | null>(null);
let mode = $state<ToolbarMode>("idle");
let modeText = $state("");
let capturedRange: { from: number; to: number } | null = null;
let activeInputEl = $state<HTMLInputElement | null>(null);

let toolbarHeight = $state(0);
let toolbarWidth = $state(0);
let viewportHeight = $state(window.innerHeight);
let viewportWidth = $state(window.innerWidth);

const MINI_HIGHLIGHT_COLORS = Object.keys(HIGHLIGHT_COLORS) as HighlightColor[];

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
  document.addEventListener("scroll", dismissSelectionToolbar, true);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", scheduleUpdate);
    document.removeEventListener("scroll", dismissSelectionToolbar, true);
  };
});

$effect(() => {
  const ed = editor;
  const el = toolbarEl;
  if (!ed || !el || !selectionPosition || inInputMode) return;

  const updateToolbarMetrics = () => {
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
  if (mode !== "idle") activeInputEl?.focus();
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

function resetAndFocusEditor() {
  capturedRange = null;
  editor?.chain().focus().run();
}

const inInputMode = $derived(mode !== "idle");

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

function handleModeStart(targetMode: ToolbarMode) {
  return (e: MouseEvent) => {
    e.preventDefault();
    if (!selectionPosition) {
      console.warn("[tandem] mode-start skipped — selection position unavailable");
      return;
    }
    captureSelectionRange();
    inputPosition = selectionPosition;
    mode = targetMode;
    modeText = "";
  };
}

const startComment = handleModeStart("comment");
const startNote = handleModeStart("note");

function dismissSelectionToolbar() {
  if (inInputMode) return;
  hasSelection = false;
  selectionPosition = null;
  capturedRange = null;
  inputPosition = null;
  mode = "idle";
  modeText = "";
}

function handleModeCancel() {
  mode = "idle";
  modeText = "";
  inputPosition = null;
  resetAndFocusEditor();
}

function handleModeSubmit() {
  if (mode === "note") {
    createAnnotation("note", modeText.trim());
  } else {
    if (!modeText.trim()) {
      handleModeCancel();
      return;
    }
    createAnnotation("comment", modeText.trim());
  }

  mode = "idle";
  modeText = "";
  inputPosition = null;
  editor?.chain().focus().run();
}

function handleModeKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    handleModeSubmit();
  } else if (e.key === "Escape") {
    handleModeCancel();
  }
}

const canAnnotate = $derived(!!editor && !!ydoc && hasSelection);
const showMiniToolbar = $derived(
  selectionToolbar &&
    !suppressSelectionToolbar &&
    canAnnotate &&
    !inInputMode &&
    selectionPosition !== null,
);

$effect(() => {
  if (!showMiniToolbar && !inInputMode) return;

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (inInputMode) {
      handleModeCancel();
    } else {
      dismissSelectionToolbar();
      editor?.chain().focus().run();
    }
  }

  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
});

function handleLinkMouseDown(e: MouseEvent) {
  e.preventDefault();
  if (!editor) return;

  if (editor.isActive("link")) {
    editor.chain().focus().unsetLink().run();
    return;
  }

  const url = window.prompt("Enter URL:");
  if (url) editor.chain().focus().setLink({ href: url }).run();
}
</script>

{#if (showMiniToolbar && selectionPosition) || (inInputMode && inputPosition)}
  {@const floatPos = inInputMode ? inputPosition! : selectionPosition!}
  <div
    bind:this={toolbarEl}
    role={inInputMode ? "dialog" : "toolbar"}
    aria-label={inInputMode ? (mode === "comment" ? "Add comment" : "Add note") : "Selection tools"}
    style={`position: fixed; left: ${floatPos.left}px; top: ${floatPos.top}px; transform: translateX(-50%); display: inline-flex; align-items: center; gap: 1px; padding: 4px; background: var(--tandem-surface); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-4); box-shadow: 0 1px 2px color-mix(in srgb, var(--tandem-fg) 4%, transparent), 0 8px 28px color-mix(in srgb, var(--tandem-fg) 10%, transparent); z-index: var(--tandem-z-modal); white-space: nowrap;`}
  >
    {#if inInputMode}
      <InputGroup
        bind:inputEl={activeInputEl}
        value={modeText}
        onChange={(v) => (modeText = v)}
        onKeyDown={handleModeKeyDown}
        onSubmit={handleModeSubmit}
        onCancel={handleModeCancel}
        placeholder={mode === "comment" ? "Add a comment..." : "Add a note to yourself..."}
        submitLabel="Add"
        borderColor={mode === "comment" ? "var(--tandem-author-user)" : "var(--tandem-fg-muted)"}
        canSubmit={mode === "comment" ? !!modeText.trim() : true}
        testIdPrefix={mode === "comment" ? "toolbar-comment" : "toolbar-note"}
      />
    {:else}
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
      >
        B
      </button>
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
      >
        I
      </button>
      <button
        type="button"
        aria-label="Strike"
        title="Strike"
        onmousedown={(e) => {
          e.preventDefault();
          editor?.chain().focus().toggleStrike().run();
        }}
        onclick={onKeyActivate(() => editor?.chain().focus().toggleStrike().run())}
        style="height: 28px; min-width: 28px; padding: 0 8px; border: none; background: transparent; color: var(--tandem-fg); border-radius: var(--tandem-r-2); font-size: 12px; text-decoration: line-through; cursor: pointer;"
      >
        S
      </button>
      <button
        type="button"
        aria-label="Code"
        title="Code"
        onmousedown={(e) => {
          e.preventDefault();
          editor?.chain().focus().toggleCode().run();
        }}
        onclick={onKeyActivate(() => editor?.chain().focus().toggleCode().run())}
        style="height: 28px; min-width: 28px; padding: 0 8px; border: none; background: transparent; color: var(--tandem-fg); border-radius: var(--tandem-r-2); font-family: var(--tandem-font-mono); font-size: 11px; cursor: pointer;"
      >
        &lt;/&gt;
      </button>
      <button
        type="button"
        aria-label="Link"
        title="Link"
        onmousedown={handleLinkMouseDown}
        onclick={onKeyActivate(handleLinkMouseDown)}
        style="height: 28px; min-width: 28px; padding: 0 8px; border: none; background: transparent; color: var(--tandem-fg); border-radius: var(--tandem-r-2); font-size: 12px; cursor: pointer;"
      >
        Link
      </button>
      <div style="width: 1px; height: 18px; background: var(--tandem-border); margin: 0 3px;"></div>
      <div style="display: inline-flex; gap: 3px; padding: 0 4px;" aria-label="Highlight colors">
        {#each MINI_HIGHLIGHT_COLORS as color}
          <button
            type="button"
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
        aria-label="Comment on selection"
        title="Comment on selection"
        onmousedown={startComment}
        onclick={onKeyActivate(startComment)}
        style="height: 28px; padding: 0 10px; border: none; background: transparent; color: var(--tandem-fg-muted); border-radius: var(--tandem-r-2); font-size: 12px; font-weight: 500; cursor: pointer;"
      >
        Comment
      </button>
      <button
        type="button"
        aria-label="Private note on selection"
        title="Private note on selection"
        onmousedown={startNote}
        onclick={onKeyActivate(startNote)}
        style="height: 28px; padding: 0 10px; border: none; background: transparent; color: var(--tandem-fg-muted); border-radius: var(--tandem-r-2); font-size: 12px; font-weight: 500; cursor: pointer;"
      >
        Note
      </button>
    {/if}
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

  <FormattingToolbar {editor} disabled={inInputMode} />

  <div
    style="width: 1px; height: 18px; background: var(--tandem-border);"
  ></div>

  <HighlightColorPicker
    disabled={!canAnnotate || inInputMode}
    onHighlight={handleHighlight}
  />

  <ToolbarButton
    label="Comment"
    testId="toolbar-comment-btn"
    disabled={!canAnnotate || inInputMode}
    disabledTitle="Select text first"
    onMouseDown={startComment}
  />

  <ToolbarButton
    label="Note"
    testId="toolbar-note-btn"
    disabled={!canAnnotate || inInputMode}
    disabledTitle="Select text first"
    onMouseDown={startNote}
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
