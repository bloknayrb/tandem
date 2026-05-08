<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import * as Y from "yjs";
import { toPmPos } from "../../shared/positions/types";
import type { HighlightColor } from "../../shared/types";
import FormattingToolbar from "../editor/toolbar/FormattingToolbar.svelte";
import HighlightColorPicker from "../editor/toolbar/HighlightColorPicker.svelte";
import { toggleHighlight } from "../editor/toolbar/highlight-toggle";
import { pmPosToFlatOffset } from "../positions";

interface Props {
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
  leftPanelVisible?: boolean;
  onToggleLeftPanel?: () => void;
  rightPanelVisible?: boolean;
  onToggleRightPanel?: () => void;
}

const {
  editor,
  ydoc,
  leftPanelVisible = false,
  onToggleLeftPanel,
  rightPanelVisible = true,
  onToggleRightPanel,
}: Props = $props();

// Force-reactive tick — mirrors FormattingToolbar's pattern so that
// canHighlight reflects the live selection state, not just editor existence.
// Without this, toolbar-highlight-btn stays enabled even with no selection.
let _tick = $state(0);
$effect(() => {
  const ed = editor;
  if (!ed || ed.isDestroyed) return;
  const handler = () => {
    if (!ed.isDestroyed) _tick++;
  };
  ed.on("selectionUpdate", handler);
  ed.on("transaction", handler);
  return () => {
    ed.off("selectionUpdate", handler);
    ed.off("transaction", handler);
  };
});

const canHighlight = $derived.by(() => {
  void _tick;
  if (!editor || editor.isDestroyed || !ydoc) return false;
  return !editor.state.selection.empty;
});

function handleHighlight(color: HighlightColor) {
  if (!editor || !ydoc || editor.isDestroyed) return;
  const { state } = editor;
  const { from, to } = state.selection;
  if (from === to) return;
  const flatFrom = pmPosToFlatOffset(state.doc, toPmPos(from));
  const flatTo = pmPosToFlatOffset(state.doc, toPmPos(to));
  if (flatFrom === null || flatTo === null) {
    console.warn(
      "[FormattingBar] pmPosToFlatOffset returned null — CRDT position may be degraded",
      { from, to },
    );
    return;
  }
  toggleHighlight(ydoc, { from: flatFrom, to: flatTo }, color);
}
</script>

<div
  data-testid="formatting-bar"
  style="display: flex; align-items: center; height: var(--tandem-h-fmtbar, 36px);
    padding: 0 var(--tandem-space-2);
    border-bottom: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted);
    user-select: none; position: relative; z-index: 4;"
>
  <!-- Left rail toggle -->
  <button
    type="button"
    data-testid="formatting-bar-toggle-left"
    aria-label={panelVisible ? "Hide panel" : "Show panel"}
    aria-pressed={panelVisible}
    title={panelVisible ? "Hide panel" : "Show panel"}
    onclick={onTogglePanel}
    style="width: 28px; height: 24px; padding: 0 4px; border: none; border-radius: var(--tandem-r-2);
      background: {leftPanelVisible ? 'var(--tandem-accent-bg)' : 'transparent'};
      color: {leftPanelVisible ? 'var(--tandem-accent)' : 'var(--tandem-fg-subtle)'};
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      margin-right: var(--tandem-space-2); flex-shrink: 0;"
  >
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <rect x="1" y="2" width="5" height="12" fill="currentColor" opacity="0.6"/>
    </svg>
  </button>

  <div style="width: 1px; height: 16px; background: var(--tandem-border); margin: 0 var(--tandem-space-2); flex-shrink: 0;"></div>

  <!-- Formatting controls (flex: 1 to fill remaining width) -->
  <div style="flex: 1; display: flex; align-items: center; gap: 2px; overflow: hidden; min-width: 0;">
    <FormattingToolbar {editor} />
    <div style="width: 1px; height: 16px; background: var(--tandem-border); margin: 0 2px; flex-shrink: 0;"></div>
    <HighlightColorPicker
      disabled={!canHighlight}
      onHighlight={handleHighlight}
    />
  </div>

  <div style="width: 1px; height: 16px; background: var(--tandem-border); margin: 0 var(--tandem-space-2); flex-shrink: 0;"></div>

  <!-- Right rail toggle — toggles shared panelHidden until independent left/right visibility lands -->
  <button
    type="button"
    aria-label={rightPanelVisible ? "Hide panels" : "Show panels"}
    aria-pressed={rightPanelVisible}
    title={rightPanelVisible ? "Hide panels" : "Show panels"}
    data-testid="formatting-bar-toggle-right"
    onclick={onToggleRightPanel}
    style="width: 28px; height: 24px; padding: 0 4px; border: none; border-radius: var(--tandem-r-2);
      background: {rightPanelVisible ? 'var(--tandem-accent-bg)' : 'transparent'};
      color: {rightPanelVisible ? 'var(--tandem-accent)' : 'var(--tandem-fg-subtle)'};
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      margin-left: var(--tandem-space-2); flex-shrink: 0;"
  >
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <rect x="10" y="2" width="5" height="12" fill="currentColor" opacity="0.6"/>
    </svg>
  </button>
</div>
