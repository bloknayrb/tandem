<script lang="ts">
import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";
import type { Window as TauriWindow } from "@tauri-apps/api/window";
import { onDestroy, onMount, type Snippet } from "svelte";
import type { TandemMode } from "../../shared/types";
import ModeToggle from "../editor/toolbar/ModeToggle.svelte";
import { type ThemePreference } from "../hooks/useTandemSettings.svelte";
import { onOutsideEvent } from "../utils/dismiss-outside";
import { THEME_OPTIONS } from "./theme-options";

interface Props {
  /**
   * Optional center cluster, rendered between brand and actions. The wrap
   * sits outside the surrounding drag region so interactive children stay
   * clickable.
   */
  center?: Snippet;
  /** Current Tandem collaboration mode. */
  tandemMode?: TandemMode;
  onModeChange?: (mode: TandemMode) => void;
  /** Whether Claude is currently active — drives the small status dot. */
  claudeActive?: boolean;
  /** Theme preference (rendered with a checkmark in the brand menu). */
  theme?: ThemePreference;
  /** Set theme directly — wired from the brand menu's Color scheme section. */
  onSetTheme?: (theme: ThemePreference) => void;
  /** Open Help modal. */
  onOpenHelp?: () => void;
  /** Open Settings popover. */
  onOpenSettings?: () => void;
  /**
   * Stable prop slot reserved for the SettingsModal trigger. Currently
   * unused inside this component (Ctrl+Shift+, is routed through
   * `actions/builtin.svelte.ts`); destructured as `_onOpenSettingsModal`
   * below so svelte-check accepts the declared-but-unread prop.
   */
  onOpenSettingsModal?: () => void;
  /** Bindable settings button reference (used for keyboard shortcut anchoring). */
  settingsBtn?: HTMLButtonElement | null;
  /**
   * Whether a Tauri updater event has fired and not yet been acknowledged
   * (issue #660, D6 sub-piece). Renders a small dot on the gear icon. Driven
   * by `createUpdateAvailable()`; non-Tauri builds never render the dot
   * regardless of this prop (the hook returns `false` outside Tauri AND the
   * dot is wrapped in an `{#if isTauriRuntime()}` guard below).
   */
  updateAvailable?: boolean;
  /**
   * Label of the active default AI model (#659). When set, the titlebar
   * renders a small chip ("Opus", "GPT-4o", etc.) that opens Settings →
   * Models on click. `null` / `undefined` renders no chip — first-run
   * users with no configured models see nothing here until they pick one.
   */
  defaultModelLabel?: string | null;
  /** Click handler for the default-model chip. Receives no args. */
  onOpenModelsSettings?: () => void;
}

let {
  center,
  tandemMode,
  onModeChange,
  claudeActive = false,
  theme = "system",
  onSetTheme,
  onOpenHelp,
  onOpenSettings,
  onOpenSettingsModal: _onOpenSettingsModal,
  settingsBtn = $bindable(null),
  updateAvailable = false,
  defaultModelLabel = null,
  onOpenModelsSettings,
}: Props = $props();

let win = $state<TauriWindow | null>(null);
let isMaximized = $state(false);
let cleanupListeners: (() => void)[] = [];
// Tracks whether the component is still mounted so async `onMount` steps that
// resolve after `onDestroy` skip state writes and self-clean any listeners
// that were registered post-unmount.
let mounted = true;

onMount(async () => {
  if (!isTauriRuntime()) return;
  try {
    const [{ invoke }, { getCurrentWindow }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/window"),
    ]);
    if (!mounted) return;

    // Re-run decorum overlay setup now that the WebView page is loaded.
    // create_overlay_titlebar() injects JS hit-test logic cleared on navigation;
    // calling post-load keeps it alive so button clicks reach the WebView.
    // Failure leaves clicks landing on HTCAPTION (the OS treats them as drag);
    // log at error level so it's visible alongside the disabled-controls signal.
    await invoke("setup_overlay_titlebar").catch((e: unknown) => {
      console.error("[TitleBar] setup_overlay_titlebar failed:", e);
    });
    if (!mounted) return;

    const currentWin = getCurrentWindow();
    win = currentWin;
    isMaximized = await currentWin.isMaximized();
    if (!mounted) return;

    const unlistenResize = await currentWin.onResized(async () => {
      try {
        isMaximized = await currentWin.isMaximized();
      } catch (e) {
        console.warn("[TitleBar] isMaximized check failed on resize:", e);
      }
    });
    if (!mounted) {
      unlistenResize();
      return;
    }
    cleanupListeners.push(unlistenResize);

    const unlistenMove = await currentWin.onMoved(async () => {
      try {
        isMaximized = await currentWin.isMaximized();
      } catch (e) {
        console.warn("[TitleBar] isMaximized check failed on move:", e);
      }
    });
    if (!mounted) {
      unlistenMove();
      return;
    }
    cleanupListeners.push(unlistenMove);
  } catch (e) {
    console.error("[TitleBar] Window API initialization failed:", e);
  }
});

onDestroy(() => {
  mounted = false;
  cleanupListeners.forEach((fn) => fn());
});

async function minimize() {
  try {
    await win?.minimize();
  } catch (e) {
    console.error("[TitleBar] minimize failed:", e);
  }
}

async function toggleMaximize() {
  try {
    await win?.toggleMaximize();
  } catch (e) {
    console.error("[TitleBar] toggleMaximize failed:", e);
  }
}

async function closeWindow() {
  try {
    await win?.close();
  } catch (e) {
    console.error("[TitleBar] close failed:", e);
  }
}

let brandMenuOpen = $state(false);
let brandMenuEl = $state<HTMLDivElement | null>(null);

$effect(() => {
  if (!brandMenuOpen) return;
  return onOutsideEvent(
    () => brandMenuEl ?? settingsBtn,
    ["mousedown"],
    () => {
      brandMenuOpen = false;
    },
  );
});

function toggleBrandMenu() {
  brandMenuOpen = !brandMenuOpen;
}

function closeBrandMenu() {
  brandMenuOpen = false;
  settingsBtn?.focus();
}

function handleBrandMenuKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeBrandMenu();
  }
}

function selectTheme(t: ThemePreference) {
  onSetTheme?.(t);
  closeBrandMenu();
}

function chooseSettings() {
  onOpenSettings?.();
  brandMenuOpen = false;
}

function chooseHelp() {
  onOpenHelp?.();
  brandMenuOpen = false;
}
</script>

<!-- Root carries the drag region; interactive descendants opt back out
     with `data-tauri-drag-region="false"` (Tauri 2 inverse-opt-out pattern)
     so every non-button pixel is a window grab surface. -->
<div class="title-bar" data-testid="title-bar" data-tauri-drag-region>
  <div class="title-bar-left">
    <button
      bind:this={settingsBtn}
      type="button"
      class="brand-btn"
      data-testid="titlebar-brand-menu"
      data-tauri-drag-region="false"
      aria-label="Tandem menu"
      aria-haspopup="menu"
      aria-expanded={brandMenuOpen}
      onclick={toggleBrandMenu}
    >
      <img class="brand-mark" src="/logo.png" alt="" width="32" height="32" />
      {#if isTauriRuntime() && updateAvailable}
        <span
          class="titlebar-settings-dot"
          data-testid="titlebar-update-available-dot"
          aria-hidden="true"
        ></span>
      {/if}
    </button>
    {#if brandMenuOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        bind:this={brandMenuEl}
        class="brand-menu tandem-floating-pill"
        data-testid="titlebar-brand-menu-popover"
        data-tauri-drag-region="false"
        role="menu"
        tabindex="-1"
        aria-label="Tandem menu"
        onkeydown={handleBrandMenuKey}
      >
        {#if onSetTheme}
          <div class="brand-menu-heading">Color scheme</div>
          <div class="brand-theme-grid" role="group" aria-label="Color scheme">
            {#each THEME_OPTIONS as opt (opt.value)}
              <button
                type="button"
                class="brand-theme-sw"
                class:on={theme === opt.value}
                data-testid="brand-menu-theme-{opt.value}"
                data-theme-swatch={opt.value}
                role="menuitemradio"
                aria-checked={theme === opt.value}
                onclick={() => selectTheme(opt.value)}
              >
                <span class="brand-theme-dot" aria-hidden="true"></span>
                <span class="brand-theme-label">{opt.label}</span>
              </button>
            {/each}
          </div>
          {#if onOpenSettings || onOpenHelp}
            <div class="brand-menu-divider" role="separator"></div>
          {/if}
        {/if}
        {#if onOpenSettings}
          <button
            type="button"
            class="brand-menu-item"
            data-testid="brand-menu-settings"
            role="menuitem"
            onclick={chooseSettings}
          >
            <span>Settings…</span>
            <kbd class="brand-menu-kbd">Ctrl+,</kbd>
          </button>
        {/if}
        {#if onOpenHelp}
          <button
            type="button"
            class="brand-menu-item"
            data-testid="brand-menu-shortcuts"
            role="menuitem"
            onclick={chooseHelp}
          >
            <span>Keyboard Shortcuts</span>
            <kbd class="brand-menu-kbd">?</kbd>
          </button>
        {/if}
      </div>
    {/if}
  </div>

  <div class="title-bar-spacer title-bar-spacer-fixed" data-tauri-drag-region></div>

  {#if center}
    <div class="title-bar-center" data-tauri-drag-region="false">
      {@render center()}
    </div>
  {/if}

  <div class="title-bar-spacer" data-tauri-drag-region></div>

  <div class="title-bar-actions">
    {#if tandemMode && onModeChange}
      <ModeToggle {tandemMode} {onModeChange} />
    {/if}

    {#if claudeActive}
      <span
        class="status-dot"
        data-tauri-drag-region="false"
        title="AI assistant is connected"
        aria-label="AI assistant is connected"
      ></span>
    {/if}

    {#if defaultModelLabel && onOpenModelsSettings}
      <button
        type="button"
        class="model-chip"
        data-testid="titlebar-default-model"
        aria-label={`Default model: ${defaultModelLabel}. Open Settings → Models.`}
        title={`Default model: ${defaultModelLabel}`}
        onclick={onOpenModelsSettings}
      >
        <span class="model-chip-dot" aria-hidden="true"></span>
        <span class="model-chip-label">{defaultModelLabel}</span>
      </button>
    {/if}
  </div>

  {#if isTauriRuntime()}
    <div class="title-bar-spacer-sm" data-tauri-drag-region></div>
    <div class="title-bar-controls" data-tauri-drag-region="false">
      <button
        type="button"
        class="title-bar-btn"
        aria-label="Minimize"
        disabled={win === null}
        onclick={minimize}
      >
        <svg
          width="10"
          height="1"
          viewBox="0 0 10 1"
          aria-hidden="true"
          focusable="false"
        >
          <rect width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        class="title-bar-btn"
        aria-label={isMaximized ? "Restore" : "Maximize"}
        disabled={win === null}
        onclick={toggleMaximize}
      >
        {#if isMaximized}
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M3 0H10V7H7V10H0V3H3V0ZM3 3H1V9H6V7H3V3ZM4 1V6H9V1H4Z"
              fill="currentColor"
            />
          </svg>
        {:else}
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M0 0H10V10H0V0ZM1 2V9H9V2H1Z" fill="currentColor" />
          </svg>
        {/if}
      </button>
      <button
        type="button"
        class="title-bar-btn title-bar-close"
        aria-label="Close"
        disabled={win === null}
        onclick={closeWindow}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M1 0L0 1L4 5L0 9L1 10L5 6L9 10L10 9L6 5L10 1L9 0L5 4L1 0Z"
            fill="currentColor"
          />
        </svg>
      </button>
    </div>
  {/if}
</div>

<style>
  /* 3-cluster floating chrome: brand left, center snippet (DocumentTabs),
     actions right. Transparent so each cluster reads as floating over the
     canvas. */
  .title-bar {
    display: flex;
    align-items: center;
    padding: 14px 14px 4px;
    box-sizing: border-box;
    background: transparent;
    user-select: none;
    flex-shrink: 0;
  }

  /* `position: relative` anchors the absolutely-positioned brand-menu. */
  .title-bar-left {
    position: relative;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .title-bar-spacer {
    flex: 1 1 0;
    min-width: var(--tandem-space-2);
    /* Stretch to the title-bar's full content height so the drag region
       actually has a hit area; an empty div under flex `align-items: center`
       collapses to 0px tall otherwise. Explicit `align-self: stretch` —
       relying on the inherited `align-items` value breaks `flex-grow` in
       some browsers, so the keyword is set rather than omitted. */
    align-self: stretch;
  }

  /* Left-of-center spacer: fixed gap (not flex-grow) so the tab strip
     left-justifies against the brand cluster. The right spacer keeps
     `flex: 1 1 0` and absorbs all slack. */
  .title-bar-spacer-fixed {
    flex: 0 0 var(--tandem-space-3);
  }

  .title-bar-spacer-sm {
    flex: 0 0 var(--tandem-space-4);
  }


  /* Cap at 60% so brand + actions stay readable when the center fills with
     many tabs; DocumentTabs handles its own horizontal scroll past the cap.
     `z-index` lifts the tab strip above tauri-plugin-decorum's overlay
     drag-region so clicks on tab pills aren't intercepted. */
  .title-bar-center {
    display: flex;
    align-items: center;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 60%;
    position: relative;
    z-index: var(--tandem-z-titlebar);
  }

  /* The Tandem icon IS the menu trigger — no chrome around it.
     40×40 hit box with the 32×32 logo centered inside; the -10px
     negative margins keep the logo's optical center at the same
     titlebar coordinate it had when the box was 32×32 with -6px
     margins (so the rest of the title-bar rhythm is unaffected).
     Hover/active use transform scale on the logo (not a background
     fill) so the icon itself feels interactive without a chip ring. */
  .brand-btn {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    margin: -10px 0 0 -10px;
    border: none;
    background: transparent;
    color: var(--tandem-fg);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .brand-btn :global(.brand-mark) {
    transition: transform 140ms ease;
  }

  .brand-btn:hover :global(.brand-mark) {
    transform: scale(1.12);
  }

  .brand-btn:active :global(.brand-mark) {
    transform: scale(0.96);
  }

  .brand-btn:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 2px;
    border-radius: var(--tandem-r-pill);
  }

  .brand-mark {
    display: block;
    flex-shrink: 0;
  }

  /* Dropdown anchored to the icon — `tandem-floating-pill` supplies the
     surface treatment; this rule only positions and packs the menu. */
  .brand-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    min-width: 220px;
    padding: var(--tandem-space-1);
    border-radius: var(--tandem-r-3);
    display: flex;
    flex-direction: column;
    gap: 2px;
    z-index: var(--tandem-z-modal);
  }

  .brand-menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--tandem-space-3);
    width: 100%;
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: var(--tandem-fg);
    font: inherit;
    font-size: var(--tandem-text-sm);
    text-align: left;
    cursor: pointer;
    border-radius: var(--tandem-r-2);
  }

  .brand-menu-item:hover,
  .brand-menu-item:focus-visible {
    background: var(--tandem-surface-sunk);
    outline: none;
  }

  .brand-menu-kbd {
    color: var(--tandem-fg-subtle);
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
  }

  .brand-menu-divider {
    height: 1px;
    background: var(--tandem-border);
    margin: 4px 6px;
  }

  .brand-menu-heading {
    padding: 6px 10px 2px;
    color: var(--tandem-fg-subtle);
    font-size: var(--tandem-text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* 2×2 swatch grid for the 4 themes (system/light/dark/warm). Each
     swatch is a square color chip + label. The "system" swatch uses a
     diagonal half-light/half-dark split, the conventional indicator for
     auto/match-system in OS theme pickers. */
  .brand-theme-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    padding: 4px 6px 6px;
  }

  .brand-theme-sw {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid transparent;
    border-radius: var(--tandem-r-2);
    background: transparent;
    color: var(--tandem-fg);
    font: inherit;
    font-size: var(--tandem-text-sm);
    text-align: left;
    cursor: pointer;
  }

  .brand-theme-sw:hover,
  .brand-theme-sw:focus-visible {
    background: var(--tandem-surface-sunk);
    outline: none;
  }

  .brand-theme-sw.on {
    border-color: var(--tandem-accent-border);
    background: var(--tandem-accent-bg);
    color: var(--tandem-accent-fg-strong);
  }

  .brand-theme-dot {
    width: 14px;
    height: 14px;
    border-radius: var(--tandem-r-circle);
    border: 1px solid var(--tandem-border-strong);
    flex-shrink: 0;
  }

  .brand-theme-sw[data-theme-swatch="system"] .brand-theme-dot {
    background: linear-gradient(
      135deg,
      var(--tandem-bg) 0%,
      var(--tandem-bg) 50%,
      var(--tandem-fg) 50%,
      var(--tandem-fg) 100%
    );
  }
  .brand-theme-sw[data-theme-swatch="light"] .brand-theme-dot {
    background: var(--tandem-swatch-light);
  }
  .brand-theme-sw[data-theme-swatch="dark"] .brand-theme-dot {
    background: var(--tandem-swatch-dark);
  }
  .brand-theme-sw[data-theme-swatch="warm"] .brand-theme-dot {
    background: var(--tandem-swatch-warm);
  }

  .brand-theme-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title-bar-actions {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-2);
    padding: 0 var(--tandem-space-2);
    flex-shrink: 0;
    /* Same z-index lift reason as .title-bar-center — buttons need to sit
       above decorum's overlay drag-region to receive clicks. */
    position: relative;
    z-index: var(--tandem-z-titlebar);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: var(--tandem-r-circle);
    background: var(--tandem-author-claude);
    display: inline-block;
    flex-shrink: 0;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--tandem-author-claude) 18%, transparent);
  }

  /* #659 default-model chip. Sits in the right action cluster; clicking
     opens Settings → Models. Compact so it doesn't crowd the toolbar; the
     accent-tinted dot signals "active model" without occupying the same
     visual slot as the Claude-active status dot on the brand side. */
  .model-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 8px;
    margin: 0 4px;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-pill);
    color: var(--tandem-fg-muted);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    max-width: 160px;
  }
  .model-chip:hover {
    background: var(--tandem-surface-muted);
    color: var(--tandem-fg);
  }
  .model-chip-dot {
    width: 6px;
    height: 6px;
    border-radius: var(--tandem-r-circle);
    background: var(--tandem-accent);
    flex-shrink: 0;
  }
  .model-chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Pinned to the top-right of the brand icon when an updater event has
     fired and not been acknowledged. The contrasting ring keeps WCAG AA
     against --tandem-bg in both themes. */
  .titlebar-settings-dot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 7px;
    height: 7px;
    border-radius: var(--tandem-r-circle);
    background: var(--tandem-info);
    box-shadow: 0 0 0 2px var(--tandem-surface-muted);
    pointer-events: none;
  }

  @media (forced-colors: active) {
    .titlebar-settings-dot {
      background: Highlight;
      box-shadow: 0 0 0 2px Canvas;
    }
  }

  /* Bare window controls — no pill chrome, flush with the window's
     top-right corner. Negative margins cancel the titlebar's top/right
     padding so the close button sits at (0, 0) relative to the window
     corner; `z-index` lifts the cluster above decorum's overlay drag
     region so the buttons receive clicks. */
  .title-bar-controls {
    display: inline-flex;
    align-items: center;
    height: 30px;
    margin-top: -14px;
    margin-right: -14px;
    margin-left: 6px;
    align-self: flex-start;
    flex-shrink: 0;
    position: relative;
    z-index: var(--tandem-z-titlebar);
  }

  .title-bar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 30px;
    border: none;
    background: transparent;
    color: var(--tandem-fg-muted);
    cursor: pointer;
    padding: 0;
    transition: background 0.1s, color 0.1s;
  }

  .title-bar-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--tandem-fg) 6%, transparent);
    color: var(--tandem-fg);
  }

  .title-bar-btn:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: -2px;
  }

  .title-bar-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .title-bar-close:hover:not(:disabled) {
    background: var(--tandem-error);
    color: var(--tandem-error-fg);
  }

  @media (forced-colors: active) {
    .title-bar {
      background: ButtonFace;
      border-bottom: 1px solid ButtonText;
      forced-color-adjust: auto;
    }

    .title-bar-btn {
      background: ButtonFace;
      color: ButtonText;
      border: 1px solid ButtonText;
    }

    .title-bar-btn:hover:not(:disabled) {
      background: Highlight;
      color: HighlightText;
    }

    .title-bar-close:hover:not(:disabled) {
      background: Highlight;
      color: HighlightText;
    }
  }
</style>
