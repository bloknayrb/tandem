<script lang="ts">
import { clickOutside } from "../actions/clickOutside.svelte";

interface Props {
  showAuthorship: boolean;
  showComments: boolean;
  showHighlights: boolean;
  showNotes: boolean;
  /** Transient master overlay — suppresses all decoration rendering. */
  decorationsMuted: boolean;
  /**
   * Persist a settings partial. Per-type rows include `decorationsMuted: false`
   * in the same partial (one call) to auto-unmute; the eye toggles mute alone.
   */
  onUpdate: (partial: {
    showAuthorship?: boolean;
    showComments?: boolean;
    showHighlights?: boolean;
    showNotes?: boolean;
    decorationsMuted?: boolean;
  }) => void;
  /** Open Settings → Appearance (the canonical home for these toggles). */
  onOpenSettings?: () => void;
}

let {
  showAuthorship,
  showComments,
  showHighlights,
  showNotes,
  decorationsMuted,
  onUpdate,
  onOpenSettings,
}: Props = $props();

let menuOpen = $state(false);
let caretBtn = $state<HTMLButtonElement | null>(null);

function toggleMute() {
  onUpdate({ decorationsMuted: !decorationsMuted });
}

// Auto-unmute in ONE partial so the decoration + authorship effects fire once,
// avoiding a transient still-muted-with-new-value mid-state.
function toggleRow(
  field: "showAuthorship" | "showComments" | "showHighlights" | "showNotes",
  current: boolean,
) {
  onUpdate({ [field]: !current, ...(decorationsMuted ? { decorationsMuted: false } : {}) });
}

function closeMenu() {
  menuOpen = false;
  caretBtn?.focus();
}

function handleKey(e: KeyboardEvent) {
  if (e.key === "Escape" && menuOpen) {
    e.stopPropagation();
    closeMenu();
  }
}

function chooseSettings() {
  onOpenSettings?.();
  menuOpen = false;
}
</script>

<!-- Both split halves AND the dropdown live inside one clickOutside node:
     clickOutside uses node.contains(), so a separate wrapper would treat a
     click on the eye/caret as "outside" and instantly re-close. NOT portaled.
     Rendered flat (no own pill chrome): the embedding FormattingBar pill
     already supplies the surface/border/shadow, so the eye+caret read as
     toolbar segments rather than a nested pill-in-a-pill. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="split menu-wrap"
  class:open={menuOpen}
  data-testid="decorations-menu"
  data-tauri-drag-region="false"
  use:clickOutside={() => (menuOpen = false)}
  onkeydown={handleKey}
>
  <button
    type="button"
    class="ib half-main"
    class:on={!decorationsMuted}
    data-testid="decorations-mute-toggle"
    aria-pressed={!decorationsMuted}
    title={decorationsMuted ? "Restore decorations" : "Mute decorations"}
    aria-label={decorationsMuted ? "Restore decorations" : "Mute decorations"}
    onclick={toggleMute}
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  </button>
  <span class="split-div" aria-hidden="true"></span>
  <button
    bind:this={caretBtn}
    type="button"
    class="ib half-caret"
    data-testid="decorations-menu-caret"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    title="Decoration options"
    aria-label="Decoration options"
    onclick={() => (menuOpen = !menuOpen)}
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  </button>

  {#if menuOpen}
    <div class="menu" role="menu" aria-label="Decorations">
      <div class="menu-head">Decorations</div>
      <p class="menu-help">
        Inline editor overlays — author colors, comment, highlight, and note
        marks. Toggle a type to hide its marks in the document; side-panel cards
        stay.
      </p>

      <button
        type="button"
        class="mi"
        class:on={showAuthorship}
        data-testid="decorations-row-authorship"
        role="menuitemcheckbox"
        aria-checked={showAuthorship}
        onclick={() => toggleRow("showAuthorship", showAuthorship)}
      >
        <span class="mi-ic">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="9.5" cy="12" r="5" fill="var(--tandem-author-user)" />
            <circle cx="14.5" cy="12" r="5" fill="var(--tandem-author-claude)" />
          </svg>
        </span>
        <span class="mi-label">Authorship colors</span>
        <span class="chk" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
      </button>

      <button
        type="button"
        class="mi"
        class:on={showComments}
        data-testid="decorations-row-comments"
        role="menuitemcheckbox"
        aria-checked={showComments}
        onclick={() => toggleRow("showComments", showComments)}
      >
        <span class="mi-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-12.5 7.5L3 21l1.6-5A8.5 8.5 0 1 1 21 11.5z" /></svg>
        </span>
        <span class="mi-label">Comments</span>
        <span class="chk" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
      </button>

      <button
        type="button"
        class="mi"
        class:on={showHighlights}
        data-testid="decorations-row-highlights"
        role="menuitemcheckbox"
        aria-checked={showHighlights}
        onclick={() => toggleRow("showHighlights", showHighlights)}
      >
        <span class="mi-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="9" width="18" height="6" rx="2" fill="currentColor" opacity="0.25" stroke="none" /><path d="M4 6h16M4 18h11" /></svg>
        </span>
        <span class="mi-label">Highlights</span>
        <span class="chk" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
      </button>

      <button
        type="button"
        class="mi"
        class:on={showNotes}
        data-testid="decorations-row-notes"
        role="menuitemcheckbox"
        aria-checked={showNotes}
        onclick={() => toggleRow("showNotes", showNotes)}
      >
        <span class="mi-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5" /><path d="M8 13h7M8 17h4" /></svg>
        </span>
        <span class="mi-label">Notes <span class="mi-tag">· private</span></span>
        <span class="chk" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
      </button>

      {#if onOpenSettings}
        <div class="menu-div" role="separator"></div>
        <button
          type="button"
          class="mi link"
          data-testid="decorations-settings-link"
          role="menuitem"
          onclick={chooseSettings}
        >
          <span>Appearance settings…</span>
          <kbd>Ctrl+,</kbd>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* split button: eye (mute/restore all) + caret (open options). Flat — the
     host FormattingBar pill provides the surface chrome. */
  .split {
    display: inline-flex;
    align-items: center;
    gap: 0;
  }

  .menu-wrap {
    position: relative;
  }

  .ib {
    height: 26px;
    min-width: 26px;
    padding: 0 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--tandem-fg-muted);
    border-radius: var(--tandem-r-pill);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    cursor: pointer;
    transition: background 120ms, color 120ms;
    font: inherit;
    font-size: 12px;
  }
  .ib:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .ib.on {
    background: var(--tandem-accent-bg);
    color: var(--tandem-accent-fg-strong);
  }
  .ib:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
  .ib svg {
    width: 16px;
    height: 16px;
    display: block;
  }

  .half-main {
    border-radius: var(--tandem-r-pill) var(--tandem-r-2) var(--tandem-r-2) var(--tandem-r-pill);
    padding: 0 5px 0 9px;
  }
  .half-caret {
    border-radius: var(--tandem-r-2) var(--tandem-r-pill) var(--tandem-r-pill) var(--tandem-r-2);
    padding: 0 6px;
    min-width: 20px;
  }
  .half-caret svg {
    width: 12px;
    height: 12px;
  }

  .split-div {
    width: 1px;
    height: 16px;
    background: var(--tandem-border);
    flex-shrink: 0;
  }
  .half-main.on + .split-div {
    background: color-mix(in srgb, var(--tandem-accent-fg-strong) 30%, transparent);
  }

  /* dropdown */
  .menu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    min-width: 248px;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
    box-shadow: var(--tandem-shadow-3);
    padding: var(--tandem-space-1);
    z-index: var(--tandem-z-dropdown);
  }
  .menu-head {
    padding: 7px 10px 3px;
    color: var(--tandem-fg-subtle);
    font-size: var(--tandem-text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-family: var(--tandem-font-mono);
  }
  .menu-help {
    margin: 0;
    padding: 0 10px 7px;
    color: var(--tandem-fg-subtle);
    font-size: var(--tandem-text-2xs);
    line-height: 1.4;
  }
  .mi {
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
  .mi:hover,
  .mi:focus-visible {
    background: var(--tandem-surface-sunk);
    outline: none;
  }
  .mi-ic {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: var(--tandem-fg-muted);
    display: inline-flex;
  }
  .mi-ic svg {
    width: 16px;
    height: 16px;
  }
  .mi-label {
    flex: 1;
  }
  .mi-tag {
    /* --tandem-fg-subtle (not -faint): faint fails the AA margin on small text
       (per the 1.7/1.8 audit decision); "· private" is a supplementary hint. */
    color: var(--tandem-fg-subtle);
    font-size: 11px;
  }
  .chk {
    width: 17px;
    height: 17px;
    border-radius: var(--tandem-r-1);
    border: 1px solid var(--tandem-border-strong);
    display: inline-grid;
    place-items: center;
    flex-shrink: 0;
  }
  .mi.on .chk {
    background: var(--tandem-accent);
    border-color: var(--tandem-accent);
  }
  .chk svg {
    width: 12px;
    height: 12px;
    color: var(--tandem-accent-fg);
    opacity: 0;
  }
  .mi.on .chk svg {
    opacity: 1;
  }
  .menu-div {
    height: 1px;
    background: var(--tandem-border);
    margin: 4px 6px;
  }
  .mi.link {
    color: var(--tandem-fg-muted);
    font-size: 12px;
    justify-content: space-between;
  }
  .mi.link kbd {
    font-family: var(--tandem-font-mono);
    font-size: 10px;
    color: var(--tandem-fg-subtle);
  }
</style>
