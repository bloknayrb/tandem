<script lang="ts">
import { clickOutside } from "../actions/clickOutside.svelte";
import type { RailTab } from "../hooks/useTandemSettings";

interface Props {
  enabledTabs: RailTab[];
  disabledTabs?: RailTab[];
  testIdPrefix?: string;
  onTabsChange: (tabs: RailTab[]) => void;
}

let { enabledTabs, disabledTabs = [], testIdPrefix = "", onTabsChange }: Props = $props();

let open = $state(false);
let btnEl: HTMLButtonElement | null = $state(null);
let dropdownPos = $state<{ top: number; right: number } | null>(null);

const ALL_TABS: { id: RailTab; label: string }[] = [
  { id: "annotations", label: "Annotations" },
  { id: "chat", label: "Chat" },
  { id: "outline", label: "Outline" },
];

function toggle(tab: RailTab) {
  if (disabledTabs.includes(tab)) return;
  const next = enabledTabs.includes(tab)
    ? enabledTabs.filter((t) => t !== tab)
    : [...enabledTabs, tab];
  if (next.length > 0) onTabsChange(next);
}

function toggleOpen(e: MouseEvent) {
  e.stopPropagation();
  if (open) {
    open = false;
    return;
  }
  if (btnEl) {
    const rect = btnEl.getBoundingClientRect();
    dropdownPos = { top: rect.bottom + 4, right: window.innerWidth - rect.right };
  }
  open = true;
}

$effect(() => {
  if (!open) {
    dropdownPos = null;
  }
});
</script>

<div
  class="rail-tab-picker"
  use:clickOutside={() => (open = false)}
  style="display: flex; align-items: center;"
>
  <button
    bind:this={btnEl}
    data-testid={`${testIdPrefix}rail-tab-picker-btn`}
    aria-label="Configure tabs"
    aria-expanded={open}
    onclick={toggleOpen}
    style="
      width: 22px; height: 22px; border: none; background: transparent;
      cursor: pointer; border-radius: var(--tandem-r-2);
      color: var(--tandem-fg-subtle); font-size: 14px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      padding: 0;
    "
  >+</button>

  {#if open && dropdownPos}
    <div
      data-testid={`${testIdPrefix}rail-tab-picker-dropdown`}
      style="
        position: fixed; top: {dropdownPos.top}px; right: {dropdownPos.right}px;
        z-index: var(--tandem-z-dropdown, 200);
        background: var(--tandem-surface); border: 1px solid var(--tandem-border);
        border-radius: var(--tandem-r-3); box-shadow: var(--tandem-shadow-2);
        padding: var(--tandem-space-2); min-width: 140px;
      "
    >
      {#each ALL_TABS as tab}
        {@const isLastEnabled = enabledTabs.length === 1 && enabledTabs.includes(tab.id)}
        {@const isDisabled = disabledTabs.includes(tab.id) || isLastEnabled}
        <label
          title={isDisabled ? "Each rail must keep at least one tab" : undefined}
          style="
            display: flex; align-items: center; gap: var(--tandem-space-2);
            padding: var(--tandem-space-1) var(--tandem-space-2);
            cursor: {isDisabled ? 'not-allowed' : 'pointer'}; border-radius: var(--tandem-r-2);
            font-size: var(--tandem-text-sm); color: {isDisabled ? 'var(--tandem-fg-subtle)' : 'var(--tandem-fg)'};
            opacity: {isDisabled ? 0.5 : 1};
          "
        >
          <input
            type="checkbox"
            data-testid={`${testIdPrefix}rail-tab-picker-${tab.id}`}
            checked={enabledTabs.includes(tab.id)}
            disabled={isDisabled}
            onchange={() => toggle(tab.id)}
            style="accent-color: var(--tandem-accent);"
          />
          {tab.label}
        </label>
      {/each}
    </div>
  {/if}
</div>
