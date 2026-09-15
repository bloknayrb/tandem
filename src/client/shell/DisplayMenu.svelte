<script lang="ts">
import "../editor/toolbar/toolbar-chrome.css";
import { clickOutside } from "../actions/clickOutside.svelte";
import type { EditorMeasure, TextSize } from "../hooks/useTandemSettings";
import { ESCAPE_OWNER_ATTR } from "../utils/escape-owner";
import { focusMenuEntryPoint, handleMenuArrowKeys } from "../utils/menuKeys";

/**
 * Display menu (#1705): a quick, point-of-use home for the editor's reading
 * presets, which otherwise live only in the Settings modal.
 *
 * It keeps NO copy of either value. Both props are read straight from the
 * settings store by the parent and every pick goes back through `onUpdate`,
 * which App wires to `settingsState.updateSettings` — the same write path the
 * Settings radiogroups use. So the modal and this menu cannot disagree: there
 * is one state, rendered in two places.
 *
 * Mechanics copied from DecorationsMenu on purpose (clickOutside on one
 * wrapper, ESCAPE_OWNER_ATTR while open, focus the entry point on open, APG
 * arrow keys, a single guarded close path) so the two menus in the bar behave
 * identically from the keyboard.
 */
interface Props {
  textSize: TextSize;
  editorMeasure: EditorMeasure;
  onUpdate: (partial: { textSize?: TextSize; editorMeasure?: EditorMeasure }) => void;
}

let { textSize, editorMeasure, onUpdate }: Props = $props();

const TEXT_SIZES: readonly TextSize[] = ["s", "m", "l"];
const TEXT_SIZE_LABEL: Record<TextSize, string> = { s: "Small", m: "Medium", l: "Large" };
const MEASURE_LABEL: Record<EditorMeasure, string> = {
  narrow: "Narrow",
  comfortable: "Comfortable",
  wide: "Wide",
  full: "Full",
};

const triggerLabel = $derived(
  `Display options: text ${TEXT_SIZE_LABEL[textSize]}, measure ${MEASURE_LABEL[editorMeasure]}`,
);

let menuOpen = $state(false);
let triggerBtn = $state<HTMLButtonElement | null>(null);
let menuEl = $state<HTMLDivElement | null>(null);

// The trigger is a sibling of the menu, so focus must be moved in explicitly
// or the first arrow press never reaches the menu's handler.
$effect(() => {
  if (menuOpen) focusMenuEntryPoint(menuEl);
});

// Same guarded restore as DecorationsMenu: clickOutside fires on mousedown,
// before the browser moves focus, so only pull focus back to the trigger when
// it is still inside the menu (or already lost to <body>).
function closeMenu() {
  const ours =
    (!!menuEl && menuEl.contains(document.activeElement)) ||
    document.activeElement === document.body ||
    document.activeElement === null;
  menuOpen = false;
  if (ours) triggerBtn?.focus();
}

function handleKey(e: KeyboardEvent) {
  if (handleMenuArrowKeys(e)) return;
  if (e.key === "Escape" && menuOpen) {
    e.stopPropagation();
    closeMenu();
  }
}

function pickTextSize(size: TextSize) {
  onUpdate({ textSize: size });
  closeMenu();
}
</script>

<!-- One clickOutside node around trigger AND menu (node.contains), exactly as
     DecorationsMenu does — a separate wrapper would read a trigger click as
     "outside" and re-close instantly. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="dm-wrap"
  data-tauri-drag-region="false"
  {...(menuOpen ? { [ESCAPE_OWNER_ATTR]: "" } : {})}
  use:clickOutside={closeMenu}
  onkeydown={handleKey}
>
  <button
    bind:this={triggerBtn}
    type="button"
    class="dm-trigger tandem-toolbar-ctl"
    data-testid="display-menu-trigger"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    aria-label={triggerLabel}
    title={triggerLabel}
    onclick={() => (menuOpen = !menuOpen)}
  >
    <span class="dm-glyph" aria-hidden="true">Aa</span>
  </button>

  {#if menuOpen}
    <div class="dm-menu" data-testid="display-menu">
      <div bind:this={menuEl} role="menu" aria-label="Display">
        <div role="group" aria-label="Text size">
          <div class="dm-head" aria-hidden="true">Text size</div>
          {#each TEXT_SIZES as size (size)}
            <button
              type="button"
              class="dm-item"
              role="menuitemradio"
              aria-checked={textSize === size}
              data-testid={`display-menu-text-size-${size}`}
              onclick={() => pickTextSize(size)}
            >
              <span class="dm-label">{TEXT_SIZE_LABEL[size]}</span>
              <svg class="dm-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .dm-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  /* Resting metrics come from .tandem-toolbar-ctl (toolbar-chrome.css); the
     hover / focus / open states are this control's own, per the cascade
     contract. The open state is a neutral press, never an accent: in this bar
     the accent marks formatting applied to the selection. */
  .dm-trigger {
    flex-shrink: 0;
    transition: background 120ms, color 120ms, box-shadow 120ms;
  }
  :global(body.tandem-reduce-motion) .dm-trigger {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .dm-trigger {
      transition: none;
    }
  }
  .dm-trigger:hover {
    background: var(--tandem-surface-muted);
    color: var(--tandem-fg);
  }
  .dm-trigger:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
  .dm-trigger[aria-expanded="true"],
  .dm-trigger[aria-expanded="true"]:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
    box-shadow: var(--tandem-shadow-inset);
  }
  .dm-glyph {
    font-size: var(--tandem-text-sm);
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .dm-menu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    min-width: 200px;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
    box-shadow: var(--tandem-shadow-2);
    padding: var(--tandem-space-1);
    z-index: var(--tandem-z-dropdown);
  }
  .dm-head {
    padding: 7px 10px 3px;
    color: var(--tandem-fg-subtle);
    font-size: var(--tandem-text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-family: var(--tandem-font-mono);
  }
  .dm-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    background: transparent;
    color: var(--tandem-fg);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    border-radius: var(--tandem-r-2);
    box-sizing: border-box;
  }
  .dm-item:hover,
  .dm-item:focus-visible {
    background: var(--tandem-surface-sunk);
    outline: none;
  }
  .dm-label {
    flex: 1;
  }
  /* Checked state is a glyph, not a fill, so the current preset reads the same
     in forced-colors mode and never competes with the accent. */
  .dm-check {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--tandem-fg-muted);
    visibility: hidden;
  }
  .dm-item[aria-checked="true"] .dm-check {
    visibility: visible;
  }
</style>
