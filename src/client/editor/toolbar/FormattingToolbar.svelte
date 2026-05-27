<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { yUndoPluginKey } from "y-prosemirror";
import { clickOutside } from "../../actions/clickOutside.svelte";
import { applyLink, getInitialLinkHref, withPreventDefault } from "./handlers.js";
import ToolbarButton from "./ToolbarButton.svelte";

interface Props {
  editor: TiptapEditor | null;
  disabled?: boolean;
}

const { editor, disabled = false }: Props = $props();

type HeadingLevel = 1 | 2 | 3;
const HEADING_LEVELS: HeadingLevel[] = [1, 2, 3];
const HEADING_FONT_WEIGHTS: Record<HeadingLevel, number> = { 1: 700, 2: 600, 3: 500 };

// Force-reactive tick — Tiptap's isActive() is imperative; bump on transaction.
let tick = $state(0);
let showHeadingMenu = $state(false);
let showLinkInput = $state(false);
let linkInputValue = $state("");
let linkInputEl = $state<HTMLInputElement | null>(null);

// Capture `editor` so cleanup `.off()` runs against the instance we attached
// to — the reactive prop getter returns the CURRENT value at cleanup time,
// which is null during tab switch and would throw inside the effect flush.
$effect(() => {
  const ed = editor;
  if (!ed || ed.isDestroyed) return;
  const handler = () => {
    if (!ed.isDestroyed) tick++;
  };
  ed.on("transaction", handler);
  return () => {
    if (!ed.isDestroyed) ed.off("transaction", handler);
  };
});

$effect(() => {
  if (showLinkInput) {
    linkInputEl?.focus();
    linkInputEl?.select();
  }
});

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

// Keyboard activation: Enter/Space on a focused button fires `click` with
// detail === 0. The mouse path uses `mousedown` so the editor selection
// survives. Pair onMouseDown (mouse) with onClick={onKeyActivate(...)}
// (keyboard, filtered on detail===0) so both routes work without double-firing.
function onKeyActivate(handler: (e: MouseEvent) => void) {
  return (e: MouseEvent) => {
    if (e.detail === 0) handler(e);
  };
}

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
  applyLink(editor, linkInputValue);
  dismissLinkInput();
}

function dismissLinkInput() {
  showLinkInput = false;
  linkInputValue = "";
}

function handleLinkInputKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    submitLinkInput();
  } else if (e.key === "Escape") {
    e.preventDefault();
    dismissLinkInput();
  }
}
</script>

{#if editor}
  <div style="display: flex; align-items: center; gap: 2px;">
    <ToolbarButton
      ariaLabel="Undo"
      shortcut="Ctrl+Z"
      disabled={!canUndo}
      onMouseDown={handleUndo}
      onClick={onKeyActivate(handleUndo)}
      style="min-width: 30px; padding: 4px 6px;"
    >
      {#snippet children()}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 7L1 4l3-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M1 4h9a5 5 0 0 1 0 10H7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      {/snippet}
    </ToolbarButton>
    <ToolbarButton
      ariaLabel="Redo"
      shortcut="Ctrl+Shift+Z"
      disabled={!canRedo}
      onMouseDown={handleRedo}
      onClick={onKeyActivate(handleRedo)}
      style="min-width: 30px; padding: 4px 6px;"
    >
      {#snippet children()}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 7l3-3-3-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M15 4H6a5 5 0 0 0 0 10h3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      {/snippet}
    </ToolbarButton>
    <div style="width: 1px; height: 16px; background: var(--tandem-border); margin: 0 2px;"></div>

    <ToolbarButton
      label="B"
      shortcut="Ctrl+B"
      disabled={isDisabled}
      active={isActiveBold}
      onMouseDown={handleBold}
      onClick={onKeyActivate(handleBold)}
      style="font-weight: 700; min-width: 30px;"
    />
    <ToolbarButton
      label="I"
      shortcut="Ctrl+I"
      disabled={isDisabled}
      active={isActiveItalic}
      onMouseDown={handleItalic}
      onClick={onKeyActivate(handleItalic)}
      style="font-style: italic; min-width: 30px;"
    />
    <ToolbarButton
      label="S"
      shortcut="Ctrl+Shift+X"
      disabled={isDisabled}
      active={isActiveStrike}
      onMouseDown={handleStrike}
      onClick={onKeyActivate(handleStrike)}
      style="text-decoration: line-through; min-width: 30px;"
    />
    <ToolbarButton
      label="<>"
      shortcut="Ctrl+E"
      disabled={isDisabled}
      active={isActiveCode}
      onMouseDown={handleCode}
      onClick={onKeyActivate(handleCode)}
      style="font-family: monospace; min-width: 30px;"
    />

    <!-- Heading dropdown -->
    <div
      use:clickOutside={() => (showHeadingMenu = false)}
      style="position: relative;"
      onkeydown={(e) => {
        if (e.key === "Escape") showHeadingMenu = false;
      }}
      role="presentation"
    >
      <ToolbarButton
        label={headingLabel}
        disabled={isDisabled}
        active={activeHeading !== null}
        ariaHasPopup="menu"
        ariaExpanded={showHeadingMenu}
        onMouseDown={(e: MouseEvent) => {
          e.preventDefault();
          showHeadingMenu = !showHeadingMenu;
        }}
        onClick={onKeyActivate((e: MouseEvent) => {
          e.preventDefault();
          showHeadingMenu = !showHeadingMenu;
        })}
        style="min-width: 30px;"
      />
      {#if showHeadingMenu}
        <div
          role="menu"
          aria-label="Heading level"
            style="position: absolute; top: 100%; left: 0; margin-top: 4px;
            background: var(--tandem-surface); border: 1px solid var(--tandem-border);
            border-radius: var(--tandem-r-3); padding: 4px; display: flex; flex-direction: column;
            gap: 2px; z-index: var(--tandem-z-dropdown); box-shadow: var(--tandem-shadow-1);"
        >
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
                color: {activeHeading === level ? 'var(--tandem-accent)' : 'var(--tandem-fg)'};
                cursor: pointer; text-align: left;
                font-weight: {HEADING_FONT_WEIGHTS[level]}; white-space: nowrap;"
            >
              Heading {level}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div style="width: 1px; height: 16px; background: var(--tandem-border); margin: 0 2px;"></div>

    <ToolbarButton
      ariaLabel="Bullet list"
      shortcut="Ctrl+Shift+8"
      disabled={isDisabled}
      active={isActiveBulletList}
      onMouseDown={handleBulletList}
      onClick={onKeyActivate(handleBulletList)}
      style="min-width: 30px; padding: 4px 6px;"
    >
      {#snippet children()}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <circle cx="2" cy="4" r="1.5" fill="currentColor" />
          <circle cx="2" cy="8" r="1.5" fill="currentColor" />
          <circle cx="2" cy="12" r="1.5" fill="currentColor" />
          <rect x="5" y="3" width="9" height="2" rx="1" fill="currentColor" />
          <rect x="5" y="7" width="9" height="2" rx="1" fill="currentColor" />
          <rect x="5" y="11" width="9" height="2" rx="1" fill="currentColor" />
        </svg>
      {/snippet}
    </ToolbarButton>
    <ToolbarButton
      ariaLabel="Ordered list"
      shortcut="Ctrl+Shift+7"
      disabled={isDisabled}
      active={isActiveOrderedList}
      onMouseDown={handleOrderedList}
      onClick={onKeyActivate(handleOrderedList)}
      style="min-width: 30px; padding: 4px 6px;"
    >
      {#snippet children()}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <rect x="5" y="3" width="9" height="2" rx="1" fill="currentColor" />
          <rect x="5" y="7" width="9" height="2" rx="1" fill="currentColor" />
          <rect x="5" y="11" width="9" height="2" rx="1" fill="currentColor" />
          <text x="0" y="5.5" font-size="4.5" fill="currentColor" font-family="monospace" font-weight="bold">1.</text>
          <text x="0" y="9.5" font-size="4.5" fill="currentColor" font-family="monospace" font-weight="bold">2.</text>
          <text x="0" y="13.5" font-size="4.5" fill="currentColor" font-family="monospace" font-weight="bold">3.</text>
        </svg>
      {/snippet}
    </ToolbarButton>
    <ToolbarButton
      ariaLabel="Blockquote"
      shortcut="Ctrl+Shift+B"
      disabled={isDisabled}
      active={isActiveBlockquote}
      onMouseDown={handleBlockquote}
      onClick={onKeyActivate(handleBlockquote)}
      style="min-width: 30px; padding: 4px 6px;"
    >
      {#snippet children()}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <rect x="0" y="2" width="3" height="12" rx="1.5" fill="currentColor" />
          <rect x="5" y="4" width="9" height="2" rx="1" fill="currentColor" opacity="0.7" />
          <rect x="5" y="8" width="7" height="2" rx="1" fill="currentColor" opacity="0.7" />
          <rect x="5" y="12" width="8" height="2" rx="1" fill="currentColor" opacity="0.7" />
        </svg>
      {/snippet}
    </ToolbarButton>

    <div style="width: 1px; height: 16px; background: var(--tandem-border); margin: 0 2px;"></div>

    <div
      use:clickOutside={dismissLinkInput}
      style="position: relative;"
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
        style="min-width: 30px; padding: 4px 6px;"
      >
        {#snippet children()}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
            <path d="M6.5 8.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5l-1 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M9.5 7.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        {/snippet}
      </ToolbarButton>
      {#if showLinkInput}
        <div
          role="dialog"
          aria-label="Insert link"
          style="position: absolute; top: 100%; left: 0; margin-top: 4px;
            background: var(--tandem-surface); border: 1px solid var(--tandem-border);
            border-radius: var(--tandem-r-3); padding: 6px;
            display: flex; align-items: center; gap: 4px;
            z-index: var(--tandem-z-dropdown); box-shadow: var(--tandem-shadow-1); min-width: 240px;"
        >
          <input
            bind:this={linkInputEl}
            bind:value={linkInputValue}
            data-testid="toolbar-link-input"
            type="url"
            placeholder="https://"
            onkeydown={handleLinkInputKeyDown}
            style="flex: 1; height: 26px; padding: 2px 6px; font-size: 12px;
              border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2);
              background: var(--tandem-surface); color: var(--tandem-fg);
              outline: none; font-family: inherit;"
          />
          <button
            type="button"
            data-testid="toolbar-link-submit"
            onmousedown={(e) => { e.preventDefault(); submitLinkInput(); }}
            onclick={onKeyActivate((e) => { e.preventDefault(); submitLinkInput(); })}
            style="height: 26px; padding: 0 8px; font-size: 12px; font-weight: 500;
              border: 1px solid var(--tandem-accent-border); background: transparent;
              color: var(--tandem-accent); border-radius: var(--tandem-r-2); cursor: pointer;
              white-space: nowrap;"
          >Apply</button>
          <button
            type="button"
            data-testid="toolbar-link-cancel"
            onmousedown={(e) => { e.preventDefault(); dismissLinkInput(); }}
            onclick={onKeyActivate((e) => { e.preventDefault(); dismissLinkInput(); })}
            style="height: 26px; padding: 0 8px; font-size: 12px; font-weight: 500;
              border: 1px solid var(--tandem-border); background: transparent;
              color: var(--tandem-fg-muted); border-radius: var(--tandem-r-2); cursor: pointer;"
          >Cancel</button>
        </div>
      {/if}
    </div>
    <ToolbarButton
      label="—"
      ariaLabel="Horizontal rule"
      disabled={isDisabled}
      onMouseDown={handleHorizontalRule}
      onClick={onKeyActivate(handleHorizontalRule)}
      style="min-width: 30px;"
    />
    <ToolbarButton
      ariaLabel="Code block"
      disabled={isDisabled}
      active={isActiveCodeBlock}
      onMouseDown={handleCodeBlock}
      onClick={onKeyActivate(handleCodeBlock)}
      style="min-width: 30px; padding: 4px 6px;"
    >
      {#snippet children()}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <path d="M5 4L1 8l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M11 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M9 2l-2 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      {/snippet}
    </ToolbarButton>
  </div>
{/if}
