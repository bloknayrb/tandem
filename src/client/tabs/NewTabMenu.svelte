<script lang="ts">
import { clickOutside } from "../actions/clickOutside.svelte.js";
import type { ClosedTabRecord } from "../hooks/useClosedTabStack.svelte.js";
import { isInActiveDragRegion } from "../utils/dismiss-outside.js";
import { portal } from "../utils/portal.js";
import type { RecentFileEntry } from "../utils/recentFiles.js";
import { highlightSegments, matchesQuery, toLauncherRow } from "./newTabLauncher.js";

interface Props {
  recentFiles: RecentFileEntry[];
  /** Reactive head of the closed-tab stack — null hides "Reopen last closed". */
  closedTabTop: ClosedTabRecord | null;
  anchorEl: HTMLElement | null;
  onOpen: (path: string) => void;
  onBrowse: () => void;
  onNewScratchpad: () => void;
  onReopenClosed: () => void;
  onClose: () => void;
}

let {
  recentFiles,
  closedTabTop,
  anchorEl,
  onOpen,
  onBrowse,
  onNewScratchpad,
  onReopenClosed,
  onClose,
}: Props = $props();

let query = $state("");
let menuEl: HTMLDivElement | null = $state(null);
let searchInputEl: HTMLInputElement | null = $state(null);

const rows = $derived(recentFiles.map((e) => toLauncherRow(e)));
const filtered = $derived(rows.filter((r) => matchesQuery(r, query)));
const hasRecents = $derived(rows.length > 0);
const hasQuery = $derived(query.trim().length > 0);

// A7-local icon set (matches the Tandem stroke vocabulary). Inline so the menu
// has no icon-CDN dependency — same convention as the bundle's Glyph.svelte.
const GLYPHS: Record<string, string[]> = {
  plus: ["M12 5v14", "M5 12h14"],
  folder: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M14 3v6h6"],
  undo: ["M3 7v6h6", "M3 13a9 9 0 1 0 3-7"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "m20 20-3.5-3.5"],
  inbox: ["M3 7l9 6 9-6", "M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-9-4-9 4z"],
};

function getFocusableItems(): HTMLElement[] {
  return Array.from(menuEl?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []);
}

function moveFocus(delta: number) {
  const items = getFocusableItems();
  if (items.length === 0) return;
  const cur = items.indexOf(document.activeElement as HTMLElement);
  // Focus is on the search input (or nothing) → enter the list at an edge.
  if (cur === -1) {
    (delta > 0 ? items[0] : items[items.length - 1])?.focus();
    return;
  }
  items[(cur + delta + items.length) % items.length]?.focus();
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    onClose();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    moveFocus(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveFocus(-1);
  }
  // Enter on a focused menuitem is handled natively by the <button>.
}

function handleOutsideClick(e: MouseEvent) {
  // clickOutside already filtered clicks inside the menu. Also ignore the
  // anchor button (its own onclick re-opens the menu) and Tauri drag-region
  // clicks (title-bar drag is not a dismiss).
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
  if (rect.left + menuWidth > viewportWidth - 8) {
    menuEl.style.right = "8px";
    menuEl.style.left = "auto";
  } else {
    menuEl.style.left = `${rect.left}px`;
    menuEl.style.right = "auto";
  }
  menuEl.style.top = `${rect.bottom + 4}px`;
}

$effect(() => {
  if (!menuEl) return;
  positionMenu();
  // Auto-focus the search input on open (matches the bundle + command palette).
  searchInputEl?.focus();
});
</script>

{#snippet glyph(name: string, size: number, stroke: number)}
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={stroke}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#each GLYPHS[name] ?? [] as d, i (i)}
      <path {d} />
    {/each}
  </svg>
{/snippet}

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
  <div class="ntl-search">
    <span class="ntl-search-ic">{@render glyph("search", 13, 1.7)}</span>
    <input
      bind:this={searchInputEl}
      bind:value={query}
      type="text"
      placeholder="Search recent files…"
      aria-label="Search recent files"
      data-testid="new-tab-search"
    />
    {#if hasQuery}
      <button class="ntl-search-clr" type="button" onclick={() => (query = "")} aria-label="Clear search">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12M6 18L18 6" />
        </svg>
      </button>
    {/if}
    {#if hasRecents}
      <span class="ntl-count" aria-hidden="true">{filtered.length} of {rows.length}</span>
    {/if}
    <span class="ntl-esc" aria-hidden="true">Esc</span>
  </div>

  <div class="ntl-cols">
    <div class="ntl-col ntl-left">
      {#if !hasRecents}
        <div class="ntl-empty" data-testid="new-tab-empty">
          <div class="ntl-empty-ic">{@render glyph("inbox", 16, 1.6)}</div>
          No recent files yet.
          <div class="ntl-sub">Open something and it'll appear here.</div>
        </div>
      {:else if filtered.length === 0}
        <div class="ntl-no-match" data-testid="new-tab-no-match">
          No matches for “{query.trim()}”.
          <div class="ntl-sub">Try a different name, or create a scratchpad.</div>
        </div>
      {:else}
        <div class="ntl-recents">
          {#each filtered as row, i (row.path)}
            <button
              type="button"
              role="menuitem"
              class="ntl-recent"
              data-testid={`new-tab-recent-${i}`}
              onclick={() => onOpen(row.path)}
              title={row.path}
            >
              <span class="ntl-pip ntl-pip-{row.pip}"></span>
              <span class="ntl-body">
                <span class="ntl-name">
                  {#each highlightSegments(row.name, query) as seg, si (si)}
                    {#if seg.match}<mark>{seg.text}</mark>{:else}{seg.text}{/if}
                  {/each}
                </span>
                {#if row.dir}<span class="ntl-path">{row.dir}</span>{/if}
              </span>
              {#if row.when}<span class="ntl-when">{row.when}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="ntl-col ntl-right">
      <div class="ntl-colhead"><span class="ntl-colhead-label">Create</span></div>
      <button
        type="button"
        role="menuitem"
        class="ntl-action ntl-action-primary"
        data-testid="palette-item-new-scratchpad"
        onclick={onNewScratchpad}
      >
        <span class="ntl-glyph">{@render glyph("plus", 14, 1.9)}</span>
        <span class="ntl-lbl">New scratchpad</span>
        <span class="ntl-kbd" aria-hidden="true">Ctrl+N</span>
      </button>

      <div class="ntl-colhead"><span class="ntl-colhead-label">Open</span></div>
      <button
        type="button"
        role="menuitem"
        class="ntl-action"
        data-testid="new-tab-browse"
        onclick={onBrowse}
      >
        <span class="ntl-glyph">{@render glyph("folder", 13, 1.7)}</span>
        <span class="ntl-lbl">Browse files…</span>
        <span class="ntl-kbd" aria-hidden="true">Ctrl+O</span>
      </button>
      {#if closedTabTop}
        <button
          type="button"
          role="menuitem"
          class="ntl-action"
          data-testid="new-tab-reopen-closed"
          onclick={onReopenClosed}
          title={closedTabTop.filePath}
        >
          <span class="ntl-glyph">{@render glyph("undo", 13, 1.7)}</span>
          <span class="ntl-lbl">Reopen last closed</span>
          <span class="ntl-kbd" aria-hidden="true">Ctrl+Alt+T</span>
        </button>
      {/if}
    </div>
  </div>

  <div class="ntl-footer">
    <span class="ntl-kgrp"><span class="ntl-key" aria-hidden="true">↑</span><span class="ntl-key" aria-hidden="true">↓</span>navigate</span>
    <span class="ntl-kgrp"><span class="ntl-key" aria-hidden="true">↵</span>open</span>
    <span class="ntl-spacer"></span>
    <span class="ntl-kgrp">type to filter</span>
  </div>
</div>

<style>
  .new-tab-menu {
    position: fixed;
    top: 0;
    left: 0;
    width: min(460px, calc(100vw - 16px));
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-4);
    box-shadow: var(--tandem-shadow-2);
    z-index: var(--tandem-z-dropdown);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* Search bar */
  .ntl-search {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--tandem-border);
    background: var(--tandem-surface);
  }
  .ntl-search-ic {
    color: var(--tandem-fg-faint);
    display: inline-grid;
    place-items: center;
  }
  .ntl-search input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    font-family: var(--tandem-font-sans);
    font-size: 13px;
    color: var(--tandem-fg);
    padding: 0;
  }
  .ntl-search input::placeholder {
    color: var(--tandem-fg-faint);
  }
  .ntl-search-clr {
    width: 16px;
    height: 16px;
    border: none;
    background: transparent;
    color: var(--tandem-fg-faint);
    cursor: pointer;
    border-radius: var(--tandem-r-2);
    display: inline-grid;
    place-items: center;
    opacity: 0.8;
  }
  .ntl-search-clr:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .ntl-count {
    font-family: var(--tandem-font-mono);
    font-size: 10px;
    color: var(--tandem-fg-faint);
    flex-shrink: 0;
  }
  .ntl-esc {
    font-family: var(--tandem-font-mono);
    font-size: 10px;
    color: var(--tandem-fg-faint);
    padding: 1px 6px;
    border-radius: var(--tandem-r-2);
    background: var(--tandem-surface-sunk);
    border: 1px solid var(--tandem-border);
    flex-shrink: 0;
  }

  /* Two columns */
  .ntl-cols {
    display: grid;
    grid-template-columns: 1fr 184px;
    min-height: 0;
  }
  .ntl-col {
    padding: 8px 4px;
    min-width: 0;
  }
  .ntl-right {
    border-left: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted);
    padding: 8px 6px 6px;
  }
  .ntl-colhead {
    display: flex;
    align-items: center;
    padding: 4px 12px 6px;
  }
  .ntl-colhead-label {
    font-family: var(--tandem-font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--tandem-fg-faint);
    flex: 1;
  }

  /* Recents list */
  .ntl-recents {
    max-height: 256px;
    overflow-y: auto;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 8px, black calc(100% - 8px), transparent 100%);
    mask-image: linear-gradient(to bottom, transparent 0, black 8px, black calc(100% - 8px), transparent 100%);
  }
  .ntl-recents::-webkit-scrollbar {
    display: none;
  }
  .ntl-recent {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px;
    margin: 0 2px;
    width: calc(100% - 4px);
    border: 1px solid transparent;
    border-radius: var(--tandem-r-3);
    background: transparent;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    font-size: 12.5px;
    line-height: 1.3;
    color: var(--tandem-fg);
  }
  .ntl-recent:hover {
    background: var(--tandem-surface-sunk);
  }
  .ntl-recent:focus {
    outline: none;
    background: var(--tandem-accent-bg);
    color: var(--tandem-accent-fg-strong);
    border-color: var(--tandem-accent-border);
  }
  .ntl-pip {
    flex: 0 0 6px;
    height: 18px;
    border-radius: 2px;
  }
  .ntl-pip-md {
    background: var(--tandem-author-user);
  }
  .ntl-pip-docx {
    background: var(--tandem-author-claude);
  }
  .ntl-pip-txt {
    background: var(--tandem-filetype-txt);
  }
  .ntl-pip-html {
    background: var(--tandem-filetype-html);
  }
  .ntl-pip-other {
    background: var(--tandem-fg-faint);
  }
  .ntl-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .ntl-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .ntl-name mark {
    background: transparent;
    color: var(--tandem-accent-fg-strong);
    font-weight: 700;
  }
  .ntl-recent:focus .ntl-name mark {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .ntl-path {
    font-family: var(--tandem-font-mono);
    font-size: 10px;
    color: var(--tandem-fg-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ntl-recent:focus .ntl-path {
    color: var(--tandem-accent-fg-strong);
    opacity: 0.75;
  }
  .ntl-when {
    flex: 0 0 auto;
    font-family: var(--tandem-font-mono);
    font-size: 10px;
    color: var(--tandem-fg-faint);
    text-align: right;
    white-space: nowrap;
  }
  .ntl-recent:focus .ntl-when {
    color: var(--tandem-accent-fg-strong);
    opacity: 0.7;
  }

  /* Empty + no-match states */
  .ntl-empty,
  .ntl-no-match {
    padding: 26px 16px 22px;
    text-align: center;
    font-size: 13px;
    color: var(--tandem-fg-subtle);
    line-height: 1.5;
  }
  .ntl-empty-ic {
    margin: 0 auto 10px;
    width: 32px;
    height: 32px;
    border-radius: var(--tandem-r-3);
    display: grid;
    place-items: center;
    color: var(--tandem-fg-faint);
    background: var(--tandem-surface-sunk);
    border: 1px solid var(--tandem-border);
  }
  .ntl-sub {
    font-size: 11px;
    color: var(--tandem-fg-faint);
    margin-top: 4px;
  }

  /* Action buttons */
  .ntl-action {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    width: 100%;
    border: 1px solid transparent;
    border-radius: var(--tandem-r-3);
    background: transparent;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    font-size: 12.5px;
    color: var(--tandem-fg);
    transition: background 100ms, color 100ms, border-color 100ms;
  }
  .ntl-action + .ntl-action {
    margin-top: 2px;
  }
  .ntl-action:hover {
    background: var(--tandem-surface);
    border-color: var(--tandem-border);
  }
  .ntl-action:focus:not(.ntl-action-primary) {
    outline: none;
    background: var(--tandem-surface);
    border-color: var(--tandem-accent-border);
    box-shadow: inset 0 0 0 1px var(--tandem-accent-border);
  }
  .ntl-action-primary {
    background: var(--tandem-accent);
    color: var(--tandem-accent-fg);
    border-color: transparent;
    margin: 0 0 4px;
    padding: 9px 10px;
    font-weight: 500;
  }
  .ntl-action-primary:hover {
    background: var(--tandem-accent);
    filter: brightness(1.08);
  }
  .ntl-action-primary:focus {
    outline: none;
    box-shadow: 0 0 0 2px var(--tandem-surface-muted), 0 0 0 4px var(--tandem-accent);
  }
  .ntl-glyph {
    flex: 0 0 18px;
    display: grid;
    place-items: center;
    color: currentColor;
    opacity: 0.65;
  }
  .ntl-action-primary .ntl-glyph {
    opacity: 1;
  }
  .ntl-lbl {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ntl-kbd {
    font-family: var(--tandem-font-mono);
    font-size: 10px;
    color: var(--tandem-fg-faint);
    flex-shrink: 0;
  }
  .ntl-action-primary .ntl-kbd {
    color: var(--tandem-accent-fg);
    opacity: 0.7;
  }

  /* Footer */
  .ntl-footer {
    padding: 7px 14px;
    border-top: 1px solid var(--tandem-border);
    background: var(--tandem-surface-sunk);
    font-family: var(--tandem-font-mono);
    font-size: 10px;
    color: var(--tandem-fg-faint);
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .ntl-kgrp {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .ntl-key {
    padding: 1px 5px;
    border-radius: var(--tandem-r-2);
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    color: var(--tandem-fg-muted);
    min-width: 14px;
    text-align: center;
  }
  .ntl-spacer {
    flex: 1;
  }
</style>
