<script lang="ts">
import type { TandemSettings } from "../hooks/useTandemSettings.svelte";

interface Props {
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
}

let { settings, onUpdate }: Props = $props();

const sectionLabelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";
</script>

<div>
  <div style={sectionLabelStyle}>Authorship</div>
  <label
    data-testid="authorship-toggle"
    style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;"
  >
    <input
      type="checkbox"
      checked={settings.showAuthorship}
      onchange={(e) => onUpdate({ showAuthorship: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent);"
    />
    <span>Show who wrote what</span>
  </label>
  <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
    Highlights text by author:
    <span style="color: var(--tandem-author-user);">you</span> /
    <span style="color: var(--tandem-author-claude);">Claude</span>
  </div>
</div>

<div>
  <div style={sectionLabelStyle}>Contrast</div>
  <label
    data-testid="high-contrast-toggle"
    style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;"
  >
    <input
      type="checkbox"
      checked={settings.highContrast}
      onchange={(e) => onUpdate({ highContrast: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent);"
    />
    <span>High contrast</span>
  </label>
  <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
    Increases border and text contrast for improved readability.
  </div>
</div>

<div>
  <div style={sectionLabelStyle}>Annotation Patterns</div>
  <label
    data-testid="annotation-patterns-toggle"
    style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;"
  >
    <input
      type="checkbox"
      checked={settings.annotationPatterns}
      onchange={(e) => onUpdate({ annotationPatterns: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent);"
    />
    <span>Use pattern fills for annotations</span>
  </label>
  <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
    Adds visual patterns to annotation decorations (color-blind friendly).
  </div>
</div>
