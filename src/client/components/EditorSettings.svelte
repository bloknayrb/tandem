<script lang="ts">
import type { SettingsTabContext } from "./SettingsModal.svelte";

type Props = SettingsTabContext;

let { settings, onUpdate }: Props = $props();

const sectionLabelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";
</script>

<div>
  <div style={sectionLabelStyle}>
    Editor Width:
    <span style="font-weight: 400; text-transform: none;">
      {settings.editorWidthPercent}%
    </span>
  </div>
  <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-bottom: 6px;">
    How much of the available space the editor text fills
  </div>
  <input
    data-testid="editor-width-slider"
    type="range"
    min={40}
    max={100}
    step={5}
    value={settings.editorWidthPercent}
    oninput={(e) => onUpdate({ editorWidthPercent: Number((e.target as HTMLInputElement).value) })}
    style="width: 100%; accent-color: var(--tandem-accent);"
    aria-label="Editor width"
  />
  <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--tandem-fg-subtle);">
    <span>40%</span>
    <span>100%</span>
  </div>
</div>
