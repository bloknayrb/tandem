<script lang="ts">
import { isTauriRuntime } from "../cowork/cowork-helpers";
import { createRadioGroup } from "../hooks/useRadioGroup.svelte";
import type { EditorMeasure } from "../hooks/useTandemSettings";
import type { SettingsTabContext } from "./SettingsModal.svelte";

type Props = SettingsTabContext;

let { settings, onUpdate, notify }: Props = $props();

const sectionLabelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";

// --- Default save folder (#1023) ------------------------------------------
// Desktop-only: open the native folder picker when running inside Tauri; the
// browser distribution can't pick directories, so the input is the only path
// there (and Save As ignores it anyway — browser Save As is a download).
const isTauri = isTauriRuntime();

function commitSaveDirectory(value: string | null) {
  // mergeAndClampSettings re-normalizes (trim → null), but coerce empty here
  // too so the optimistic UI state matches what gets persisted.
  const trimmed = value?.trim();
  onUpdate({ defaultSaveDirectory: trimmed ? trimmed : null });
}

function handleSaveDirSubmit(e: SubmitEvent) {
  e.preventDefault();
  const input = (e.target as HTMLFormElement).elements.namedItem(
    "default-save-dir",
  ) as HTMLInputElement | null;
  commitSaveDirectory(input?.value ?? null);
}

async function pickSaveFolder() {
  // Mirror SettingsClaudeCodeTab.pickFolder: split import vs open() try-blocks
  // and use fixed-string error toasts (Tauri IPC errors can carry paths).
  let openFn: typeof import("@tauri-apps/plugin-dialog").open;
  try {
    ({ open: openFn } = await import("@tauri-apps/plugin-dialog"));
  } catch (err) {
    console.warn("[Settings] Folder picker import failed:", err);
    notify("error", "Folder picker plugin unavailable");
    return;
  }
  try {
    const selected = await openFn({
      directory: true,
      multiple: false,
      title: "Choose default save folder",
    });
    if (typeof selected === "string") commitSaveDirectory(selected);
  } catch (err) {
    console.warn("[Settings] Folder picker open() failed:", err);
    notify("error", "Folder picker permission denied or IPC error");
  }
}

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

  <div data-testid="settings-default-save-folder" style="margin-top: var(--tandem-space-5);">
    <div style={sectionLabelStyle}>Default Save Folder</div>
    <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-bottom: 8px;">
      Where new files go when you use <strong>Save As</strong> in the desktop app.
      Leave empty to fall back to your AI's working directory, then your home
      folder.
    </div>
    <form
      onsubmit={handleSaveDirSubmit}
      style="display: flex; gap: var(--tandem-space-1); align-items: center;"
    >
      <input
        type="text"
        name="default-save-dir"
        data-testid="settings-default-save-folder-input"
        value={settings.defaultSaveDirectory ?? ""}
        onblur={(e) => commitSaveDirectory((e.currentTarget as HTMLInputElement).value)}
        placeholder="(default: AI working directory, then home)"
        aria-label="Default save folder path"
        style="flex: 1; min-width: 0; padding: 6px 8px; font-size: 11px; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-1); background: var(--tandem-surface); color: var(--tandem-fg);"
      />
      {#if isTauri}
        <button
          type="button"
          data-testid="settings-default-save-folder-pick"
          onclick={pickSaveFolder}
          style="padding: 6px 10px; font-size: 11px; white-space: nowrap; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-1); background: var(--tandem-surface); color: var(--tandem-fg); cursor: pointer;"
        >
          Choose…
        </button>
      {/if}
      <button
        type="button"
        data-testid="settings-default-save-folder-reset"
        onclick={() => commitSaveDirectory(null)}
        disabled={!settings.defaultSaveDirectory}
        style={`padding: 6px 10px; font-size: 11px; white-space: nowrap; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-1); background: transparent; color: var(--tandem-fg-muted); cursor: ${settings.defaultSaveDirectory ? "pointer" : "default"}; opacity: ${settings.defaultSaveDirectory ? 1 : 0.5};`}
      >
        Reset
      </button>
    </form>
  </div>

  <!-- Smart typography (A4) -->
  <div style="margin-top: var(--tandem-space-5);">
    <label
      data-testid="editor-smart-typography"
      style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: var(--tandem-text-sm); color: var(--tandem-fg); min-height: var(--tandem-space-5);"
    >
      <input
        type="checkbox"
        checked={settings.smartTypography}
        onchange={(e) => onUpdate({ smartTypography: (e.target as HTMLInputElement).checked })}
        style="accent-color: var(--tandem-accent);"
      />
      <span>Smart typography</span>
    </label>
    <div
      style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);"
    >
      Convert straight quotes, dashes, and ... to typographic characters as you type.
    </div>
  </div>

  <!-- Spellcheck (A5) -->
  <div style="margin-top: var(--tandem-space-5);">
    <label
      data-testid="editor-spellcheck-toggle"
      style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: var(--tandem-text-sm); color: var(--tandem-fg); min-height: var(--tandem-space-5);"
    >
      <input
        type="checkbox"
        checked={settings.spellcheck}
        onchange={(e) => onUpdate({ spellcheck: (e.target as HTMLInputElement).checked })}
        style="accent-color: var(--tandem-accent);"
      />
      <span>Spellcheck</span>
    </label>
    <div
      style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);"
    >
      Show the browser's spelling underlines while you type.
    </div>
  </div>
</div>
