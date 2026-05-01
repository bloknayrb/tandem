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
  style="display: flex; border: 1px solid var(--tandem-border-strong); border-radius: 4px; overflow: hidden;"
>
  <button
    data-testid="mode-solo-btn"
    title="Write undisturbed — Claude only responds when you message"
    aria-pressed={tandemMode === "solo"}
    onclick={() => onModeChange("solo")}
    style="padding: 3px 10px; font-size: 12px; border: none; cursor: pointer;
      background: {tandemMode === 'solo' ? 'var(--tandem-accent)' : 'transparent'};
      color: {tandemMode === 'solo' ? 'var(--tandem-accent-fg)' : 'var(--tandem-fg-muted)'};
      font-weight: {tandemMode === 'solo' ? 600 : 400};
      border-right: 1px solid var(--tandem-border-strong);
      display: flex; align-items: center; gap: 5px;"
  >
    {#if tandemMode === "solo"}
      <span
        style="width: 6px; height: 6px; border-radius: 50%; background: var(--tandem-fg-subtle); display: inline-block;"
      ></span>
    {/if}
    Solo
  </button>
  <button
    data-testid="mode-tandem-btn"
    title="Full collaboration — Claude reacts to selections and document changes"
    aria-pressed={tandemMode === "tandem"}
    onclick={() => onModeChange("tandem")}
    style="padding: 3px 10px; font-size: 12px; border: none; cursor: pointer;
      background: {tandemMode === 'tandem' ? 'var(--tandem-accent)' : 'transparent'};
      color: {tandemMode === 'tandem' ? 'var(--tandem-accent-fg)' : 'var(--tandem-fg-muted)'};
      font-weight: {tandemMode === 'tandem' ? 600 : 400};
      display: flex; align-items: center; gap: 5px;"
  >
    {#if tandemMode === "tandem"}
      <span
        style="width: 6px; height: 6px; border-radius: 50%; background: var(--tandem-success); display: inline-block;"
      ></span>
    {/if}
    Tandem
  </button>
</div>
