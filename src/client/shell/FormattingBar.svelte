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
}

const { editor, ydoc }: Props = $props();

// Force-reactive tick — mirrors FormattingToolbar's pattern so that
// canHighlight reflects the live selection state, not just editor existence.
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
    padding: 0 var(--tandem-space-3);
    border-bottom: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted);
    user-select: none; position: relative; z-index: 4;"
>
  <div style="flex: 1; display: flex; align-items: center; gap: 2px; overflow: hidden; min-width: 0;">
    <FormattingToolbar {editor} />
    <div style="width: 1px; height: 16px; background: var(--tandem-border); margin: 0 2px; flex-shrink: 0;"></div>
    <HighlightColorPicker
      disabled={!canHighlight}
      onHighlight={handleHighlight}
    />
  </div>
</div>
