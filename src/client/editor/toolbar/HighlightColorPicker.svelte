<script lang="ts">
import { HIGHLIGHT_COLOR_VARS } from "../../../shared/constants";
import type { HighlightColor } from "../../../shared/types";
import { onOutsideEvent } from "../../utils/dismiss-outside";
import ToolbarButton from "./ToolbarButton.svelte";

const HIGHLIGHT_COLOR_OPTIONS: Array<{ value: HighlightColor; label: string }> = [
  { value: "yellow", label: "Yellow" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
  { value: "pink", label: "Pink" },
];

interface Props {
  disabled?: boolean;
  onHighlight: (color: HighlightColor) => void;
  /**
   * Fired whenever the color sub-menu opens or closes. The host (FormattingBar)
   * uses this to lift its fixed wrapper's stacking context above the selection
   * popup while the sub-menu is open — otherwise the open sub-menu, trapped in
   * the bar's lower stacking context, renders behind the selection pill (#1024).
   */
  onOpenChange?: (open: boolean) => void;
}

const { disabled = false, onHighlight, onOpenChange }: Props = $props();

let highlightColor = $state<HighlightColor>("yellow");
let showColorPicker = $state(false);
let colorPickerEl = $state<HTMLDivElement | null>(null);

$effect(() => {
  onOpenChange?.(showColorPicker);
});

$effect(() => {
  if (!showColorPicker) return;
  return onOutsideEvent(
    () => colorPickerEl,
    ["mousedown"],
    () => {
      showColorPicker = false;
    },
    { capture: false },
  );
});

function handleHighlight(e: MouseEvent) {
  e.preventDefault();
  onHighlight(highlightColor);
}

function handleColorPickerToggle(e: MouseEvent) {
  e.preventDefault();
  showColorPicker = !showColorPicker;
}

function handleColorSelect(color: HighlightColor) {
  highlightColor = color;
  showColorPicker = false;
}
</script>

<div class="highlight-picker-wrap">
  <ToolbarButton
    label="Highlight"
    testId="toolbar-highlight-btn"
    {disabled}
    disabledTitle="Select text first"
    onMouseDown={handleHighlight}
  />
  <button
    type="button"
    class="highlight-swatch-toggle"
    data-testid="toolbar-highlight-color-toggle"
    {disabled}
    onmousedown={handleColorPickerToggle}
    title="Choose highlight color"
  >
    <span
      class="highlight-swatch-preview"
      style="background: {HIGHLIGHT_COLOR_VARS[highlightColor]};"
    ></span>
  </button>
  {#if showColorPicker}
    <div
      bind:this={colorPickerEl}
      class="highlight-picker-popover"
    >
      {#each HIGHLIGHT_COLOR_OPTIONS as { value, label } (value)}
        <button
          type="button"
          data-testid={`toolbar-highlight-color-${value}`}
          title={label}
          aria-label={label}
          onclick={() => handleColorSelect(value)}
          class="highlight-picker-swatch"
          class:is-selected={value === highlightColor}
        >
          <span
            class="highlight-picker-swatch-inner"
            style="background: {HIGHLIGHT_COLOR_VARS[value]};"
          ></span>
          <svg
            class="highlight-picker-swatch-check"
            width="10"
            height="10"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M5 11l3 3 7-9" />
          </svg>
        </button>
      {/each}
      <button
        type="button"
        data-testid="color-picker-close"
        title="Close"
        aria-label="Close color picker"
        onclick={() => (showColorPicker = false)}
        class="highlight-picker-close"
      >
        ✕
      </button>
    </div>
  {/if}
</div>

<style>
  .highlight-picker-wrap {
    display: flex;
    align-items: center;
    gap: 1px;
    position: relative;
  }
  .highlight-swatch-toggle {
    height: 26px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: var(--tandem-r-pill);
    background: transparent;
    color: var(--tandem-fg-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    transition: background 120ms, color 120ms;
  }
  .highlight-swatch-toggle:hover:not(:disabled) {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .highlight-swatch-toggle:disabled {
    cursor: not-allowed;
  }
  .highlight-swatch-toggle:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
  .highlight-swatch-preview {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: var(--tandem-r-1);
    border: 1px solid var(--tandem-border);
  }
  .highlight-picker-popover {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 8px;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-4);
    padding: 6px;
    display: flex;
    gap: 4px;
    align-items: center;
    z-index: var(--tandem-z-dropdown);
    box-shadow: var(--tandem-shadow-2);
  }
  /* Top-pointing caret — two stacked triangles for a crisp 1px border edge:
     ::before paints the border-colored caret, ::after overlays the surface-
     colored caret 1px lower to mask the bottom edge. */
  .highlight-picker-popover::before,
  .highlight-picker-popover::after {
    content: "";
    position: absolute;
    left: 12px;
    border: 5px solid transparent;
  }
  .highlight-picker-popover::before {
    bottom: 100%;
    border-bottom-color: var(--tandem-border);
  }
  .highlight-picker-popover::after {
    bottom: calc(100% - 1px);
    border-bottom-color: var(--tandem-surface);
  }
  .highlight-picker-swatch {
    position: relative;
    width: 24px;
    height: 24px;
    border-radius: var(--tandem-r-2);
    border: 1.5px solid transparent;
    background: transparent;
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: transform 100ms, box-shadow 100ms, border-color 100ms;
  }
  .highlight-picker-swatch-inner {
    display: block;
    width: 20px;
    height: 20px;
    border-radius: var(--tandem-r-1);
  }
  .highlight-picker-swatch:hover:not(.is-selected) {
    border-color: var(--tandem-border);
    transform: scale(1.12);
    box-shadow: var(--tandem-shadow-1);
  }
  .highlight-picker-swatch.is-selected {
    border-color: var(--tandem-border-strong);
    box-shadow:
      0 0 0 2px var(--tandem-accent-bg),
      0 0 0 3.5px var(--tandem-accent);
  }
  .highlight-picker-swatch.is-selected:hover {
    transform: scale(1.06);
  }
  .highlight-picker-swatch-check {
    position: absolute;
    color: var(--tandem-fg);
    pointer-events: none;
    opacity: 0;
    transition: opacity 100ms;
  }
  .highlight-picker-swatch.is-selected .highlight-picker-swatch-check {
    opacity: 1;
  }
  .highlight-picker-close {
    width: 24px;
    height: 24px;
    border-radius: var(--tandem-r-2);
    border: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted);
    cursor: pointer;
    padding: 0;
    font-size: 13px;
    color: var(--tandem-fg-muted);
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
