<script lang="ts">
import { HIGHLIGHT_COLOR_VARS } from "../../../shared/constants";
import type { HighlightColor } from "../../../shared/types";
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
  function handleClickOutside(e: MouseEvent) {
    if (colorPickerEl && !colorPickerEl.contains(e.target as Node)) {
      showColorPicker = false;
    }
  }
  document.addEventListener("mousedown", handleClickOutside);
  return () => document.removeEventListener("mousedown", handleClickOutside);
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

<div style="display: flex; align-items: center; gap: 2px; position: relative;">
  <ToolbarButton
    label="Highlight"
    testId="toolbar-highlight-btn"
    {disabled}
    disabledTitle="Select text first"
    onMouseDown={handleHighlight}
    style="border-radius: var(--tandem-r-2) 0 0 var(--tandem-r-2); border-right: none;"
  />
  <button
    data-testid="toolbar-highlight-color-toggle"
    {disabled}
    onmousedown={handleColorPickerToggle}
    title="Choose highlight color"
    style="padding: 4px 6px; font-size: 13px; border: 1px solid var(--tandem-border);
      border-radius: 0 var(--tandem-r-2) var(--tandem-r-2) 0;
      background: {disabled ? 'var(--tandem-surface-muted)' : 'var(--tandem-surface)'};
      cursor: {disabled ? 'not-allowed' : 'pointer'};
      display: flex; align-items: center;"
  >
    <span
      style="display: inline-block; width: 12px; height: 12px; border-radius: var(--tandem-r-1);
        background: {HIGHLIGHT_COLOR_VARS[highlightColor]};
        border: 1px solid rgba(0,0,0,0.15);"
    ></span>
  </button>
  {#if showColorPicker}
    <div
      bind:this={colorPickerEl}
      style="position: absolute; top: 100%; left: 0; margin-top: 4px;
        background: var(--tandem-surface); border: 1px solid var(--tandem-border);
        border-radius: var(--tandem-r-3); padding: 6px; display: flex; gap: 4px;
        z-index: var(--tandem-z-dropdown); box-shadow: var(--tandem-shadow-2);"
    >
      {#each HIGHLIGHT_COLOR_OPTIONS as { value, label } (value)}
        <button
          data-testid={`toolbar-highlight-color-${value}`}
          title={label}
          aria-label={label}
          onclick={() => handleColorSelect(value)}
          style="width: 24px; height: 24px; border-radius: var(--tandem-r-2);
            border: {value === highlightColor
              ? '2px solid var(--tandem-fg)'
              : '1px solid rgba(0,0,0,0.15)'};
            background: {HIGHLIGHT_COLOR_VARS[value]};
            cursor: pointer; padding: 0;"
        ></button>
      {/each}
      <button
        data-testid="color-picker-close"
        title="Close"
        aria-label="Close color picker"
        onclick={() => (showColorPicker = false)}
        style="width: 24px; height: 24px; border-radius: var(--tandem-r-2);
          border: 1px solid var(--tandem-border);
          background: var(--tandem-surface-muted); cursor: pointer; padding: 0;
          font-size: 13px; color: var(--tandem-fg-muted);
          display: flex; align-items: center; justify-content: center;"
      >
        ✕
      </button>
    </div>
  {/if}
</div>
