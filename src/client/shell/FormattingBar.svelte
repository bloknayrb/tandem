<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import * as Y from "yjs";
import { toPmPos } from "../../shared/positions/types";
import type { HighlightColor } from "../../shared/types";
import FormattingToolbar from "../editor/toolbar/FormattingToolbar.svelte";
import HighlightColorPicker from "../editor/toolbar/HighlightColorPicker.svelte";
import { toggleHighlight } from "../editor/toolbar/highlight-toggle";
import ToolbarButton from "../editor/toolbar/ToolbarButton.svelte";
import { pmPosToFlatOffset } from "../positions";

interface Props {
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
  showAuthorship?: boolean;
  onAuthorshipChange?: (visible: boolean) => void;
}

const { editor, ydoc, showAuthorship = false, onAuthorshipChange }: Props = $props();

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
     pill centered horizontally over the document area at
     top: var(--tandem-fmtbar-top). Anchored via `position: fixed` (not
     absolute) so it stays viewport-aligned across containing-block changes
     in W4. Drag-region is intentionally NOT set on the wrap: the TitleBar
     already provides the window drag-region above it, and combining
     -webkit-app-region: drag with pointer-events: none is unreliable in
     WebView2 (Tauri-on-Windows) — clicks land on the editor underneath
     instead of moving the window. The pill itself sets no-drag so its
     buttons remain clickable on macOS where the surrounding titlebar
     drag-region might otherwise capture them. -->
<div
  class="tandem-fmtbar-wrap"
  style="position: fixed; top: var(--tandem-fmtbar-top, 52px); left: 0; right: 0; display: flex; justify-content: center; pointer-events: none; z-index: var(--tandem-z-sticky);"
>
  <div
    data-testid="formatting-bar"
    class="tandem-floating-pill"
    style="display: inline-flex; align-items: center; padding: var(--tandem-space-1); user-select: none; pointer-events: auto; -webkit-app-region: no-drag; max-width: calc(100% - var(--tandem-space-6));"
  >
    <div style="display: flex; align-items: center; gap: 1px; overflow: hidden; min-width: 0;">
      <FormattingToolbar {editor} />
      <div class="fmtbar-divider"></div>
      <HighlightColorPicker
        disabled={!canHighlight}
        onHighlight={handleHighlight}
      />
      {#if onAuthorshipChange}
        <div class="fmtbar-divider"></div>
        <ToolbarButton
          ariaLabel="Toggle authorship colors"
          shortcut="Ctrl+Alt+A"
          active={showAuthorship}
          testId="formatbar-authorship-toggle"
          onClick={() => onAuthorshipChange(!showAuthorship)}
        >
          {#snippet children()}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
              <circle cx="5.5" cy="8" r="3.2" fill="var(--tandem-author-user)" />
              <circle cx="10.5" cy="8" r="3.2" fill="var(--tandem-author-claude)" opacity="0.85" />
            </svg>
          {/snippet}
        </ToolbarButton>
      {/if}
    </div>
  </div>
</div>

<style>
  .fmtbar-divider {
    width: 1px;
    height: 16px;
    background: var(--tandem-border);
    margin: 0 2px;
    flex-shrink: 0;
  }
</style>
