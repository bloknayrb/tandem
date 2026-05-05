<script lang="ts">
interface Props {
  recentFiles: string[];
  onOpen: (path: string) => void;
  onBrowse: () => void;
  onClose: () => void;
}

let { recentFiles, onOpen, onBrowse, onClose }: Props = $props();

function basename(p: string): string {
  // Works on both / and \ separators
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

function hoverOn(e: MouseEvent) {
  (e.currentTarget as HTMLElement).style.background = "var(--tandem-surface-muted)";
}
function hoverOff(e: MouseEvent) {
  (e.currentTarget as HTMLElement).style.background = "transparent";
}

let menuEl: HTMLDivElement | null = $state(null);

$effect(() => {
  if (!menuEl) return;
  // Focus first item on open
  const items = getFocusableItems();
  items[0]?.focus();
});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={menuEl}
  role="menu"
  aria-label="Recent files"
  onkeydown={handleKeyDown}
  tabindex="-1"
  style="position: absolute; top: 100%; left: 0; margin-top: 4px; min-width: 260px; max-width: 400px; background: var(--tandem-surface); border: 1px solid var(--tandem-border); border-radius: 8px; box-shadow: 0 4px 16px color-mix(in srgb, var(--tandem-fg) 12%, transparent); z-index: 200; overflow: hidden;"
>
  <div style="padding: 6px 12px 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--tandem-fg-subtle);">
    Recent files
  </div>

  {#each recentFiles as filePath}
    <button
      role="menuitem"
      type="button"
      onclick={() => onOpen(filePath)}
      title={filePath}
      style="display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 12px; border: none; background: transparent; cursor: pointer; text-align: left; color: var(--tandem-fg); font-size: 13px;"
      onmouseenter={hoverOn}
      onmouseleave={hoverOff}
    >
      <span style="font-size: 10px; font-weight: 700; font-family: var(--tandem-font-mono); color: var(--tandem-fg-muted); min-width: 14px; text-align: center;">
        {extBadge(filePath)}
      </span>
      <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">
        {basename(filePath)}
      </span>
    </button>
  {/each}

  {#if recentFiles.length > 0}
    <div style="height: 1px; background: var(--tandem-border); margin: 4px 0;"></div>
  {/if}

  <button
    role="menuitem"
    type="button"
    onclick={onBrowse}
    style="display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 12px 8px; border: none; background: transparent; cursor: pointer; text-align: left; color: var(--tandem-fg-muted); font-size: 13px;"
    onmouseenter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--tandem-surface-hover, var(--tandem-surface-muted))"; }}
    onmouseleave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
  >
    Browse files…
  </button>
</div>
