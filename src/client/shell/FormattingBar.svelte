<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import * as Y from "yjs";
import { toPmPos } from "../../shared/positions/types";
import type { HighlightColor } from "../../shared/types";
import FormattingToolbar from "../editor/toolbar/FormattingToolbar.svelte";
import HighlightColorPicker from "../editor/toolbar/HighlightColorPicker.svelte";
import { toggleHighlight } from "../editor/toolbar/highlight-toggle";
import { pmPosToFlatOffset } from "../positions";
import DecorationsMenu from "./DecorationsMenu.svelte";

interface Props {
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
  // Decoration display state (1.13). Drives the trailing Decorations split
  // button (eye = master mute/restore, caret = per-type options incl.
  // authorship). The four per-type prefs reflect the user's *preference*;
  // master mute is a separate overlay, so a muted state still shows the rows
  // as checked.
  showAuthorship?: boolean;
  showComments?: boolean;
  showHighlights?: boolean;
  showNotes?: boolean;
  decorationsMuted?: boolean;
  /** Persist a decoration settings partial (per-type rows auto-unmute in one call). */
  onUpdateDecorations?: (partial: {
    showAuthorship?: boolean;
    showComments?: boolean;
    showHighlights?: boolean;
    showNotes?: boolean;
    decorationsMuted?: boolean;
  }) => void;
  /** Open Settings → Appearance (the canonical home for these toggles). */
  onOpenSettings?: () => void;
  /**
   * 1.11: hide the persistent bar (sets `formattingBarVisible: false`). When
   * provided, a trailing collapse control renders. Restoring is via the
   * command palette / Appearance settings / the always-full selection popup.
   */
  onHide?: () => void;
}

const {
  editor,
  ydoc,
  showAuthorship = true,
  showComments = true,
  showHighlights = true,
  showNotes = true,
  decorationsMuted = false,
  onUpdateDecorations,
  onOpenSettings,
  onHide,
}: Props = $props();

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
    <!-- The format controls live in an overflow:hidden track so a narrow
         window truncates buttons rather than wrapping. The Decorations split
         button is intentionally OUTSIDE that track: it must never truncate,
         and its dropdown (which drops below the pill) would otherwise be
         clipped by the track's overflow:hidden. -->
    <div style="display: flex; align-items: center; gap: 1px; overflow: hidden; min-width: 0;">
      <FormattingToolbar {editor} />
      <div class="fmtbar-divider"></div>
      <HighlightColorPicker
        disabled={!canHighlight}
        onHighlight={handleHighlight}
      />
    </div>
    {#if onUpdateDecorations}
      <div class="fmtbar-divider"></div>
      <DecorationsMenu
        {showAuthorship}
        {showComments}
        {showHighlights}
        {showNotes}
        {decorationsMuted}
        onUpdate={onUpdateDecorations}
        {onOpenSettings}
      />
    {/if}
    {#if onHide}
      <!-- Outside the overflow:hidden track so it never truncates. Hiding the
           bar leaves formatting reachable via the always-full selection popup;
           restore via the command palette or Appearance settings. -->
      <div class="fmtbar-divider"></div>
      <button
        type="button"
        class="fmtbar-hide"
        data-testid="formatbar-hide-btn"
        title="Hide formatting bar"
        aria-label="Hide formatting bar"
        onclick={onHide}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m18 15-6-6-6 6" />
        </svg>
      </button>
    {/if}
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
  .fmtbar-hide {
    height: 26px;
    min-width: 26px;
    padding: 0 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--tandem-fg-muted);
    border-radius: var(--tandem-r-pill);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 120ms, color 120ms;
  }
  .fmtbar-hide:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .fmtbar-hide:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
  .fmtbar-hide svg {
    width: 16px;
    height: 16px;
    display: block;
  }
</style>
