<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../../shared/constants";
import { toPmPos } from "../../../shared/positions/types";
import type { Annotation, AnnotationType, HighlightColor, TandemMode } from "../../../shared/types";
import { generateAnnotationId } from "../../../shared/utils";
import { pmPosToFlatOffset } from "../../positions";
import FormattingToolbar from "./FormattingToolbar.svelte";
import HighlightColorPicker from "./HighlightColorPicker.svelte";
import { toggleHighlight } from "./highlight-toggle";
import InputGroup from "./InputGroup.svelte";
import ModeToggle from "./ModeToggle.svelte";
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
  heldCount?: number;
  selectionToolbar?: boolean;
}

let {
  editor,
  ydoc,
  onSettingsOpen,
  settingsBtn = $bindable(null),
  tandemMode,
  onModeChange,
  heldCount,
  selectionToolbar = true,
}: Props = $props();

let hasSelection = $state(false);
let selectionPosition = $state<{ left: number; top: number } | null>(null);
let mode = $state<ToolbarMode>("idle");
let modeText = $state("");
let capturedRange: { from: number; to: number } | null = null;
let commentInputEl = $state<HTMLInputElement | null>(null);
let noteInputEl = $state<HTMLInputElement | null>(null);

const MINI_HIGHLIGHT_COLORS: HighlightColor[] = ["yellow", "green", "blue", "pink"];
const MINI_HIGHLIGHT_SWATCHES: Record<HighlightColor, string> = {
  yellow: "var(--tandem-highlight-yellow)",
  green: "var(--tandem-highlight-green)",
  blue: "var(--tandem-highlight-blue)",
  pink: "var(--tandem-highlight-pink)",
};

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
    selectionPosition = {
      left: (start.left + end.right) / 2,
      top: Math.min(start.top, end.top) - 10,
    };
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

  ed.on("selectionUpdate", onSelectionUpdate);
  ed.on("transaction", onSelectionUpdate);
  onSelectionUpdate();
  return () => {
    ed.off("selectionUpdate", onSelectionUpdate);
    ed.off("transaction", onSelectionUpdate);
  };
});

$effect(() => {
  if (!editor || !selectionPosition) return;
  const ed = editor;
  let frame = 0;

  function scheduleUpdate() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => updateSelectionAffordance(ed));
  }

  window.addEventListener("resize", scheduleUpdate);
  document.addEventListener("scroll", scheduleUpdate, true);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", scheduleUpdate);
    document.removeEventListener("scroll", scheduleUpdate, true);
  };
});

$effect(() => {
  if (mode === "comment") commentInputEl?.focus();
  else if (mode === "note") noteInputEl?.focus();
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

function handleModeStart(targetMode: ToolbarMode) {
  return (e: MouseEvent) => {
    e.preventDefault();
    captureSelectionRange();
    mode = targetMode;
    modeText = "";
  };
}

const startComment = handleModeStart("comment");
const startNote = handleModeStart("note");

function handleModeCancel() {
  mode = "idle";
  modeText = "";
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
  selectionToolbar && canAnnotate && !inInputMode && selectionPosition !== null,
);
</script>

{#if showMiniToolbar && selectionPosition}
  <div
    role="toolbar"
    aria-label="Selection tools"
    style={`position: fixed; left: ${selectionPosition.left}px; top: ${selectionPosition.top}px; transform: translate(-50%, -100%); display: inline-flex; align-items: center; gap: 1px; padding: 4px; background: var(--tandem-surface); border: 1px solid var(--tandem-border); border-radius: 8px; box-shadow: 0 1px 2px color-mix(in srgb, var(--tandem-fg) 4%, transparent), 0 8px 28px color-mix(in srgb, var(--tandem-fg) 10%, transparent); z-index: 1000; white-space: nowrap;`}
  >
    <button
      type="button"
      aria-label="Bold"
      title="Bold"
      onmousedown={(e) => {
        e.preventDefault();
        editor?.chain().focus().toggleBold().run();
      }}
      style="height: 28px; min-width: 28px; padding: 0 8px; border: none; background: transparent; color: var(--tandem-fg); border-radius: 4px; font-size: 12px; font-weight: 700; cursor: pointer;"
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
      style="height: 28px; min-width: 28px; padding: 0 8px; border: none; background: transparent; color: var(--tandem-fg); border-radius: 4px; font-size: 12px; font-style: italic; cursor: pointer;"
    >
      I
    </button>
    <button
      type="button"
      aria-label="Code"
      title="Code"
      onmousedown={(e) => {
        e.preventDefault();
        editor?.chain().focus().toggleCode().run();
      }}
      style="height: 28px; min-width: 28px; padding: 0 8px; border: none; background: transparent; color: var(--tandem-fg); border-radius: 4px; font-family: var(--tandem-font-mono); font-size: 11px; cursor: pointer;"
    >
      &lt;/&gt;
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
          style={`width: 16px; height: 16px; border-radius: 3px; border: 1px solid var(--tandem-border); background: ${MINI_HIGHLIGHT_SWATCHES[color]}; cursor: pointer; padding: 0;`}
        ></button>
      {/each}
    </div>
    <div style="width: 1px; height: 18px; background: var(--tandem-border); margin: 0 3px;"></div>
    <button
      type="button"
      aria-label="Comment on selection"
      title="Comment on selection"
      onmousedown={startComment}
      style="height: 28px; padding: 0 10px; border: none; background: transparent; color: var(--tandem-fg-muted); border-radius: 4px; font-size: 12px; font-weight: 500; cursor: pointer;"
    >
      Comment
    </button>
    <button
      type="button"
      aria-label="Private note on selection"
      title="Private note on selection"
      onmousedown={startNote}
      style="height: 28px; padding: 0 10px; border: none; background: transparent; color: var(--tandem-fg-muted); border-radius: 4px; font-size: 12px; font-weight: 500; cursor: pointer;"
    >
      Note
    </button>
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
      style="width: 18px; height: 18px; border-radius: 50%; background: conic-gradient(from 210deg, var(--tandem-author-user), var(--tandem-author-user) 44%, transparent 44% 56%, var(--tandem-author-claude) 56%, var(--tandem-author-claude)); display: inline-block;"
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
  {#if mode === "comment"}
    <InputGroup
      bind:inputEl={commentInputEl}
      value={modeText}
      onChange={(v) => (modeText = v)}
      onKeyDown={handleModeKeyDown}
      onSubmit={handleModeSubmit}
      onCancel={handleModeCancel}
      placeholder="Add a comment..."
      submitLabel="Add"
      borderColor="var(--tandem-author-user)"
      canSubmit={!!modeText.trim()}
      testIdPrefix="toolbar-comment"
    />
  {/if}

  <ToolbarButton
    label="Note"
    testId="toolbar-note-btn"
    disabled={!canAnnotate || inInputMode}
    disabledTitle="Select text first"
    onMouseDown={startNote}
  />
  {#if mode === "note"}
    <InputGroup
      bind:inputEl={noteInputEl}
      value={modeText}
      onChange={(v) => (modeText = v)}
      onKeyDown={handleModeKeyDown}
      onSubmit={handleModeSubmit}
      onCancel={handleModeCancel}
      placeholder="Add a note to yourself..."
      submitLabel="Add"
      borderColor="var(--tandem-fg-muted)"
      canSubmit={true}
      testIdPrefix="toolbar-note"
    />
  {/if}

  <div style="flex: 1;"></div>
  <div style="display: flex; align-items: center; gap: var(--tandem-space-3);">
    {#if (heldCount ?? 0) > 0}
      <span
        data-testid="held-badge"
        style="padding: 1px 7px; font-size: 10px; font-weight: 600; font-family: var(--tandem-font-mono);
          color: var(--tandem-warning-fg-strong);
          background: var(--tandem-warning-bg);
          border: 1px solid var(--tandem-warning-border); border-radius: 9999px;"
      >
        {heldCount} held
      </span>
    {/if}
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
          border-radius: 5px; cursor: pointer; color: var(--tandem-fg-muted);
          font-size: 12px; padding: 0 var(--tandem-space-3); min-height: 28px;"
      >
        Settings
      </button>
    {/if}
  </div>
</div>
