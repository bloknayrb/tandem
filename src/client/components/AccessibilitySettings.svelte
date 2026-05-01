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
    style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;"
  >
    <input
      type="checkbox"
      checked={settings.showAuthorship}
      onchange={(e) => onUpdate({ showAuthorship: (e.target as HTMLInputElement).checked })}
      style="accent-color: var(--tandem-accent);"
    />
    <span>Show who wrote what</span>
  </label>
  <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-top: 4px;">
    Highlights text by author:
    <span style="color: var(--tandem-author-user);">you</span> /
    <span style="color: var(--tandem-author-claude);">Claude</span>
  </div>
</div>
