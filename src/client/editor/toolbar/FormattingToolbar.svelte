<script lang="ts">
import "./toolbar-chrome.css";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { yUndoPluginKey } from "y-prosemirror";
import type { TandemNotification } from "../../../shared/types.js";
import { clickOutside } from "../../actions/clickOutside.svelte";
import { createCoalescingTick } from "../../utils/coalescing-tick";
import { ESCAPE_OWNER_ATTR } from "../../utils/escape-owner";
import { focusMenuEntryPoint, handleMenuArrowKeys } from "../../utils/menuKeys";
import { applyLink, getInitialLinkHref, onKeyActivate, withPreventDefault } from "./handlers.js";
import LinkEditor from "./LinkEditor.svelte";
import ToolbarButton from "./ToolbarButton.svelte";

interface Props {
  editor: TiptapEditor | null;
  disabled?: boolean;
  /**
   * "bar" (default) = the persistent floating bar: shows Undo/Redo.
   * "popup" = the selection popup's format pill: omits Undo/Redo (they stay on
   * the bar + Ctrl+Z/Y; the popup mirrors only the mark/block controls).
   */
  variant?: "bar" | "popup";
  /**
   * Channel for a REFUSED link (#1537). `setLink` returns `false` when the
   * render gate rejects the scheme, and without this the Link input would just
   * close and write nothing — a silent no-op where the pre-allowlist behaviour
   * succeeded. Optional so the harness can mount the toolbar bare; both real
   * hosts (`Toolbar`, `FormattingBar`) thread App's `notifications.push`.
   */
  onNotify?: (n: TandemNotification) => void;
}

const { editor, disabled = false, variant = "bar", onNotify }: Props = $props();

// $derived (not a plain const) so it tracks if `variant` ever becomes dynamic.
const showHistory = $derived(variant === "bar");
// A8: the horizontal-rule control stays on the persistent bar but is dropped
// from the selection popup — inserting an <hr> while text is selected makes
// little sense (sanctioned override of Conflict #5 for the popup, 2026-06-03).
const showRule = $derived(variant === "bar");

type HeadingLevel = 1 | 2 | 3;
const HEADING_LEVELS: HeadingLevel[] = [1, 2, 3];
const HEADING_FONT_WEIGHTS: Record<HeadingLevel, number> = { 1: 700, 2: 600, 3: 500 };

// Force-reactive tick — Tiptap's isActive() is imperative; bump on transaction.
let tick = $state(0);
let showHeadingMenu = $state(false);
let headingMenuEl = $state<HTMLDivElement | null>(null);
let showLinkInput = $state(false);
let linkInputValue = $state("");

// Capture `editor` so cleanup `.off()` runs against the instance we attached
// to — the reactive prop getter returns the CURRENT value at cleanup time,
// which is null during tab switch and would throw inside the effect flush.
$effect(() => {
  const ed = editor;
  if (!ed || ed.isDestroyed) return;
  // Deferred: `transaction` is emitted synchronously from ProseMirror's
  // dispatch, including the meta-only transaction a native blur triggers during
  // teardown. Writing $state inside Svelte's active reaction throws
  // state_unsafe_mutation (prod too). See createCoalescingTick.
  const handler = createCoalescingTick(() => {
    if (!ed.isDestroyed) tick++;
  });
  ed.on("transaction", handler);
  return () => {
    if (!ed.isDestroyed) ed.off("transaction", handler);
  };
});

// The trigger sits outside the dropdown, so opening the menu leaves focus on
// the button — and this trigger's mousedown handler preventDefaults, keeping
// focus in the editor entirely. Either way an arrow press would never reach the
// menu's handler unless focus is moved in explicitly, which is what this does.
//
// Deliberately ungated on HOW the menu was opened: tests/e2e/keyboard-a11y.spec.ts
// opens it with `.click()` and asserts focus lands on an item, explicitly
// rejecting a pre-focus shortcut. One consequence, since this menu renders
// inside the selection popup: a mouse-opened menu now holds focus inside the
// popup's Escape-owner subtree, so Escape closes the menu first and the popup
// second (src/client/utils/escape-owner.ts).
$effect(() => {
  if (showHeadingMenu) focusMenuEntryPoint(headingMenuEl);
});

// The single close path, for Escape AND for outside dismissal; without it focus
// falls to <body> when the focused item unmounts. The editor is the right
// destination: the trigger deliberately keeps focus there on the mouse path.
//
// Guarded restore: an outside mousedown (clickOutside fires on mousedown,
// before the browser's own focus transfer) must NOT yank focus into the editor
// when the user was heading somewhere else. Restore only when focus is still
// inside the menu, or has already fallen to <body> because the focused item
// unmounted.
//
// `view.focus()`, NOT `commands.focus()` (#1313). Tiptap's focus COMMAND
// schedules the real `view.focus()` inside a requestAnimationFrame
// (`delayedFocus` — a React workaround), while Svelte unmounts the menu on the
// microtask flush, which lands first. So the guard passed, the restore was
// issued, and focus still fell to <body>: the focused item was torn out before
// the deferred focus arrived. That frame is not free — a throttled or hidden tab
// never runs the callback and the restore is simply lost. ProseMirror's own
// `view.focus()` is synchronous, so focus leaves the menu item BEFORE it
// unmounts and there is no drop to recover from. Nothing is given up: it runs
// `selectionToDOM()`, so the caret returns to where it was (see Toolbar.svelte's
// #768 note), and neither call scrolls — both reach the DOM through
// `focusPreventScroll`. It is also what every other focus restore in
// src/client/ already uses; this call site was the lone `commands.focus()`.
function closeHeadingMenu() {
  const ours =
    (!!headingMenuEl && headingMenuEl.contains(document.activeElement)) ||
    document.activeElement === document.body ||
    document.activeElement === null;
  showHeadingMenu = false;
  if (ours) editor?.view.focus();
}

function findActiveHeading(ed: TiptapEditor): HeadingLevel | null {
  for (const level of HEADING_LEVELS) {
    if (ed.isActive("heading", { level })) return level;
  }
  return null;
}

// Reactive computations depend on editor + tick (transaction counter).
const isEditable = $derived(editor ? editor.isEditable : false);
const isDisabled = $derived(!isEditable || !!disabled);

const undoState = $derived.by(() => {
  void tick;
  return editor ? yUndoPluginKey.getState(editor.state) : null;
});
const canUndo = $derived(!isDisabled && (undoState?.undoManager?.undoStack.length ?? 0) > 0);
const canRedo = $derived(!isDisabled && (undoState?.undoManager?.redoStack.length ?? 0) > 0);

const activeHeading = $derived.by(() => {
  void tick;
  return editor ? findActiveHeading(editor) : null;
});

// Reactive isActive readers
const isActiveBold = $derived.by(() => {
  void tick;
  return !!editor?.isActive("bold");
});
const isActiveItalic = $derived.by(() => {
  void tick;
  return !!editor?.isActive("italic");
});
const isActiveStrike = $derived.by(() => {
  void tick;
  return !!editor?.isActive("strike");
});
const isActiveCode = $derived.by(() => {
  void tick;
  return !!editor?.isActive("code");
});
const isActiveBulletList = $derived.by(() => {
  void tick;
  return !!editor?.isActive("bulletList");
});
const isActiveOrderedList = $derived.by(() => {
  void tick;
  return !!editor?.isActive("orderedList");
});
const isActiveBlockquote = $derived.by(() => {
  void tick;
  return !!editor?.isActive("blockquote");
});
const isActiveCodeBlock = $derived.by(() => {
  void tick;
  return !!editor?.isActive("codeBlock");
});
const isActiveLink = $derived.by(() => {
  void tick;
  return !!editor?.isActive("link");
});
const linkDisabled = $derived.by(() => {
  void tick;
  if (!editor) return true;
  return (
    isDisabled ||
    (!editor.isActive("link") && editor.state.selection.from === editor.state.selection.to)
  );
});

const headingLabel = $derived(activeHeading ? `H${activeHeading}` : "H");

// Hoisted command handlers — prevents event-listener churn on each Tiptap
// transaction (tick++) that would occur with inline lambda props. Mirrors the
// $derived pattern in Toolbar.svelte.
const handleUndo = $derived(withPreventDefault(() => editor?.commands.undo()));
const handleRedo = $derived(withPreventDefault(() => editor?.commands.redo()));
const handleBold = $derived(withPreventDefault(() => editor?.chain().focus().toggleBold().run()));
const handleItalic = $derived(
  withPreventDefault(() => editor?.chain().focus().toggleItalic().run()),
);
const handleStrike = $derived(
  withPreventDefault(() => editor?.chain().focus().toggleStrike().run()),
);
const handleCode = $derived(withPreventDefault(() => editor?.chain().focus().toggleCode().run()));
const handleBulletList = $derived(
  withPreventDefault(() => editor?.chain().focus().toggleBulletList().run()),
);
const handleOrderedList = $derived(
  withPreventDefault(() => editor?.chain().focus().toggleOrderedList().run()),
);
const handleBlockquote = $derived(
  withPreventDefault(() => editor?.chain().focus().toggleBlockquote().run()),
);
const handleHorizontalRule = $derived(
  withPreventDefault(() => editor?.chain().focus().setHorizontalRule().run()),
);
const handleCodeBlock = $derived(
  withPreventDefault(() => editor?.chain().focus().toggleCodeBlock().run()),
);

function handleHeadingToggle(level: HeadingLevel) {
  return (e: MouseEvent) => {
    e.preventDefault();
    if (!editor || editor.isDestroyed) return;
    editor.chain().focus().toggleHeading({ level }).run();
    showHeadingMenu = false;
  };
}

function handleLinkMouseDown(e: MouseEvent) {
  e.preventDefault();
  if (!editor) return;
  linkInputValue = getInitialLinkHref(editor);
  showLinkInput = true;
}

function submitLinkInput() {
  if (!editor) return;
  applyLink(editor, linkInputValue, onNotify);
  dismissLinkInput();
}

function dismissLinkInput() {
  showLinkInput = false;
  linkInputValue = "";
}
</script>

{#if editor}
  <div style="display: flex; align-items: center; gap: 1px;">
    {#if showHistory}
      <ToolbarButton
        ariaLabel="Undo"
        shortcut="Ctrl+Z"
        disabled={!canUndo}
        onMouseDown={handleUndo}
        onClick={onKeyActivate(handleUndo)}
      >
        {#snippet children()}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
          </svg>
        {/snippet}
      </ToolbarButton>
      <ToolbarButton
        ariaLabel="Redo"
        shortcut="Ctrl+Shift+Z"
        disabled={!canRedo}
        onMouseDown={handleRedo}
        onClick={onKeyActivate(handleRedo)}
      >
        {#snippet children()}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
            <path d="m15 14 5-5-5-5" />
            <path d="M20 9H9a5 5 0 0 0 0 10h4" />
          </svg>
        {/snippet}
      </ToolbarButton>
      <div class="tandem-toolbar-sep"></div>
    {/if}

    <ToolbarButton
      label="B"
      shortcut="Ctrl+B"
      disabled={isDisabled}
      active={isActiveBold}
      ariaPressed={isActiveBold}
      onMouseDown={handleBold}
      onClick={onKeyActivate(handleBold)}
      style="font-size: 13px; font-weight: 700;"
    />
    <ToolbarButton
      label="I"
      shortcut="Ctrl+I"
      disabled={isDisabled}
      active={isActiveItalic}
      ariaPressed={isActiveItalic}
      onMouseDown={handleItalic}
      onClick={onKeyActivate(handleItalic)}
      style="font-size: 13px; font-style: italic;"
    />
    <ToolbarButton
      label="S"
      shortcut="Ctrl+Shift+X"
      disabled={isDisabled}
      active={isActiveStrike}
      ariaPressed={isActiveStrike}
      onMouseDown={handleStrike}
      onClick={onKeyActivate(handleStrike)}
      style="font-size: 13px; text-decoration: line-through;"
    />
    <ToolbarButton
      label="<>"
      shortcut="Ctrl+E"
      disabled={isDisabled}
      active={isActiveCode}
      ariaPressed={isActiveCode}
      onMouseDown={handleCode}
      onClick={onKeyActivate(handleCode)}
      style="font-family: var(--tandem-font-mono); font-size: var(--tandem-text-xs); letter-spacing: -0.02em;"
    />

    <!-- Link (A8: stays in the inline-marks group, right after Code). -->
    <!-- Claims Escape while open so Toolbar's capture-phase window listener
         yields to this handler instead of dismissing the selection popup out
         from under it (escape-owner.ts). -->
    <div
      use:clickOutside={dismissLinkInput}
      style="position: relative;"
      {...(showLinkInput ? { [ESCAPE_OWNER_ATTR]: "" } : {})}
      onkeydown={(e) => {
        if (e.key === "Escape") dismissLinkInput();
      }}
      role="presentation"
    >
      <ToolbarButton
        ariaLabel="Link"
        shortcut="Ctrl+K"
        disabled={linkDisabled}
        active={isActiveLink || showLinkInput}
        ariaHasPopup="dialog"
        ariaExpanded={showLinkInput}
        onMouseDown={handleLinkMouseDown}
        onClick={onKeyActivate(handleLinkMouseDown)}
      >
        {#snippet children()}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
            <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
          </svg>
        {/snippet}
      </ToolbarButton>
      <LinkEditor
        open={showLinkInput}
        initialValue={linkInputValue}
        onApply={(value) => {
          linkInputValue = value;
          submitLinkInput();
        }}
        onClose={dismissLinkInput}
        label="Insert link"
      />
    </div>

    <div class="tandem-toolbar-sep"></div>

    <!-- Heading dropdown (A8: leads the block group). -->
    <!-- Claims Escape while open — see the link wrapper above. -->
    <div
      use:clickOutside={closeHeadingMenu}
      style="position: relative;"
      {...(showHeadingMenu ? { [ESCAPE_OWNER_ATTR]: "" } : {})}
      onkeydown={(e) => {
        if (e.key === "Escape") closeHeadingMenu();
      }}
      role="presentation"
    >
      <ToolbarButton
        ariaLabel={activeHeading ? `Heading ${activeHeading}` : "Heading"}
        disabled={isDisabled}
        active={activeHeading !== null}
        ariaHasPopup="menu"
        ariaExpanded={showHeadingMenu}
        style="gap: 2px; padding-right: 4px;"
        onMouseDown={(e: MouseEvent) => {
          e.preventDefault();
          showHeadingMenu = !showHeadingMenu;
        }}
        onClick={onKeyActivate((e: MouseEvent) => {
          e.preventDefault();
          showHeadingMenu = !showHeadingMenu;
        })}
      >
        {#snippet children()}
          <!-- A8: serif "H" (level readout preserved — "H1/2/3" when active) +
               faint caret, matching the bundle's H▾ heading affordance. -->
          <span style="font-family: var(--tandem-font-serif); font-weight: 600; font-size: 13.5px; line-height: 1;"
            >{headingLabel}</span
          >
          <!-- Drawn, not a glyph: U+2304 (the design's caret) is not reliably
               covered by the bundled faces, and a per-glyph fallback silently
               swaps typeface in the packaged WebView. -->
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color: var(--tandem-fg-faint);">
            <path d="M6 9l6 6 6-6" />
          </svg>
        {/snippet}
      </ToolbarButton>
      {#if showHeadingMenu}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          bind:this={headingMenuEl}
          role="menu"
          aria-label="Heading level"
          tabindex="-1"
          onkeydown={handleMenuArrowKeys}
            style="position: absolute; top: 100%; left: 0; margin-top: 8px;
            background: var(--tandem-surface); border: 1px solid var(--tandem-border);
            border-radius: var(--tandem-r-3); padding: 4px; display: flex; flex-direction: column;
            gap: 2px; z-index: var(--tandem-z-dropdown); box-shadow: var(--tandem-shadow-2);"
        >
          <!-- These keep `--tandem-accent-bg` while the bar's toggles moved to
               the pressed idiom, and the difference is the point: a
               `menuitemradio` marks WHICH of a set is current, exactly like the
               theme swatches and the highlight picker's selected chip. A
               depressed key is the wrong metaphor for a one-of-N choice.
               Recorded in ACCENT_SELECTION_INDICATORS in
               tests/design-system-impl/pressed-toggle-state.test.ts, whose
               markup sweep reaches this inline style. -->
          {#each HEADING_LEVELS as level (level)}
            {@const headingHandler = handleHeadingToggle(level)}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={activeHeading === level}
              onmousedown={headingHandler}
              onclick={onKeyActivate(headingHandler)}
                style="padding: 4px 12px; font-size: 13px; border: none;
                border-radius: var(--tandem-r-2);
                background: {activeHeading === level ? 'var(--tandem-accent-bg)' : 'transparent'};
                color: {activeHeading === level ? 'var(--tandem-accent-fg-strong)' : 'var(--tandem-fg)'};
                cursor: pointer; text-align: left;
                font-weight: {HEADING_FONT_WEIGHTS[level]}; white-space: nowrap;"
            >
              Heading {level}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <ToolbarButton
      ariaLabel="Bullet list"
      shortcut="Ctrl+Shift+8"
      disabled={isDisabled}
      active={isActiveBulletList}
      ariaPressed={isActiveBulletList}
      onMouseDown={handleBulletList}
      onClick={onKeyActivate(handleBulletList)}
    >
      {#snippet children()}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <circle cx="4" cy="7" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="4" cy="17" r="1.1" fill="currentColor" stroke="none" />
          <path d="M9 7h11M9 12h11M9 17h11" />
        </svg>
      {/snippet}
    </ToolbarButton>
    <ToolbarButton
      ariaLabel="Ordered list"
      shortcut="Ctrl+Shift+7"
      disabled={isDisabled}
      active={isActiveOrderedList}
      ariaPressed={isActiveOrderedList}
      onMouseDown={handleOrderedList}
      onClick={onKeyActivate(handleOrderedList)}
    >
      {#snippet children()}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <path d="M9 7h11M9 12h11M9 17h11" />
          <path d="M3.4 5.4h1.3V9M3.4 9h2.6" />
          <path d="M3.5 14.4c0-.6.6-1 1.2-1s1.2.4 1.2 1c0 1.1-2.4 1.4-2.4 3h2.6" />
        </svg>
      {/snippet}
    </ToolbarButton>
    <ToolbarButton
      ariaLabel="Blockquote"
      shortcut="Ctrl+Shift+B"
      disabled={isDisabled}
      active={isActiveBlockquote}
      ariaPressed={isActiveBlockquote}
      onMouseDown={handleBlockquote}
      onClick={onKeyActivate(handleBlockquote)}
    >
      {#snippet children()}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 7h4v5c0 2-1 4-3 5M14 7h4v5c0 2-1 4-3 5" />
        </svg>
      {/snippet}
    </ToolbarButton>
    {#if showRule}
      <ToolbarButton
        label="—"
        ariaLabel="Horizontal rule"
        disabled={isDisabled}
        onMouseDown={handleHorizontalRule}
        onClick={onKeyActivate(handleHorizontalRule)}
      />
    {/if}
    <ToolbarButton
      ariaLabel="Code block"
      disabled={isDisabled}
      active={isActiveCodeBlock}
      ariaPressed={isActiveCodeBlock}
      onMouseDown={handleCodeBlock}
      onClick={onKeyActivate(handleCodeBlock)}
    >
      {#snippet children()}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 5c-2.2 0-1.8 5-3.5 7 1.7 2 1.3 7 3.5 7" />
          <path d="M16 5c2.2 0 1.8 5 3.5 7-1.7 2-1.3 7-3.5 7" />
        </svg>
      {/snippet}
    </ToolbarButton>
  </div>
{/if}
