<script lang="ts">
import { isTauriRuntime } from "../cowork/cowork-helpers";
import { createRadioGroup } from "../hooks/useRadioGroup.svelte";
import type { EditorFont, EditorMeasure } from "../hooks/useTandemSettings";
import { disabledControlStyle } from "../utils/colors";
import "./settings-card.css";
import type { SettingsTabContext } from "./SettingsModal.svelte";

type Props = SettingsTabContext;

let { settings, onUpdate, notify, readOnly }: Props = $props();

const sectionLabelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";

// #1262: moved from AppearanceSettings — fonts are a property of the
// document surface, not app chrome.
// Callers must also set `class="settings-card"`, which carries the
// border/background cross-fade and its reduced-motion guard (#1530).
function cardStyle(selected: boolean, disabled?: boolean): string {
  return [
    "flex: 1;",
    "padding: var(--tandem-space-2);",
    "min-height: 24px;",
    `border: 2px solid ${selected ? "var(--tandem-accent)" : "var(--tandem-border)"};`,
    "border-radius: var(--tandem-r-3);",
    `background: ${disabled ? "var(--tandem-surface-muted)" : selected ? "var(--tandem-accent-bg)" : "var(--tandem-surface)"};`,
    disabledControlStyle(disabled ?? false),
    "text-align: center;",
    "font-size: 11px;",
    `color: ${disabled ? "var(--tandem-fg-subtle)" : selected ? "var(--tandem-accent-fg-strong)" : "var(--tandem-fg-muted)"};`,
    `font-weight: ${selected ? 600 : 400};`,
  ].join(" ");
}

// #811: per-format editor font. Keyed by the normalized `format` string
// (matches `detectFormat`: `.markdown`→md, `.htm`→html).
const FONT_FORMAT_ROWS = [
  { format: "md", label: "Markdown (.md)" },
  { format: "docx", label: "Word (.docx)" },
  { format: "html", label: "HTML (.html)" },
  { format: "txt", label: "Plain text (.txt)" },
] as const;
const FONT_OPTIONS = [
  ["sans", "Sans"],
  ["serif", "Serif"],
  ["mono", "Mono"],
] as const;

// Effective per-format value shown as the active radio: user override wins,
// else falls through to the global Editor Font setting. Matches the
// post-#887 `resolveFont` contract — no seeded per-format defaults.
function effectiveFontFor(format: string): EditorFont {
  return settings.fontByExtension?.[format] ?? settings.editorFont;
}

function setFontFor(format: string, font: EditorFont): void {
  onUpdate({ fontByExtension: { ...settings.fontByExtension, [format]: font } });
}

function resetFontsToDefaults(): void {
  onUpdate({ fontByExtension: {} });
}

const hasFontOverrides = $derived(Object.keys(settings.fontByExtension ?? {}).length > 0);

const editorFontRg = createRadioGroup<EditorFont>(
  () => settings.editorFont,
  ["sans", "serif", "mono"] as const,
  (f) => onUpdate({ editorFont: f }),
);
// Per-format font radio groups (#811). Each group is its own RG instance so
// arrow-key navigation is scoped to one row at a time. `createRadioGroup`
// querySelectorAll's `[role="radio"]` within the container — the radio
// buttons below already carry that attribute (was missing before #887).
const fontByExtensionRgs: Record<string, ReturnType<typeof createRadioGroup<EditorFont>>> = {};
for (const row of FONT_FORMAT_ROWS) {
  fontByExtensionRgs[row.format] = createRadioGroup<EditorFont>(
    () => effectiveFontFor(row.format),
    ["sans", "serif", "mono"] as const,
    (f) => setFontFor(row.format, f),
  );
}

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
        disabled={readOnly}
        onclick={() => onUpdate({ editorMeasure: preset.value })}
        style={`flex: 1; padding: 6px 4px; border: none; border-radius: var(--tandem-r-1); ${disabledControlStyle(readOnly)} font-size: 11px; font-weight: ${active ? 600 : 400}; background: ${active ? "var(--tandem-accent)" : "transparent"}; color: ${active ? "var(--tandem-accent-fg)" : "var(--tandem-fg)"};`}
      >
        {preset.label}
      </button>
    {/each}
  </div>
  <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-top: 6px;">
    {activeHint}
  </div>

  <!-- Editor Font (#1262: moved from Appearance — a property of the document
       surface, not app chrome) -->
  <div style="margin-top: var(--tandem-space-5);">
    <div id="settings-editor-font-label" style={sectionLabelStyle}>Editor Font</div>
    <div
      role="radiogroup"
      aria-labelledby="settings-editor-font-label"
      tabindex="0"
      onkeydown={editorFontRg.handleKeyDown}
      style="display: flex; gap: var(--tandem-space-2);"
    >
      {#each ([["sans", "Sans-serif"], ["serif", "Serif (Source Serif 4)"], ["mono", "Monospace"]] as const) as [value, label] (value)}
        <button
          data-testid={`editor-font-${value}-btn`}
          role="radio"
          aria-checked={settings.editorFont === value}
          tabindex={editorFontRg.tabIndexFor(value)}
          disabled={readOnly}
          onclick={() => onUpdate({ editorFont: value })}
          class="settings-card"
          style={cardStyle(settings.editorFont === value, readOnly)}
        >
          {label}
        </button>
      {/each}
    </div>
  </div>

  <!-- Default Font by File Type (#811, moved #1262) -->
  <div data-testid="font-by-extension-section" style="margin-top: var(--tandem-space-5);">
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
      <div id="settings-font-by-ext-label" style={`${sectionLabelStyle} margin-bottom: 0;`}>
        Default font by file type
      </div>
      <button
        data-testid="font-by-extension-reset"
        type="button"
        disabled={readOnly || !hasFontOverrides}
        onclick={resetFontsToDefaults}
        style={`background: none; border: none; padding: 0; font-size: var(--tandem-text-2xs); color: ${!readOnly && hasFontOverrides ? "var(--tandem-accent-fg-strong)" : "var(--tandem-fg-subtle)"}; cursor: ${!readOnly && hasFontOverrides ? "pointer" : "not-allowed"}; text-decoration: ${!readOnly && hasFontOverrides ? "underline" : "none"};`}
      >
        Reset to defaults
      </button>
    </div>
    <div style="display: flex; flex-direction: column; gap: var(--tandem-space-2);">
      {#each FONT_FORMAT_ROWS as row (row.format)}
        <div
          data-testid={`font-by-extension-row-${row.format}`}
          style="display: flex; align-items: center; gap: var(--tandem-space-2);"
        >
          <span style="flex: 0 0 7rem; font-size: 11px; color: var(--tandem-fg-muted);">{row.label}</span>
          <div
            role="radiogroup"
            aria-label={`Default font for ${row.label}`}
            tabindex="0"
            onkeydown={fontByExtensionRgs[row.format].handleKeyDown}
            style="display: flex; gap: var(--tandem-space-2); flex: 1;"
          >
            {#each FONT_OPTIONS as [value, label] (value)}
              <button
                data-testid={`font-by-extension-${row.format}-${value}`}
                role="radio"
                aria-checked={effectiveFontFor(row.format) === value}
                tabindex={fontByExtensionRgs[row.format].tabIndexFor(value)}
                disabled={readOnly}
                onclick={() => setFontFor(row.format, value)}
                class="settings-card"
                style={cardStyle(effectiveFontFor(row.format) === value, readOnly)}
              >
                {label}
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
    <div style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
      Each file type uses this font; files with no specific choice fall back to the Editor Font above.
    </div>
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
        disabled={readOnly}
        onblur={(e) => commitSaveDirectory((e.currentTarget as HTMLInputElement).value)}
        placeholder="(default: AI working directory, then home)"
        aria-label="Default save folder path"
        style="flex: 1; min-width: 0; padding: 6px 8px; font-size: 11px; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-1); background: var(--tandem-surface); color: var(--tandem-fg); {disabledControlStyle(readOnly, 'auto')}"
      />
      {#if isTauri}
        <button
          type="button"
          data-testid="settings-default-save-folder-pick"
          disabled={readOnly}
          onclick={pickSaveFolder}
          style="padding: 6px 10px; font-size: 11px; white-space: nowrap; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-1); background: var(--tandem-surface); color: var(--tandem-fg); {disabledControlStyle(readOnly)}"
        >
          Choose…
        </button>
      {/if}
      <button
        type="button"
        data-testid="settings-default-save-folder-reset"
        onclick={() => commitSaveDirectory(null)}
        disabled={readOnly || !settings.defaultSaveDirectory}
        style={`padding: 6px 10px; font-size: 11px; white-space: nowrap; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-1); background: transparent; color: var(--tandem-fg-muted); ${disabledControlStyle(readOnly || !settings.defaultSaveDirectory)}`}
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
        disabled={readOnly}
        onchange={(e) => onUpdate({ smartTypography: (e.target as HTMLInputElement).checked })}
        style="accent-color: var(--tandem-accent); {disabledControlStyle(readOnly)}"
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
        disabled={readOnly}
        onchange={(e) => onUpdate({ spellcheck: (e.target as HTMLInputElement).checked })}
        style="accent-color: var(--tandem-accent); {disabledControlStyle(readOnly)}"
      />
      <span>Spellcheck</span>
    </label>
    <div
      style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);"
    >
      Show the browser's spelling underlines while you type.
    </div>
  </div>

  <!-- Raw markdown passthrough (#981, moved #1262). testid keeps its
       historical "appearance-" prefix — Critical Rule 7 forbids renaming a
       data-testid, since the frozen list in testid-manifest.md is a
       contract, not a snapshot. -->
  <div style="margin-top: var(--tandem-space-5);">
    <label
      data-testid="appearance-show-raw-markdown"
      style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: var(--tandem-text-sm); color: var(--tandem-fg); min-height: var(--tandem-space-5);"
    >
      <input
        type="checkbox"
        checked={settings.showRawMarkdown}
        disabled={readOnly}
        onchange={(e) => onUpdate({ showRawMarkdown: (e.target as HTMLInputElement).checked })}
        style="accent-color: var(--tandem-accent); {disabledControlStyle(readOnly)}"
      />
      <span>Show raw markdown</span>
    </label>
    <div style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
      Footnotes, reference-style links, and inline HTML that Tandem keeps as raw source.
      When hidden they stay in the file and always save — only the on-screen markers are
      hidden.
    </div>
  </div>
</div>
