<script lang="ts">
import { clickOutside } from "../../actions/clickOutside.svelte";

interface Props {
  open: boolean;
  initialValue?: string;
  onApply: (value: string) => void;
  onClose: () => void;
  /** CSS positioning supplied by the host (absolute toolbar or fixed editor). */
  positionStyle?: string;
  testIdPrefix?: string;
  label?: string;
}

let {
  open,
  initialValue = "",
  onApply,
  onClose,
  positionStyle = "position: absolute; top: 100%; left: 0; margin-top: 4px;",
  testIdPrefix = "toolbar-link",
  label = "Edit link",
}: Props = $props();

let value = $state("");
let inputEl = $state<HTMLInputElement | null>(null);

$effect(() => {
  if (!open) return;
  value = initialValue;
  requestAnimationFrame(() => {
    inputEl?.focus();
    inputEl?.select();
  });
});

function apply(): void {
  onApply(value);
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    apply();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }
}
</script>

{#if open}
  <div
    use:clickOutside={onClose}
    role="dialog"
    aria-label={label}
    style={`${positionStyle}
      background: var(--tandem-surface); border: 1px solid var(--tandem-border);
      border-radius: var(--tandem-r-3); padding: 6px;
      display: flex; align-items: center; gap: 4px;
      z-index: var(--tandem-z-dropdown); box-shadow: var(--tandem-shadow-1); min-width: 240px;`}
  >
    <input
      bind:this={inputEl}
      bind:value
      data-testid={`${testIdPrefix}-input`}
      type="url"
      placeholder="https://"
      onkeydown={handleKeyDown}
      style="flex: 1; height: 26px; padding: 2px 6px; font-size: 12px;
        border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2);
        background: var(--tandem-surface); color: var(--tandem-fg);
        outline: none; font-family: inherit;"
    />
    <button
      type="button"
      data-testid={`${testIdPrefix}-submit`}
      onmousedown={(event) => {
        event.preventDefault();
        apply();
      }}
      onclick={(event) => {
        if (event.detail === 0) apply();
      }}
      style="height: 26px; padding: 0 8px; font-size: 12px; font-weight: 500;
        border: 1px solid var(--tandem-accent-border); background: transparent;
        color: var(--tandem-accent); border-radius: var(--tandem-r-2); cursor: pointer;
        white-space: nowrap;"
    >Apply</button>
    <button
      type="button"
      data-testid={`${testIdPrefix}-cancel`}
      onmousedown={(event) => {
        event.preventDefault();
        onClose();
      }}
      onclick={(event) => {
        if (event.detail === 0) onClose();
      }}
      style="height: 26px; padding: 0 8px; font-size: 12px; font-weight: 500;
        border: 1px solid var(--tandem-border); background: transparent;
        color: var(--tandem-fg-muted); border-radius: var(--tandem-r-2); cursor: pointer;"
    >Cancel</button>
  </div>
{/if}
