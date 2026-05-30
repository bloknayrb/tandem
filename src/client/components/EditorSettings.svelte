<script lang="ts">
import { createRadioGroup } from "../hooks/useRadioGroup.svelte";
import type { EditorMeasure } from "../hooks/useTandemSettings";
import type { SettingsTabContext } from "./SettingsModal.svelte";

type Props = SettingsTabContext;

let { settings, onUpdate }: Props = $props();

const sectionLabelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";

const PRESETS: { value: EditorMeasure; label: string; hint: string }[] = [
  { value: "narrow", label: "Narrow", hint: "58 characters" },
  { value: "comfortable", label: "Comfortable", hint: "68 characters" },
  { value: "wide", label: "Wide", hint: "82 characters" },
  { value: "full", label: "Full", hint: "Fills the editor" },
];

const measureRg = createRadioGroup<EditorMeasure>(
  () => settings.editorMeasure,
  PRESETS.map((p) => p.value),
  (next) => onUpdate({ editorMeasure: next }),
);

const activeHint = $derived(PRESETS.find((p) => p.value === settings.editorMeasure)?.hint ?? "");
</script>

<div>
  <div id="settings-measure-label" style={sectionLabelStyle}>Reading Measure</div>
  <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-bottom: 8px;">
    The line length of the editor text. A stable measure keeps lines readable
    regardless of panel state.
  </div>
  <div
    role="radiogroup"
    aria-labelledby="settings-measure-label"
    tabindex="0"
    onkeydown={measureRg.handleKeyDown}
    style="display: flex; gap: var(--tandem-space-1); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2); padding: 2px;"
  >
    {#each PRESETS as preset (preset.value)}
      {@const active = settings.editorMeasure === preset.value}
      <button
        type="button"
        role="radio"
        aria-checked={active}
        tabindex={measureRg.tabIndexFor(preset.value)}
        data-testid={`editor-measure-${preset.value}`}
        onclick={() => onUpdate({ editorMeasure: preset.value })}
        style={`flex: 1; padding: 6px 4px; border: none; border-radius: var(--tandem-r-1); cursor: pointer; font-size: 11px; font-weight: ${active ? 600 : 400}; background: ${active ? "var(--tandem-accent)" : "transparent"}; color: ${active ? "var(--tandem-accent-fg)" : "var(--tandem-fg)"};`}
      >
        {preset.label}
      </button>
    {/each}
  </div>
  <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-top: 6px;">
    {activeHint}
  </div>
</div>
