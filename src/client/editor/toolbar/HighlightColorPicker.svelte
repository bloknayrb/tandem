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
}

const { disabled = false, onHighlight }: Props = $props();

let highlightColor = $state<HighlightColor>("yellow");
let showColorPicker = $state(false);
let colorPickerEl = $state<HTMLDivElement | null>(null);

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
          style="background: {HIGHLIGHT_COLOR_VARS[value]};"
        ></button>
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
    margin-top: 4px;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
    padding: 6px;
    display: flex;
    gap: 4px;
    z-index: var(--tandem-z-dropdown);
    box-shadow: var(--tandem-shadow-2);
  }
  .highlight-picker-swatch {
    width: 24px;
    height: 24px;
    border-radius: var(--tandem-r-2);
    border: 1px solid var(--tandem-border);
    cursor: pointer;
    padding: 0;
  }
  .highlight-picker-swatch.is-selected {
    border: 2px solid var(--tandem-fg);
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
