<script lang="ts">
import { clickOutside } from "../actions/clickOutside.svelte.js";
import { isInActiveDragRegion } from "../utils/dismiss-outside.js";
import { portal } from "../utils/portal.js";

interface Props {
  recentFiles: string[];
  anchorEl: HTMLElement | null;
  onOpen: (path: string) => void;
  onBrowse: () => void;
  onNewScratchpad: () => void;
  onClose: () => void;
}

let { recentFiles, anchorEl, onOpen, onBrowse, onNewScratchpad, onClose }: Props = $props();

function basename(p: string): string {
  return p.replace(/[/\\]+$/, "").replace(/.*[/\\]/, "");
}

function extBadge(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md") return "M";
  if (ext === "docx" || ext === "doc") return "W";
  if (ext === "txt") return "T";
  if (ext === "html" || ext === "htm") return "H";
  return ext.slice(0, 1).toUpperCase() || "?";
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    onClose();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    const items = getFocusableItems();
    const idx = items.indexOf(document.activeElement as HTMLElement);
    items[(idx + 1) % items.length]?.focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    const items = getFocusableItems();
    const idx = items.indexOf(document.activeElement as HTMLElement);
    items[(idx - 1 + items.length) % items.length]?.focus();
  }
}

function getFocusableItems(): HTMLElement[] {
  return Array.from(menuEl?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []);
}

let menuEl: HTMLDivElement | null = $state(null);

function handleOutsideClick(e: MouseEvent) {
  // The clickOutside action already filtered out clicks inside the menu.
  // Also ignore the anchor button (its own onclick would re-open the menu)
  // and clicks on an active Tauri drag region (title-bar drag is not a dismiss).
  const target = e.target as (Node & Element) | null;
  if (!target) return;
  if (anchorEl?.contains(target)) return;
  if (isInActiveDragRegion(target)) return;
  onClose();
}

function positionMenu() {
  if (!menuEl) return;
  if (!anchorEl) {
    menuEl.style.top = "8px";
    menuEl.style.left = "8px";
    menuEl.style.right = "auto";
    return;
  }
  const rect = anchorEl.getBoundingClientRect();
  const menuWidth = menuEl.offsetWidth;
  const viewportWidth = window.innerWidth;
  const top = rect.bottom + 4;
  const left = rect.left;
  if (left + menuWidth > viewportWidth - 8) {
    menuEl.style.right = "8px";
    menuEl.style.left = "auto";
  } else {
    menuEl.style.left = `${left}px`;
    menuEl.style.right = "auto";
  }
  menuEl.style.top = `${top}px`;
}

$effect(() => {
  if (!menuEl) return;
  positionMenu();
  getFocusableItems()[0]?.focus();
});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  use:portal
  use:clickOutside={handleOutsideClick}
  bind:this={menuEl}
  role="dialog"
  aria-label="New tab"
  onkeydown={handleKeyDown}
  tabindex="-1"
  class="new-tab-menu"
>
  <div class="new-tab-menu-header">
    Recent files
  </div>

  {#each recentFiles as filePath}
    <button
      role="menuitem"
      type="button"
      onclick={() => onOpen(filePath)}
      title={filePath}
      class="new-tab-menu-item"
    >
      <span class="new-tab-menu-badge">
        {extBadge(filePath)}
      </span>
      <span class="new-tab-menu-label">
        {basename(filePath)}
      </span>
    </button>
  {/each}

  {#if recentFiles.length > 0}
    <div class="new-tab-menu-divider"></div>
  {/if}

  <button
    role="menuitem"
    type="button"
    data-testid="palette-item-new-scratchpad"
    onclick={onNewScratchpad}
    class="new-tab-menu-item new-tab-menu-action"
  >
    New Scratchpad
  </button>
  <button
    role="menuitem"
    type="button"
    onclick={onBrowse}
    class="new-tab-menu-item new-tab-menu-action"
    style="padding-bottom: 8px;"
  >
    Browse files…
  </button>
</div>

<style>
  .new-tab-menu {
    position: fixed;
    top: 0;
    left: 0;
    min-width: 260px;
    max-width: 400px;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-4);
    box-shadow: var(--tandem-shadow-4);
    z-index: var(--tandem-z-dropdown);
    overflow: hidden;
  }

  .new-tab-menu-header {
    padding: 6px 12px 4px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--tandem-fg-subtle);
  }

  .new-tab-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    border: none;
    background: transparent;
    cursor: pointer;
    text-align: left;
    color: var(--tandem-fg);
    font-size: 13px;
  }

  .new-tab-menu-item:hover {
    background: var(--tandem-surface-muted);
  }

  .new-tab-menu-action {
    color: var(--tandem-fg-muted);
  }

  .new-tab-menu-badge {
    font-size: 10px;
    font-weight: 700;
    font-family: var(--tandem-font-mono);
    color: var(--tandem-fg-muted);
    min-width: 14px;
    text-align: center;
  }

  .new-tab-menu-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .new-tab-menu-divider {
    height: 1px;
    background: var(--tandem-border);
    margin: 4px 0;
  }
</style>
