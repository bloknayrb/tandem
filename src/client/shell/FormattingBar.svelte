<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import * as Y from "yjs";
import { toPmPos } from "../../shared/positions/types";
import type { HighlightColor } from "../../shared/types";
import FormattingToolbar from "../editor/toolbar/FormattingToolbar.svelte";
import HighlightColorPicker from "../editor/toolbar/HighlightColorPicker.svelte";
import { toggleHighlight } from "../editor/toolbar/highlight-toggle";
import { pmPosToFlatOffset } from "../positions";
import { createCoalescingTick } from "../utils/coalescing-tick";
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
  /** Whether the active document is displaying its raw Markdown source. */
  sourceViewActive?: boolean;
  /** Toggle source view. Omitted for formats/read-only documents that cannot use it. */
  onToggleSourceView?: (() => void) | null;
  /**
   * 1.11: hide the persistent bar (sets `formattingBarVisible: false`). When
   * provided, a trailing collapse control renders. Restoring is via the
   * "show formatting bar" button in the selection popup (the symmetric
   * affordance), the command palette, or Appearance settings.
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
  sourceViewActive = false,
  onToggleSourceView = null,
  onHide,
}: Props = $props();

// Force-reactive tick — mirrors FormattingToolbar's pattern so that
// canHighlight reflects the live selection state, not just editor existence.
let _tick = $state(0);
$effect(() => {
  const ed = editor;
  if (!ed || ed.isDestroyed) return;
  // Deferred: `transaction` fires synchronously from ProseMirror's dispatch,
  // including the blur-meta transaction emitted while the DOM is being torn
  // down. Writing $state inside Svelte's active reaction throws
  // state_unsafe_mutation (prod too). See createCoalescingTick.
  const handler = createCoalescingTick(() => {
    if (!ed.isDestroyed) _tick++;
  });
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
  data-testid="formatting-bar-wrap"
  style="position: fixed; top: var(--tandem-fmtbar-top, 52px); left: 0; right: 0; display: flex; justify-content: center; pointer-events: none;"
>
  <div
    data-testid="formatting-bar"
    class="tandem-floating-pill"
    style="display: inline-flex; align-items: center; padding: var(--tandem-space-1); user-select: none; pointer-events: auto; -webkit-app-region: no-drag; max-width: calc(100% - var(--tandem-space-6));"
  >
    <!-- The format controls live in a clipped track so a narrow window
         truncates buttons rather than wrapping. The Decorations split button is
         intentionally OUTSIDE that track: it must never truncate.

         The axis split is load-bearing (#1302). This was `overflow: hidden`,
         which clips BOTH axes — and the heading menu, highlight color picker
         and link editor are `position: absolute` popovers inside this track, so
         they were clipped out of existence: the trigger fired and
         `aria-expanded` flipped, but the menu painted below the clip edge and
         `elementFromPoint` at a menu item resolved to the editor underneath.
         `clip` rather than `hidden` because a `visible` paired with `hidden`
         computes to `auto` (CSS Overflow 3), which would make this a scroll
         container and clip vertically anyway, whereas `visible` paired with
         `clip` is preserved as specified. That rule is symmetric, and it is the
         tripwire here: setting EITHER axis to a scrollable value silently
         computes the other's `visible` to `auto` and its `clip` to `hidden`, so
         changing `overflow-y` alone re-clips the popovers with no diff on the
         `clip` line.

         Horizontal truncation behaves identically to `hidden` for this box
         (verified: same track width, no wrapping, buttons past the edge
         unhittable). The one behavioural difference is a real trade, not a pure
         win: `clip` creates no scroll container, so a truncated control that
         receives keyboard focus can no longer be scrolled into view. Measured:
         with `hidden`, focusing a clipped button scrolled the track (scrollLeft
         171) and made it hittable; with `clip` it stays invisible and
         unhittable. That only bites where the track actually truncates — at
         viewport widths <= 640px — which the desktop app cannot reach
         (tauri.conf.json minWidth is 800), so it is confined to the browser
         distribution at narrow widths. Accepted because the alternative is
         keeping three popovers unusable for everyone; revisit if the bar ever
         gains a genuinely narrow target. Requires Chrome 90 / Safari 16 /
         Firefox 81; the project already targets safari16.4. -->
    <div
      data-testid="formatting-bar-track"
      style="display: flex; align-items: center; gap: 1px; overflow-x: clip; overflow-y: visible; min-width: 0;"
    >
      <FormattingToolbar {editor} />
      <div class="fmtbar-divider"></div>
      <HighlightColorPicker disabled={!canHighlight} onHighlight={handleHighlight} />
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
    {#if onToggleSourceView}
      <div class="fmtbar-divider"></div>
      <button
        type="button"
        class="fmtbar-source"
        class:on={sourceViewActive}
        data-testid="formatbar-source-toggle"
        aria-label={sourceViewActive ? "Return to formatted editor" : "View Markdown source"}
        aria-pressed={sourceViewActive}
        title={sourceViewActive ? "Return to formatted editor" : "View Markdown source"}
        onclick={onToggleSourceView}
      >
        <span aria-hidden="true">&lt;/&gt;</span>
      </button>
    {/if}
    {#if onHide}
      <!-- Outside the clipped track so it never truncates. Hiding the
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
  /* #1024/#1036: the bar is a fixed wrapper that creates its own stacking
     context at --tandem-z-sticky, BELOW the selection popup at
     --tandem-z-modal. A dropdown opened from the bar is trapped in that
     context, so it would paint behind the selection pill. Lift the whole
     wrapper while any popover inside it is open.

     Keyed on `aria-expanded` rather than on per-popover props (#1302). All four
     popovers the bar owns publish that state for assistive tech — heading menu
     and link editor (via ToolbarButton), Decorations menu, and the highlight
     sub-menu, whose attribute was added in #1302 precisely so this rule covers
     it too. The previous version was an inline ternary wired to the highlight
     sub-menu alone and silently did not cover the other three; an enumerated
     list of popovers is exactly the thing that goes stale when the fifth one is
     added. Must live here rather than in the inline style attribute, which
     would outrank it regardless of specificity. */
  .tandem-fmtbar-wrap {
    z-index: var(--tandem-z-sticky);
  }
  /* `:global()` inside `:has()` because the expanded state is set at runtime on
     descendants owned by child components; Svelte's CSS pruner cannot prove the
     match and would drop this rule as unused, which `svelte-check
     --fail-on-warnings` turns into a build failure.

     Support note, because the overflow comment above states a floor and this is
     the HIGHER one: `:has()` needs Chrome 105 / Safari 15.4 / Firefox 121, and
     that Firefox floor sits above the declared `firefox114` cssTarget.
     Acceptable because the shipped surfaces are WebView2 and WKWebView and the
     browser distribution is deprecated (#477 PR 2) — and because a non-matching
     `:has()` degrades to the un-lifted z-index (dropdown paints behind the
     selection pill) rather than to a broken bar. */
  .tandem-fmtbar-wrap:has(:global([aria-expanded="true"])) {
    z-index: var(--tandem-z-toast);
  }
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
  .fmtbar-source {
    height: 26px;
    min-width: 32px;
    padding: 0 7px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--tandem-fg-muted);
    border-radius: var(--tandem-r-pill);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    font-family: var(--tandem-font-mono);
    font-size: 11px;
    font-weight: 600;
    transition: background 120ms, border-color 120ms, color 120ms;
  }
  .fmtbar-source:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .fmtbar-source.on {
    background: var(--tandem-accent-bg);
    border-color: var(--tandem-accent-border);
    color: var(--tandem-accent-fg-strong, var(--tandem-accent));
  }
  .fmtbar-source:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
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
