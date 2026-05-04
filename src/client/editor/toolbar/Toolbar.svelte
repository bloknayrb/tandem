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
}

let {
  editor,
  ydoc,
  onSettingsOpen,
  settingsBtn = $bindable(null),
  tandemMode,
  onModeChange,
  heldCount,
}: Props = $props();

let hasSelection = $state(false);
let mode = $state<ToolbarMode>("idle");
let modeText = $state("");
let capturedRange: { from: number; to: number } | null = null;
let commentInputEl = $state<HTMLInputElement | null>(null);
let noteInputEl = $state<HTMLInputElement | null>(null);

$effect(() => {
  if (!editor) return;
  const ed = editor;

  function onSelectionUpdate() {
    const { from, to } = ed.state.selection;
    const next = from !== to;
    if (hasSelection !== next) hasSelection = next;
  }

  ed.on("selectionUpdate", onSelectionUpdate);
  return () => {
    ed.off("selectionUpdate", onSelectionUpdate);
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
</script>

<div
  style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    min-height: 42px; padding: 8px 16px;
    border-bottom: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted); user-select: none;"
>
  <span
    style="font-weight: 700; font-size: 15px;
      color: var(--tandem-accent); letter-spacing: -0.02em;"
  >
    Tandem
  </span>
  <div
    style="width: 1px; height: 20px; background: var(--tandem-border); margin: 0 8px;"
  ></div>

  <FormattingToolbar {editor} disabled={inInputMode} />

  <div
    style="width: 1px; height: 20px; background: var(--tandem-border); margin: 0 8px;"
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
  <div style="display: flex; align-items: center; gap: 12px;">
    {#if (heldCount ?? 0) > 0}
      <span
        data-testid="held-badge"
        style="padding: 1px 6px; font-size: 10px; font-weight: 600;
          color: var(--tandem-warning-fg-strong);
          background: var(--tandem-warning-bg);
          border-radius: 9999px;"
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
        style="background: none; border: 1px solid var(--tandem-border-strong);
          border-radius: 4px; cursor: pointer; color: var(--tandem-fg-muted);
          font-size: 13px; padding: 4px 12px; min-height: 24px;"
      >
        Settings
      </button>
    {/if}
  </div>
</div>
