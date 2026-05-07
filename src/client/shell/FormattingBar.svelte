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
  panelVisible?: boolean;
  onTogglePanel?: () => void;
}

const { editor, ydoc, panelVisible = true, onTogglePanel }: Props = $props();

const canHighlight = $derived(!!editor && !editor.isDestroyed);

function handleHighlight(color: HighlightColor) {
  if (!editor || !ydoc || editor.isDestroyed) return;
  const { state } = editor;
  const { from, to } = state.selection;
  if (from === to) return;
  const flatFrom = pmPosToFlatOffset(state.doc, toPmPos(from));
  const flatTo = pmPosToFlatOffset(state.doc, toPmPos(to));
  if (flatFrom === null || flatTo === null) return;
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
    aria-label={panelVisible ? "Hide panel" : "Show panel"}
    aria-pressed={panelVisible}
    title={panelVisible ? "Hide panel" : "Show panel"}
    onclick={onTogglePanel}
    style="width: 28px; height: 24px; padding: 0 4px; border: none; border-radius: var(--tandem-r-2);
      background: {panelVisible ? 'var(--tandem-accent-bg)' : 'transparent'};
      color: {panelVisible ? 'var(--tandem-accent)' : 'var(--tandem-fg-subtle)'};
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
</div>
