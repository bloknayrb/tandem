<script lang="ts">
import { createRadioGroup } from "../hooks/useRadioGroup.svelte";
import type {
  Density,
  EditorFont,
  LayoutMode,
  PanelOrder,
  PrimaryTab,
  TandemSettings,
  TextSize,
  ThemePreference,
} from "../hooks/useTandemSettings.svelte";

interface Props {
  open: boolean;
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
}

let { open, settings, onUpdate }: Props = $props();

const sectionLabelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";

let viewportWidth = $state(window.innerWidth);
const threePanelDisabled = $derived(viewportWidth < 768);

$effect(() => {
  if (!open) return;
  viewportWidth = window.innerWidth;
  const handler = () => {
    viewportWidth = window.innerWidth;
  };
  window.addEventListener("resize", handler);
  return () => window.removeEventListener("resize", handler);
});

const LAYOUT_OPTIONS: Array<{ value: LayoutMode; label: string; icon: string }> = [
  { value: "tabbed", label: "Tabbed", icon: "[=|]" },
  { value: "tabbed-left", label: "Tabbed-Left", icon: "[|=]" },
  { value: "three-panel", label: "Three-Panel", icon: "[|||]" },
];

function cardStyle(selected: boolean, disabled?: boolean): string {
  return [
    "flex: 1;",
    "padding: var(--tandem-space-2);",
    "min-height: 24px;",
    `border: 2px solid ${selected ? "var(--tandem-accent)" : "var(--tandem-border)"};`,
    "border-radius: 6px;",
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
  ["light", "dark", "system"] as const,
  (t) => onUpdate({ theme: t }),
);
const layoutRg = createRadioGroup<LayoutMode>(
  () => settings.layout,
  ["tabbed", "tabbed-left", "three-panel"] as const,
  (l) => onUpdate({ layout: l }),
  (l) => l === "three-panel" && threePanelDisabled,
);
const primaryTabRg = createRadioGroup<PrimaryTab>(
  () => settings.primaryTab,
  ["chat", "annotations"] as const,
  (p) => onUpdate({ primaryTab: p }),
);
const panelOrderRg = createRadioGroup<PanelOrder>(
  () => settings.panelOrder,
  ["chat-editor-annotations", "annotations-editor-chat"] as const,
  (p) => onUpdate({ panelOrder: p }),
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
    {#each (["light", "dark", "system"] as const) as t (t)}
      <button
        data-testid={`theme-${t}-btn`}
        role="radio"
        aria-checked={settings.theme === t}
        tabindex={themeRg.tabIndexFor(t)}
        onclick={() => onUpdate({ theme: t })}
        style={cardStyle(settings.theme === t)}
      >
        {t === "light" ? "Light" : t === "dark" ? "Dark" : "System"}
      </button>
    {/each}
  </div>
</div>

<!-- Layout mode -->
<div>
  <div id="settings-layout-label" style={sectionLabelStyle}>Layout</div>
  <div
    role="radiogroup"
    aria-labelledby="settings-layout-label"
    tabindex="0"
    onkeydown={layoutRg.handleKeyDown}
    style="display: flex; gap: 8px; flex-wrap: wrap;"
  >
    {#each LAYOUT_OPTIONS as { value, label, icon } (value)}
      {@const disabled = value === "three-panel" && threePanelDisabled}
      <button
        data-testid={`layout-${value}-btn`}
        role="radio"
        aria-checked={settings.layout === value}
        aria-disabled={disabled || undefined}
        tabindex={layoutRg.tabIndexFor(value)}
        onclick={() => { if (!disabled) onUpdate({ layout: value }); }}
        style={cardStyle(settings.layout === value, disabled)}
        title={disabled ? "Requires viewport wider than 768px" : undefined}
      >
        <div style="font-size: 18px; margin-bottom: 2px;">{icon}</div>
        {label}
      </button>
    {/each}
  </div>
  {#if threePanelDisabled}
    <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-top: 4px;">
      Three-panel requires a wider viewport
    </div>
  {/if}
</div>

<!-- Default tab (tabbed and tabbed-left modes) -->
{#if settings.layout === "tabbed" || settings.layout === "tabbed-left"}
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
{/if}

<!-- Panel order (three-panel mode only) -->
{#if settings.layout === "three-panel"}
  <div>
    <div id="settings-panel-order-label" style={sectionLabelStyle}>Panel Order</div>
    <div
      role="radiogroup"
      aria-labelledby="settings-panel-order-label"
      tabindex="0"
      onkeydown={panelOrderRg.handleKeyDown}
      style="display: flex; gap: var(--tandem-space-2);"
    >
      <button
        data-testid="panel-order-cea-btn"
        role="radio"
        aria-checked={settings.panelOrder === "chat-editor-annotations"}
        tabindex={panelOrderRg.tabIndexFor("chat-editor-annotations")}
        onclick={() => onUpdate({ panelOrder: "chat-editor-annotations" })}
        style={cardStyle(settings.panelOrder === "chat-editor-annotations")}
      >
        Chat | Editor | Ann.
      </button>
      <button
        data-testid="panel-order-aec-btn"
        role="radio"
        aria-checked={settings.panelOrder === "annotations-editor-chat"}
        tabindex={panelOrderRg.tabIndexFor("annotations-editor-chat")}
        onclick={() => onUpdate({ panelOrder: "annotations-editor-chat" })}
        style={cardStyle(settings.panelOrder === "annotations-editor-chat")}
      >
        Ann. | Editor | Chat
      </button>
    </div>
  </div>
{/if}

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
  <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-top: 4px;">
    Reading density only — use browser zoom (Ctrl + =/−) to scale the whole UI.
  </div>
</div>

<!-- Accent Color -->
<div>
  <div id="settings-accent-color-label" style={sectionLabelStyle}>Accent Color</div>
  <div style="display: flex; align-items: center; gap: 8px;">
    <span
      aria-hidden="true"
      style="display: inline-block; width: 16px; height: 16px; background: var(--tandem-accent); border-radius: 3px; flex-shrink: 0; border: 1px solid var(--tandem-border-strong);"
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
    {#each ([["sans", "Sans-serif"], ["serif", "Serif"], ["mono", "Monospace"]] as const) as [value, label] (value)}
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

<!-- Reduce Motion -->
<div>
  <label
    data-testid="reduce-motion-toggle"
    style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;"
  >
    <input
      type="checkbox"
      checked={settings.reduceMotion}
      onchange={(e) => onUpdate({ reduceMotion: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent);"
    />
    <span>Reduce motion</span>
  </label>
  <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-top: 4px;">
    Disables smooth autoscroll and the annotation flash animation.
  </div>
</div>
