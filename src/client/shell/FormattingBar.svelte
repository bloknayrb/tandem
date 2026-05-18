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

<!-- v7 floating chrome (Wave 3): the persistent format bar is now a floating
     pill centered over the editor at top: var(--tandem-fmtbar-top, 52px).
     The wrapper is pointer-events: none so clicks pass through to the editor
     where the pill is not; the pill itself is pointer-events: auto. The wrap
     is also -webkit-app-region: drag (Tauri) so the strip above/around the
     pill remains drag-region, while the pill is no-drag for button clicks. -->
<div
  class="tandem-fmtbar-wrap"
  style="position: absolute; top: var(--tandem-fmtbar-top, 52px); left: 0; right: 0; display: flex; justify-content: center; pointer-events: none; z-index: var(--tandem-z-sticky); -webkit-app-region: drag;"
>
  <div
    data-testid="formatting-bar"
    class="tandem-floating-pill"
    style="display: inline-flex; align-items: center; height: var(--tandem-h-fmtbar, 36px); padding: 0 var(--tandem-space-3); user-select: none; pointer-events: auto; -webkit-app-region: no-drag; max-width: calc(100% - var(--tandem-space-6));"
  >
    <div style="display: flex; align-items: center; gap: 2px; overflow: hidden; min-width: 0;">
      <FormattingToolbar {editor} />
      <div style="width: 1px; height: 16px; background: var(--tandem-border); margin: 0 2px; flex-shrink: 0;"></div>
      <HighlightColorPicker
        disabled={!canHighlight}
        onHighlight={handleHighlight}
      />
    </div>
  </div>
</div>
