<script lang="ts">
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import { createTandemSettings } from "../hooks/useTandemSettings.svelte";

interface Props {
  selectedCount: number;
  onPromote: () => void;
  onClear: () => void;
}

let { selectedCount, onPromote, onClear }: Props = $props();

const agentLabel = createAgentLabel(createTandemSettings());
</script>

{#if selectedCount > 0}
  <div
    data-testid="batch-promote-bar"
    role="region"
    aria-label="Batch promote imported notes"
    style="position: sticky; top: 0; z-index: var(--tandem-z-base); display: flex; align-items: center; gap: var(--tandem-space-2); padding: var(--tandem-space-2) var(--tandem-space-4); background: var(--tandem-surface); border-bottom: 1px solid var(--tandem-border); box-shadow: var(--tandem-shadow-1);"
  >
    <span
      data-testid="batch-promote-count"
      style="flex: 1; font-size: var(--tandem-text-2xs); font-weight: 500; color: var(--tandem-fg-subtle);"
    >
      {selectedCount} selected
    </span>
    <button
      data-testid="batch-promote-clear"
      onclick={onClear}
      style="padding: 3px 10px; border: 1px solid transparent; background: none; color: var(--tandem-fg-subtle); border-radius: var(--tandem-r-pill); cursor: pointer; font-size: var(--tandem-text-xs);"
    >
      Clear
    </button>
    <button
      data-testid="batch-promote-confirm"
      onclick={onPromote}
      style="padding: 3px 12px; border: 1px solid var(--tandem-accent); background: var(--tandem-accent); color: var(--tandem-accent-fg); border-radius: var(--tandem-r-pill); cursor: pointer; font-size: var(--tandem-text-xs); font-weight: 500;"
    >
      Send {selectedCount} to {agentLabel.family}
    </button>
  </div>
{/if}
