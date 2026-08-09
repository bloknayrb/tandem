<script lang="ts">
import { createRadioGroup } from "../hooks/useRadioGroup.svelte";
import type {
  Density,
  PrimaryTab,
  TextSize,
  ThemePreference,
} from "../hooks/useTandemSettings.svelte";
import { disabledControlStyle } from "../utils/colors";
import type { SettingsTabContext } from "./SettingsModal.svelte";

type Props = SettingsTabContext;

let { settings, onUpdate, readOnly }: Props = $props();

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
    disabledControlStyle(disabled ?? false),
    "text-align: center;",
    "font-size: 11px;",
    `color: ${disabled ? "var(--tandem-fg-subtle)" : selected ? "var(--tandem-accent-fg-strong)" : "var(--tandem-fg-muted)"};`,
    `font-weight: ${selected ? 600 : 400};`,
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
const densityRg = createRadioGroup<Density>(
  () => settings.density,
  ["compact", "cozy", "spacious"] as const,
  (d) => onUpdate({ density: d }),
);
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
        disabled={readOnly}
        onclick={() => onUpdate({ theme: t })}
        style={cardStyle(settings.theme === t, readOnly)}
      >
        {t === "light" ? "Light" : t === "warm" ? "Warm" : t === "dark" ? "Dark" : "System"}
      </button>
    {/each}
  </div>
  <!-- #993: when System resolves to a LIGHT OS appearance, let the user pick the
       paper-tone Warm theme instead of neutral Light. Dark is unaffected. Only
       meaningful while Theme === "system". -->
  {#if settings.theme === "system"}
    <label
      data-testid="appearance-system-light-warm"
      style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: var(--tandem-text-sm); color: var(--tandem-fg); min-height: var(--tandem-space-5); margin-top: var(--tandem-space-2);"
    >
      <input
        type="checkbox"
        checked={settings.systemLightVariant === "warm"}
        disabled={readOnly}
        onchange={(e) =>
          onUpdate({
            systemLightVariant: (e.target as HTMLInputElement).checked ? "warm" : "light",
          })}
        style="accent-color: var(--tandem-accent); {disabledControlStyle(readOnly)}"
      />
      <span>Use Warm when system is light</span>
    </label>
    <div
      style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);"
    >
      When your OS reports a light appearance, use the paper-tone Warm theme instead of
      neutral Light. A dark OS appearance still resolves to Dark.
    </div>
  {/if}
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
      disabled={readOnly}
      onclick={() => onUpdate({ primaryTab: "chat" })}
      style={cardStyle(settings.primaryTab === "chat", readOnly)}
    >
      Chat
    </button>
    <button
      data-testid="default-tab-annotations-btn"
      role="radio"
      aria-checked={settings.primaryTab === "annotations"}
      tabindex={primaryTabRg.tabIndexFor("annotations")}
      disabled={readOnly}
      onclick={() => onUpdate({ primaryTab: "annotations" })}
      style={cardStyle(settings.primaryTab === "annotations", readOnly)}
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
        disabled={readOnly}
        onclick={() => onUpdate({ textSize: size })}
        style={cardStyle(settings.textSize === size, readOnly)}
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
      disabled={readOnly}
      oninput={(e) => onUpdate({ accentHue: Number((e.target as HTMLInputElement).value) })}
      style="flex: 1; accent-color: var(--tandem-accent); {disabledControlStyle(readOnly, 'auto')}"
    />
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
        disabled={readOnly}
        onclick={() => onUpdate({ density: value })}
        style={cardStyle(settings.density === value, readOnly)}
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
        disabled={readOnly}
        onchange={(e) =>
          onUpdate({
            [field]: (e.target as HTMLInputElement).checked,
            ...(settings.decorationsMuted ? { decorationsMuted: false } : {}),
          })}
        style="accent-color: var(--tandem-accent); {disabledControlStyle(readOnly)}"
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
      disabled={readOnly}
      onchange={(e) => onUpdate({ reduceMotion: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent); {disabledControlStyle(readOnly)}"
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
      disabled={readOnly}
      onchange={(e) =>
        onUpdate({ formattingBarVisible: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent); {disabledControlStyle(readOnly)}"
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
      disabled={readOnly}
      onchange={(e) => onUpdate({ railHoverReveal: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent); {disabledControlStyle(readOnly)}"
    />
    <span>Reveal rails on hover</span>
  </label>
  <div style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
    Hover a closed outline or annotations rail to float it over the document without
    resizing it; click its edge to pin it open. When off, rails reveal only on click.
  </div>
</div>

<!-- Uniform tab width -->
<div>
  <label
    data-testid="appearance-uniform-tab-width"
    style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: var(--tandem-text-sm); color: var(--tandem-fg); min-height: var(--tandem-space-5);"
  >
    <input
      type="checkbox"
      checked={settings.uniformTabWidth}
      disabled={readOnly}
      onchange={(e) => onUpdate({ uniformTabWidth: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent); {disabledControlStyle(readOnly)}"
    />
    <span>Uniform tab width</span>
  </label>
  <div style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
    Give every document tab the same width. When off, each tab sizes to its own
    filename — short names take less room, long ones grow until they hit a cap.
  </div>
</div>

<!-- Scroll pill -->
<div>
  <label
    data-testid="appearance-scroll-pill"
    style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: var(--tandem-text-sm); color: var(--tandem-fg); min-height: var(--tandem-space-5);"
  >
    <input
      type="checkbox"
      checked={settings.scrollPill}
      disabled={readOnly}
      onchange={(e) => onUpdate({ scrollPill: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent); {disabledControlStyle(readOnly)}"
    />
    <span>Scroll pill</span>
  </label>
  <div style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
    Show a slim scroll thumb at the document's right edge that brightens as your
    cursor approaches it and fades away as you move off. Drag it to scrub through
    long documents. When off, the editor uses your system's standard scrollbar
    instead.
  </div>
</div>
