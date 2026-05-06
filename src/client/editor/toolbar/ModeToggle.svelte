<script lang="ts">
import type { TandemMode } from "../../../shared/types";

interface Props {
  tandemMode: TandemMode;
  onModeChange: (mode: TandemMode) => void;
}

const { tandemMode, onModeChange }: Props = $props();
</script>

<div
  data-testid="mode-toggle"
  role="group"
  aria-label="Claude collaboration mode"
  style="display: inline-flex; background: var(--tandem-surface-sunk); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2); padding: 2px; gap: 2px;"
>
  <button
    data-testid="mode-solo-btn"
    title="Write undisturbed — Claude only responds when you message"
    aria-pressed={tandemMode === "solo"}
    onclick={() => onModeChange("solo")}
    style="height: 24px; padding: 0 10px; font-size: 12px; border: none; border-radius: var(--tandem-r-1); cursor: pointer;
      background: {tandemMode === 'solo' ? 'var(--tandem-surface)' : 'transparent'};
      color: {tandemMode === 'solo' ? 'var(--tandem-fg)' : 'var(--tandem-fg-muted)'};
      font-weight: 500;
      display: flex; align-items: center; gap: 5px;"
  >
    {#if tandemMode === "solo"}
      <span
        style="width: 6px; height: 6px; border-radius: var(--tandem-r-circle); background: var(--tandem-fg-subtle); display: inline-block;"
      ></span>
    {/if}
    Solo
  </button>
  <button
    data-testid="mode-tandem-btn"
    title="Full collaboration — Claude reacts to selections and document changes"
    aria-pressed={tandemMode === "tandem"}
    onclick={() => onModeChange("tandem")}
    style="height: 24px; padding: 0 10px; font-size: 12px; border: none; border-radius: var(--tandem-r-1); cursor: pointer;
      background: {tandemMode === 'tandem' ? 'var(--tandem-surface)' : 'transparent'};
      color: {tandemMode === 'tandem' ? 'var(--tandem-fg)' : 'var(--tandem-fg-muted)'};
      font-weight: 500;
      display: flex; align-items: center; gap: 5px;"
  >
    {#if tandemMode === "tandem"}
      <span
        style="width: 6px; height: 6px; border-radius: var(--tandem-r-circle); background: var(--tandem-success); display: inline-block;"
      ></span>
    {/if}
    Tandem
  </button>
</div>

<style>
  @media (forced-colors: active) {
    button[aria-pressed="true"] {
      outline: 2px solid ButtonText;
    }
  }
</style>
