<script lang="ts">
import { ACTION_GROUPS, getActionsMap } from "../../actions/registry.svelte.js";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// Tab body components take the context for uniformity even when they don't
// reference any fields. Keep `$props()` as a single proxy variable; suppress
// unused-var lint by reading the binding inside an $effect.
let ctx: SettingsTabContext = $props();
$effect(() => {
  void ctx;
});

// Static shortcuts not yet in the action registry (modifier-key / nav).
const STATIC_SHORTCUT_ROWS = [
  { keys: "Ctrl+B", description: "Bold" },
  { keys: "Ctrl+I", description: "Italic" },
  { keys: "Ctrl+Z", description: "Undo" },
  { keys: "Ctrl+Y", description: "Redo" },
  { keys: "Ctrl+F", description: "Find / Replace" },
  { keys: "?", description: "Show keyboard shortcuts" },
  { keys: "Ctrl+Tab", description: "Next document tab" },
  { keys: "Ctrl+Shift+Tab", description: "Previous document tab" },
];

const registryShortcutSections = $derived.by(() => {
  const actionsMap = getActionsMap();
  const byGroup = new Map<string, Array<{ keys: string; description: string }>>();
  for (const action of actionsMap.values()) {
    if (!action.shortcut) continue;
    const rows = byGroup.get(action.group) ?? [];
    rows.push({ keys: action.shortcut, description: action.label });
    byGroup.set(action.group, rows);
  }
  return ACTION_GROUPS.map((g) => ({
    title: g.charAt(0).toUpperCase() + g.slice(1),
    rows: byGroup.get(g) ?? [],
  })).filter((s) => s.rows.length > 0);
});
</script>

<div
  data-testid="settings-modal-shortcuts-list"
  style="display: flex; flex-direction: column; gap: var(--tandem-space-4);"
>
  {#each registryShortcutSections as section (section.title)}
    <section>
      <div class="settings-section-label">{section.title}</div>
      <div
        style="display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 14px; align-items: center;"
      >
        {#each section.rows as row (row.keys + row.description)}
          <kbd
            style="justify-self: start; padding: 1px 6px; font-family: var(--tandem-font-mono); font-size: 11px; color: var(--tandem-fg); background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border-strong); border-bottom-width: 2px; border-radius: var(--tandem-r-2);"
          >
            {row.keys}
          </kbd>
          <span style="font-size: 13px; color: var(--tandem-fg-muted);">
            {row.description}
          </span>
        {/each}
      </div>
    </section>
  {/each}
  <section>
    <div class="settings-section-label">Other</div>
    <div
      style="display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 14px; align-items: center;"
    >
      {#each STATIC_SHORTCUT_ROWS as row (row.keys + row.description)}
        <kbd
          style="justify-self: start; padding: 1px 6px; font-family: var(--tandem-font-mono); font-size: 11px; color: var(--tandem-fg); background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border-strong); border-bottom-width: 2px; border-radius: var(--tandem-r-2);"
        >
          {row.keys}
        </kbd>
        <span style="font-size: 13px; color: var(--tandem-fg-muted);">
          {row.description}
        </span>
      {/each}
    </div>
  </section>
</div>
