<script lang="ts">
import { createRadioGroup } from "../hooks/useRadioGroup.svelte";
import type {
  Density,
  EditorFont,
  PrimaryTab,
  TextSize,
  ThemePreference,
} from "../hooks/useTandemSettings.svelte";
import type { SettingsTabContext } from "./SettingsModal.svelte";

type Props = SettingsTabContext;

let { settings, onUpdate }: Props = $props();

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

const sectionLabelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";

// Decorations mirror group (1.13): [settings field, testid, label]. Mirrors the
// title-bar Decorations control; editing any row auto-unmutes the master overlay.
const DECORATION_ROWS = [
  ["showAuthorship", "appearance-show-authorship", "Authorship colors"],
  ["showComments", "appearance-show-comments", "Comments"],
  ["showHighlights", "appearance-show-highlights", "Highlights"],
  ["showNotes", "appearance-show-notes", "Notes (private)"],
] as const;

function cardStyle(selected: boolean, disabled?: boolean): string {
  return [
    "flex: 1;",
    "padding: var(--tandem-space-2);",
    "min-height: 24px;",
    `border: 2px solid ${selected ? "var(--tandem-accent)" : "var(--tandem-border)"};`,
    "border-radius: var(--tandem-r-3);",
    `background: ${disabled ? "var(--tandem-surface-muted)" : selected ? "var(--tandem-accent-bg)" : "var(--tandem-surface)"};`,
    `cursor: ${disabled ? "not-allowed" : "pointer"};`,
    "text-align: center;",
    "font-size: 11px;",
    `color: ${disabled ? "var(--tandem-fg-subtle)" : selected ? "var(--tandem-accent-fg-strong)" : "var(--tandem-fg-muted)"};`,
    `font-weight: ${selected ? 600 : 400};`,
    `opacity: ${disabled ? 0.6 : 1};`,
    "transition: border-color 0.15s, background 0.15s;",
  ].join(" ");
}

const themeRg = createRadioGroup<ThemePreference>(
  () => settings.theme,
  ["light", "warm", "dark", "system"] as const,
  (t) => onUpdate({ theme: t }),
);
const primaryTabRg = createRadioGroup<PrimaryTab>(
  () => settings.primaryTab,
  ["chat", "annotations"] as const,
  (p) => onUpdate({ primaryTab: p }),
);
const textSizeRg = createRadioGroup<TextSize>(
  () => settings.textSize,
  ["s", "m", "l"] as const,
  (t) => onUpdate({ textSize: t }),
);
const editorFontRg = createRadioGroup<EditorFont>(
  () => settings.editorFont,
  ["sans", "serif", "mono"] as const,
  (f) => onUpdate({ editorFont: f }),
);
const densityRg = createRadioGroup<Density>(
  () => settings.density,
  ["compact", "cozy", "spacious"] as const,
  (d) => onUpdate({ density: d }),
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
</script>

<!-- Theme -->
<div>
  <div id="settings-theme-label" style={sectionLabelStyle}>Theme</div>
  <div
    role="radiogroup"
    aria-labelledby="settings-theme-label"
    tabindex="0"
    onkeydown={themeRg.handleKeyDown}
    style="display: flex; gap: var(--tandem-space-2);"
  >
    {#each (["light", "warm", "dark", "system"] as const) as t (t)}
      <button
        data-testid={`theme-${t}-btn`}
        role="radio"
        aria-checked={settings.theme === t}
        tabindex={themeRg.tabIndexFor(t)}
        onclick={() => onUpdate({ theme: t })}
        style={cardStyle(settings.theme === t)}
      >
        {t === "light" ? "Light" : t === "warm" ? "Warm" : t === "dark" ? "Dark" : "System"}
      </button>
    {/each}
  </div>
</div>

<!-- Default Tab -->
<div>
  <div id="settings-default-tab-label" style={sectionLabelStyle}>Default Tab</div>
  <div
    role="radiogroup"
    aria-labelledby="settings-default-tab-label"
    tabindex="0"
    onkeydown={primaryTabRg.handleKeyDown}
    style="display: flex; gap: var(--tandem-space-2);"
  >
    <button
      data-testid="default-tab-chat-btn"
      role="radio"
      aria-checked={settings.primaryTab === "chat"}
      tabindex={primaryTabRg.tabIndexFor("chat")}
      onclick={() => onUpdate({ primaryTab: "chat" })}
      style={cardStyle(settings.primaryTab === "chat")}
    >
      Chat
    </button>
    <button
      data-testid="default-tab-annotations-btn"
      role="radio"
      aria-checked={settings.primaryTab === "annotations"}
      tabindex={primaryTabRg.tabIndexFor("annotations")}
      onclick={() => onUpdate({ primaryTab: "annotations" })}
      style={cardStyle(settings.primaryTab === "annotations")}
    >
      Annotations
    </button>
  </div>
</div>


<!-- Text Size -->
<div>
  <div id="settings-text-size-label" style={sectionLabelStyle}>Text Size</div>
  <div
    role="radiogroup"
    aria-labelledby="settings-text-size-label"
    tabindex="0"
    onkeydown={textSizeRg.handleKeyDown}
    style="display: flex; gap: var(--tandem-space-2);"
  >
    {#each (["s", "m", "l"] as const) as size (size)}
      <button
        data-testid={`text-size-${size}-btn`}
        role="radio"
        aria-checked={settings.textSize === size}
        tabindex={textSizeRg.tabIndexFor(size)}
        onclick={() => onUpdate({ textSize: size })}
        style={cardStyle(settings.textSize === size)}
      >
        {size === "s" ? "Small" : size === "m" ? "Medium" : "Large"}
      </button>
    {/each}
  </div>
  <div style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
    Reading density only — use browser zoom (Ctrl + =/−) to scale the whole UI.
  </div>
</div>

<!-- Accent Color -->
<div>
  <div id="settings-accent-color-label" style={sectionLabelStyle}>Accent Color</div>
  <div style="display: flex; align-items: center; gap: 8px;">
    <span
      aria-hidden="true"
      style="display: inline-block; width: 16px; height: 16px; background: var(--tandem-accent); border-radius: var(--tandem-r-1); flex-shrink: 0; border: 1px solid var(--tandem-border-strong);"
    ></span>
    <input
      data-testid="accent-hue-slider"
      type="range"
      min="0"
      max="360"
      step="1"
      aria-labelledby="settings-accent-color-label"
      value={settings.accentHue}
      oninput={(e) => onUpdate({ accentHue: Number((e.target as HTMLInputElement).value) })}
      style="flex: 1; accent-color: var(--tandem-accent);"
    />
  </div>
</div>

<!-- Editor Font -->
<div>
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
        onclick={() => onUpdate({ editorFont: value })}
        style={cardStyle(settings.editorFont === value)}
      >
        {label}
      </button>
    {/each}
  </div>
</div>

<!-- Default Font by File Type (#811) -->
<div data-testid="font-by-extension-section">
  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
    <div id="settings-font-by-ext-label" style={`${sectionLabelStyle} margin-bottom: 0;`}>
      Default font by file type
    </div>
    <button
      data-testid="font-by-extension-reset"
      type="button"
      disabled={!hasFontOverrides}
      onclick={resetFontsToDefaults}
      style={`background: none; border: none; padding: 0; font-size: var(--tandem-text-2xs); color: ${hasFontOverrides ? "var(--tandem-accent-fg-strong)" : "var(--tandem-fg-subtle)"}; cursor: ${hasFontOverrides ? "pointer" : "default"}; text-decoration: ${hasFontOverrides ? "underline" : "none"};`}
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
              onclick={() => setFontFor(row.format, value)}
              style={cardStyle(effectiveFontFor(row.format) === value)}
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

<!-- Density -->
<div>
  <div id="settings-density-label" style={sectionLabelStyle}>Spacing Density</div>
  <div
    role="radiogroup"
    aria-labelledby="settings-density-label"
    tabindex="0"
    onkeydown={densityRg.handleKeyDown}
    style="display: flex; gap: var(--tandem-space-2);"
  >
    {#each ([["compact", "Compact"], ["cozy", "Cozy"], ["spacious", "Spacious"]] as const) as [value, label] (value)}
      <button
        data-testid={`density-${value}-btn`}
        role="radio"
        aria-checked={settings.density === value}
        tabindex={densityRg.tabIndexFor(value)}
        onclick={() => onUpdate({ density: value })}
        style={cardStyle(settings.density === value)}
      >
        {label}
      </button>
    {/each}
  </div>
</div>

<!-- Decorations (#596 → 1.13: per-type display toggles, mirrored from the
     title-bar Decorations control) -->
<div>
  <div style={sectionLabelStyle}>Decorations</div>
  {#each DECORATION_ROWS as [field, testid, label] (field)}
    <label
      data-testid={testid}
      style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: var(--tandem-text-sm); color: var(--tandem-fg); min-height: var(--tandem-space-5);"
    >
      <input
        type="checkbox"
        checked={settings[field]}
        onchange={(e) =>
          onUpdate({
            [field]: (e.target as HTMLInputElement).checked,
            ...(settings.decorationsMuted ? { decorationsMuted: false } : {}),
          })}
        style="accent-color: var(--tandem-accent);"
      />
      <span>{label}</span>
    </label>
  {/each}
  <div
    style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);"
  >
    Turn a type off to hide its inline marks in the editor. Annotation cards in the
    side panel stay visible. Display-only — hiding Notes never affects what Claude reads.
  </div>
</div>

<!-- Reduce Motion -->
<div>
  <label
    data-testid="reduce-motion-toggle"
    style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: var(--tandem-text-sm); color: var(--tandem-fg); min-height: var(--tandem-space-5);"
  >
    <input
      type="checkbox"
      checked={settings.reduceMotion}
      onchange={(e) => onUpdate({ reduceMotion: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent);"
    />
    <span>Reduce motion</span>
  </label>
  <div style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
    Disables smooth autoscroll and the annotation flash animation.
  </div>
</div>

<!-- Formatting bar (1.11) -->
<div>
  <label
    data-testid="appearance-formatting-bar"
    style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: var(--tandem-text-sm); color: var(--tandem-fg); min-height: var(--tandem-space-5);"
  >
    <input
      type="checkbox"
      checked={settings.formattingBarVisible}
      onchange={(e) =>
        onUpdate({ formattingBarVisible: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent);"
    />
    <span>Show formatting bar</span>
  </label>
  <div style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
    The persistent toolbar above the document. When hidden, formatting stays available
    in the selection popup, and Ctrl+Z / Ctrl+Y still undo and redo.
  </div>
</div>

<!-- Rail hover-reveal (#798 motion / floating rails) -->
<div>
  <label
    data-testid="appearance-rail-hover-reveal"
    style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: var(--tandem-text-sm); color: var(--tandem-fg); min-height: var(--tandem-space-5);"
  >
    <input
      type="checkbox"
      checked={settings.railHoverReveal}
      onchange={(e) => onUpdate({ railHoverReveal: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent);"
    />
    <span>Reveal rails on hover</span>
  </label>
  <div style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
    Hover a closed outline or annotations rail to float it over the document without
    resizing it; click its edge to pin it open. When off, rails reveal only on click.
  </div>
</div>
