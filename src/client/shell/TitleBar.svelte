<script lang="ts">
import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";
import type { Window as TauriWindow } from "@tauri-apps/api/window";
import { onDestroy, onMount, type Snippet } from "svelte";
import type { TandemMode } from "../../shared/types";
import ModeToggle from "../editor/toolbar/ModeToggle.svelte";
import { type ThemePreference } from "../hooks/useTandemSettings.svelte";
import { onOutsideEvent } from "../utils/dismiss-outside";

const THEME_OPTIONS = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "warm", label: "Warm" },
] as const satisfies readonly { value: ThemePreference; label: string }[];

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
  /** Authorship-color visibility toggle. */
  showAuthorship?: boolean;
  onAuthorshipChange?: (visible: boolean) => void;
  /** Open Help modal. */
  onOpenHelp?: () => void;
  /** Open Settings popover. */
  onOpenSettings?: () => void;
  /**
   * Open the new SettingsModal (Wave 1 stable prop slot). Wired separately
   * from `onOpenSettings` so the existing gear keeps invoking the popover
   * until Wave 2 retires it. Triggered today via the command palette /
   * `Ctrl+Shift+,` shortcut registered in `actions/builtin.svelte.ts`.
   * Intentionally unused inside this component — destructured as
   * `_onOpenSettingsModal` so the compiler treats it as an acknowledged
   * no-op rather than an oversight. Intentionally NOT wired to
   * `aria-keyshortcuts` on the gear (that attribute describes shortcuts
   * activating the labelled element; Ctrl+Shift+, opens a different surface).
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
}

let {
  center,
  tandemMode,
  onModeChange,
  claudeActive = false,
  theme = "system",
  onSetTheme,
  showAuthorship = false,
  onAuthorshipChange,
  onOpenHelp,
  onOpenSettings,
  onOpenSettingsModal: _onOpenSettingsModal,
  settingsBtn = $bindable(null),
  updateAvailable = false,
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

<!-- Root carries the drag region; every interactive descendant
     opts back out with `data-tauri-drag-region="false"`. This is the
     documented Tauri 2 inverse-opt-out pattern. It gives the user every
     non-button pixel of the titlebar as a grab surface. DocumentTabs and
     NewTabMenu's bail-out guards honor the opt-out so menu dismissal
     still works on clicks inside opted-out children. -->
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
      <!-- 256×256 source displayed at 32×32 — gives ~8× density so the
           hover scale-up stays inside native resolution and stays crisp. -->
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
        {#if onSetTheme}
          <div class="brand-menu-divider" role="separator"></div>
          <div class="brand-menu-heading">Color scheme</div>
          {#each THEME_OPTIONS as opt (opt.value)}
            <button
              type="button"
              class="brand-menu-item"
              data-testid="brand-menu-theme-{opt.value}"
              role="menuitemradio"
              aria-checked={theme === opt.value}
              onclick={() => selectTheme(opt.value)}
            >
              <span class="brand-menu-check" aria-hidden="true">
                {theme === opt.value ? "●" : "○"}
              </span>
              <span>{opt.label}</span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>

  <div class="title-bar-spacer" data-tauri-drag-region></div>

  {#if center}
    <div class="title-bar-center" data-tauri-drag-region="false">
      {@render center()}
    </div>
  {/if}

  <div class="title-bar-spacer" data-tauri-drag-region></div>

  <div class="title-bar-actions">
    {#if tandemMode && onModeChange}
      <span data-tauri-drag-region="false">
        <ModeToggle {tandemMode} {onModeChange} />
      </span>
    {/if}

    {#if claudeActive}
      <span
        class="status-dot"
        data-tauri-drag-region="false"
        title="AI assistant is connected"
        aria-label="AI assistant is connected"
      ></span>
    {/if}

    {#if onAuthorshipChange}
      <button
        type="button"
        class="icon-btn"
        class:active={showAuthorship}
        data-testid="toolbar-authorship-toggle"
        data-tauri-drag-region="false"
        aria-label={showAuthorship ? "Hide authorship colors" : "Show authorship colors"}
        aria-pressed={showAuthorship}
        title={showAuthorship ? "Hide authorship colors" : "Show authorship colors"}
        onclick={() => onAuthorshipChange(!showAuthorship)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="5.5" cy="8" r="3.2" fill="var(--tandem-author-user)" />
          <circle cx="10.5" cy="8" r="3.2" fill="var(--tandem-author-claude)" opacity="0.85" />
        </svg>
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
     actions right. The bar is transparent so each cluster reads as floating
     over the canvas. Drag region is carried by the brand cluster and the
     two flex gaps around the center — the center wrap is attribute-free so
     interactive children (tab pills, close buttons) stay clickable. */
  .title-bar {
    display: flex;
    align-items: center;
    padding: 14px 14px 4px;
    box-sizing: border-box;
    background: transparent;
    user-select: none;
    flex-shrink: 0;
  }

  /* Sibling drag spacers wrap the center + sit before the win controls.
     `.title-bar-left` is `position: relative` so the absolutely-positioned
     brand-menu anchors to it. */
  .title-bar-left {
    position: relative;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  /* Flex-grow drag spacers. The wide pair flanks the center cluster
     (DocumentTabs); a narrow one sits between actions and win controls so
     even with a tab fill close to the cap there's a draggable column right
     of the icon buttons. align-self defaults to inherit `align-items`, so
     stretching to the full bar height happens automatically — explicitly
     setting align-self: stretch breaks the flex-grow in some browsers. */
  .title-bar-spacer {
    flex: 1 1 0;
    min-width: var(--tandem-space-2);
    /* Stretch to the title-bar's full content height so the drag region
       actually has a hit area; an empty div with no intrinsic content
       collapses to 0px tall under flex `align-items: center`. */
    align-self: stretch;
  }

  .title-bar-spacer-sm {
    flex: 0 0 var(--tandem-space-4);
  }


  /* Cap at 60% so brand + actions stay readable when the center fills with
     many tabs; DocumentTabs handles its own horizontal scroll past the cap.
     `position: relative; z-index` lifts the tab strip above tauri-plugin-decorum's
     overlay drag-region (which is full-width and would otherwise intercept all
     clicks on the tabs). The drag-region gaps on either side stay at the default
     z so decorum's overlay handles window drag in those zones. */
  .title-bar-center {
    display: flex;
    align-items: center;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 60%;
    position: relative;
    z-index: 99999;
  }

  /* The Tandem icon IS the menu trigger — no chrome around it. The button is
     sized to the icon; hover scales it up slightly for affordance. The
     update-available dot pins to the top-right corner of the icon itself. */
  .brand-btn {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    margin: -6px 0 0 -6px;
    border: none;
    background: transparent;
    color: var(--tandem-fg);
    cursor: pointer;
    transition: transform 140ms ease;
    -webkit-tap-highlight-color: transparent;
  }

  .brand-btn:hover {
    transform: scale(1.08);
  }

  .brand-btn:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 2px;
    border-radius: var(--tandem-r-2);
  }

  .brand-btn:active {
    transform: scale(0.96);
  }

  .brand-mark {
    display: block;
    flex-shrink: 0;
  }

  /* Dropdown anchored to the icon. `tandem-floating-pill` supplies the
     surface treatment; this rule positions + sizes the menu and packs the
     items + heading + divider. */
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

  .brand-menu-item[aria-checked="true"] {
    color: var(--tandem-accent);
  }

  .brand-menu-check {
    display: inline-block;
    width: 14px;
    margin-right: var(--tandem-space-2);
    color: var(--tandem-fg-subtle);
    font-size: var(--tandem-text-xs);
  }

  .brand-menu-item[aria-checked="true"] .brand-menu-check {
    color: var(--tandem-accent);
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

  .title-bar-actions {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-2);
    padding: 0 var(--tandem-space-2);
    flex-shrink: 0;
    /* Same z-index lift reason as .title-bar-center — buttons need to sit
       above decorum's overlay drag-region to receive clicks. */
    position: relative;
    z-index: 99999;
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

  /* 30×30 circular soft-fill chip — always visible, not transparent-until-hover. */
  .icon-btn {
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 1px solid transparent;
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg-muted);
    cursor: pointer;
    padding: 0;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }

  .icon-btn:hover {
    background: var(--tandem-surface);
    color: var(--tandem-fg);
  }

  .icon-btn:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }

  .icon-btn.active {
    background: var(--tandem-accent-bg);
    color: var(--tandem-accent);
  }

  /* Update-available dot — pinned to the top-right corner of the brand
     icon when a Tauri updater event has fired and not been acknowledged
     yet (issue #660). The brand-btn is `position: relative` so this
     absolute positioning targets the button's box. WCAG AA against
     --tandem-bg in both themes via the contrasting ring. */
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

  /* Bare window controls — no pill chrome, flush with the window's top-right
     corner so they read as OS chrome distinct from the in-app actions. The
     titlebar has `padding: 14px 14px 4px`; negative margin-top/-right cancel
     the top and right padding so the close button sits at (0, 0) relative to
     the window corner. `position: relative; z-index` lifts the cluster above
     tauri-plugin-decorum's overlay drag-region (same rationale as
     .title-bar-center / .title-bar-actions) so the buttons receive clicks
     instead of the overlay treating them as drag surface. */
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
    z-index: 99999;
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

    .icon-btn,
    .title-bar-btn {
      background: ButtonFace;
      color: ButtonText;
      border: 1px solid ButtonText;
    }

    .icon-btn:hover:not(:disabled),
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
