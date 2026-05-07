<script lang="ts">
import { type Action, getActions } from "../actions/registry.svelte.js";

interface Props {
  open: boolean;
  onClose: () => void;
}

let { open, onClose }: Props = $props();

let query = $state("");
let selectedIndex = $state(0);
let inputEl = $state<HTMLInputElement | null>(null);

const allActions = $derived(getActions());

const filteredActions = $derived.by(() => {
  const q = query.trim().toLowerCase();
  if (!q) return allActions;
  return allActions.filter(
    (a) =>
      a.label.toLowerCase().includes(q) ||
      a.group.toLowerCase().includes(q) ||
      (a.shortcut?.toLowerCase().includes(q) ?? false),
  );
});

$effect(() => {
  filteredActions;
  selectedIndex = 0;
});

$effect(() => {
  if (open) {
    query = "";
    selectedIndex = 0;
    // Focus input on next microtask so the DOM has rendered
    Promise.resolve().then(() => inputEl?.focus());
  }
});

function close() {
  onClose();
}

function run(action: Action) {
  close();
  void action.run();
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex = (selectedIndex + 1) % Math.max(1, filteredActions.length);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex =
      (selectedIndex - 1 + Math.max(1, filteredActions.length)) %
      Math.max(1, filteredActions.length);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const action = filteredActions[selectedIndex];
    if (action) run(action);
  } else if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

function handleBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) close();
}
</script>

{#if open}
  <div
    role="presentation"
    style="
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.4);
      z-index: var(--tandem-z-overlay, 200);
      display: flex; align-items: flex-start; justify-content: center;
      padding-top: 15vh;
    "
    onclick={handleBackdropClick}
    onkeydown={(e) => { if (e.key === "Escape") close(); }}
  >
    <div
      data-testid="command-palette"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Command palette"
      style="
        width: 560px; max-width: 90vw;
        background: var(--tandem-surface);
        border: 1px solid var(--tandem-border);
        border-radius: var(--tandem-r-4);
        box-shadow: var(--tandem-shadow-4);
        overflow: hidden;
        display: flex; flex-direction: column;
      "
      onkeydown={handleKeydown}
    >
      <!-- Search input -->
      <div style="padding: var(--tandem-space-3) var(--tandem-space-4); border-bottom: 1px solid var(--tandem-border);">
        <input
          bind:this={inputEl}
          data-testid="palette-input"
          type="text"
          placeholder="Type a command…"
          aria-label="Search commands"
          aria-controls="palette-results"
          aria-activedescendant={filteredActions[selectedIndex] ? `palette-item-${filteredActions[selectedIndex].id}` : undefined}
          bind:value={query}
          style="
            width: 100%; padding: 6px 0;
            font-size: var(--tandem-text-md); color: var(--tandem-fg);
            background: transparent; border: none; outline: none;
          "
        />
      </div>

      <!-- Results -->
      <ul
        id="palette-results"
        role="listbox"
        aria-label="Commands"
        style="max-height: 400px; overflow-y: auto; padding: var(--tandem-space-1) 0; list-style: none; margin: 0;"
      >
        {#if filteredActions.length === 0}
          <li
            data-testid="palette-empty"
            style="padding: var(--tandem-space-3) var(--tandem-space-4); font-size: var(--tandem-text-sm); color: var(--tandem-fg-faint); font-style: italic;"
          >
            No commands match
          </li>
        {:else}
          {#each filteredActions as action, i (action.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
              id={`palette-item-${action.id}`}
              data-testid={`palette-item-${action.id}`}
              role="option"
              aria-selected={i === selectedIndex}
              onclick={() => run(action)}
              onmouseenter={() => (selectedIndex = i)}
              style="
                display: flex; align-items: center; justify-content: space-between;
                padding: 8px var(--tandem-space-4);
                cursor: pointer;
                background: ${i === selectedIndex ? "var(--tandem-accent-bg)" : "transparent"};
                color: ${i === selectedIndex ? "var(--tandem-accent-fg-strong)" : "var(--tandem-fg)"};
              "
            >
              <span style="font-size: var(--tandem-text-sm);">{action.label}</span>
              {#if action.shortcut}
                <span style="font-size: var(--tandem-text-xs); color: var(--tandem-fg-faint); font-family: var(--tandem-font-mono);">
                  {action.shortcut}
                </span>
              {/if}
            </li>
          {/each}
        {/if}
      </ul>
    </div>
  </div>
{/if}
