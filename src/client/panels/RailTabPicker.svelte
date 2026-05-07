<script lang="ts">
import type { RailTab } from "../hooks/useTandemSettings";

interface Props {
  enabledTabs: RailTab[];
  onTabsChange: (tabs: RailTab[]) => void;
}

let { enabledTabs, onTabsChange }: Props = $props();

let open = $state(false);

const ALL_TABS: { id: RailTab; label: string }[] = [
  { id: "annotations", label: "Annotations" },
  { id: "chat", label: "Chat" },
  { id: "outline", label: "Outline" },
];

function toggle(tab: RailTab) {
  const next = enabledTabs.includes(tab)
    ? enabledTabs.filter((t) => t !== tab)
    : [...enabledTabs, tab];
  // Always keep at least one tab enabled
  if (next.length > 0) onTabsChange(next);
}

function handleClickOutside(e: MouseEvent) {
  const target = e.target as Element;
  if (!target.closest(".rail-tab-picker")) {
    open = false;
  }
}

$effect(() => {
  if (open) {
    document.addEventListener("click", handleClickOutside, true);
    return () => document.removeEventListener("click", handleClickOutside, true);
  }
});
</script>

<div class="rail-tab-picker" style="position: relative; display: flex; align-items: center;">
  <button
    data-testid="rail-tab-picker-btn"
    aria-label="Configure tabs"
    aria-expanded={open}
    onclick={(e) => { e.stopPropagation(); open = !open; }}
    style="
      width: 22px; height: 22px; border: none; background: transparent;
      cursor: pointer; border-radius: var(--tandem-r-2);
      color: var(--tandem-fg-subtle); font-size: 14px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      padding: 0;
    "
  >+</button>

  {#if open}
    <div
      data-testid="rail-tab-picker-dropdown"
      style="
        position: absolute; top: 100%; right: 0; z-index: var(--tandem-z-dropdown, 200);
        background: var(--tandem-surface); border: 1px solid var(--tandem-border);
        border-radius: var(--tandem-r-3); box-shadow: var(--tandem-shadow-2);
        padding: var(--tandem-space-2); min-width: 140px;
      "
    >
      {#each ALL_TABS as tab}
        <label
          style="
            display: flex; align-items: center; gap: var(--tandem-space-2);
            padding: var(--tandem-space-1) var(--tandem-space-2);
            cursor: pointer; border-radius: var(--tandem-r-2);
            font-size: var(--tandem-text-sm); color: var(--tandem-fg);
          "
        >
          <input
            type="checkbox"
            data-testid={`rail-tab-picker-${tab.id}`}
            checked={enabledTabs.includes(tab.id)}
            onchange={() => toggle(tab.id)}
            style="accent-color: var(--tandem-accent);"
          />
          {tab.label}
        </label>
      {/each}
    </div>
  {/if}
</div>
