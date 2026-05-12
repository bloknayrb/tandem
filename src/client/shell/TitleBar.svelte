<script lang="ts">
import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";
import type { Window as TauriWindow } from "@tauri-apps/api/window";
import { onDestroy, onMount } from "svelte";
import type { TandemMode } from "../../shared/types";
import ModeToggle from "../editor/toolbar/ModeToggle.svelte";
import { THEME_LABEL, type ThemePreference } from "../hooks/useTandemSettings.svelte";

interface Props {
  /** Current Tandem collaboration mode. */
  tandemMode?: TandemMode;
  onModeChange?: (mode: TandemMode) => void;
  /** Whether Claude is currently active — drives the small status dot. */
  claudeActive?: boolean;
  /** Left rail panel visibility + toggle. */
  leftPanelVisible?: boolean;
  onToggleLeftPanel?: () => void;
  /** Right rail panel visibility + toggle. */
  rightPanelVisible?: boolean;
  onToggleRightPanel?: () => void;
  /** Theme preference + cycle callback (system → dark → light → system). */
  theme?: ThemePreference;
  onCycleTheme?: () => void;
  /** Authorship-color visibility toggle. */
  showAuthorship?: boolean;
  onAuthorshipChange?: (visible: boolean) => void;
  /** Open Help modal. */
  onOpenHelp?: () => void;
  /** Open Settings popover. */
  onOpenSettings?: () => void;
  /** Bindable settings button reference (used for keyboard shortcut anchoring). */
  settingsBtn?: HTMLButtonElement | null;
}

let {
  tandemMode,
  onModeChange,
  claudeActive = false,
  leftPanelVisible = false,
  onToggleLeftPanel,
  rightPanelVisible = false,
  onToggleRightPanel,
  theme = "system",
  onCycleTheme,
  showAuthorship = false,
  onAuthorshipChange,
  onOpenHelp,
  onOpenSettings,
  settingsBtn = $bindable(null),
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

const themeLabel = $derived(THEME_LABEL[theme]);
</script>

<div class="title-bar" data-testid="title-bar">
  <div class="title-bar-left" data-tauri-drag-region>
    <span class="brand" aria-label="Tandem">
      <img class="brand-mark" src="/favicon.png" alt="" width="20" height="20" />
      <span class="brand-wordmark">Tandem</span>
    </span>
  </div>

  <div class="title-bar-drag" data-tauri-drag-region></div>

  <div class="title-bar-actions">
    {#if tandemMode && onModeChange}
      <ModeToggle {tandemMode} {onModeChange} />
    {/if}

    {#if claudeActive}
      <span
        class="status-dot"
        title="Claude is connected"
        aria-label="Claude is connected"
      ></span>
    {/if}

    {#if onAuthorshipChange}
      <button
        type="button"
        class="icon-btn"
        class:active={showAuthorship}
        data-testid="toolbar-authorship-toggle"
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

    <span class="actions-divider" aria-hidden="true"></span>

    {#if onToggleLeftPanel}
      {@render panelToggleBtn("left", leftPanelVisible, onToggleLeftPanel)}
    {/if}

    {#if onToggleRightPanel}
      {@render panelToggleBtn("right", rightPanelVisible, onToggleRightPanel)}
    {/if}

    {#if onCycleTheme}
      <button
        type="button"
        class="icon-btn"
        data-testid="titlebar-theme-toggle"
        aria-label={themeLabel}
        title={themeLabel}
        onclick={onCycleTheme}
      >
        {#if theme === "light"}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4" fill="none" />
            <g stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
              <line x1="8" y1="1.5" x2="8" y2="3" />
              <line x1="8" y1="13" x2="8" y2="14.5" />
              <line x1="1.5" y1="8" x2="3" y2="8" />
              <line x1="13" y1="8" x2="14.5" y2="8" />
              <line x1="3.2" y1="3.2" x2="4.3" y2="4.3" />
              <line x1="11.7" y1="11.7" x2="12.8" y2="12.8" />
              <line x1="3.2" y1="12.8" x2="4.3" y2="11.7" />
              <line x1="11.7" y1="4.3" x2="12.8" y2="3.2" />
            </g>
          </svg>
        {:else if theme === "dark"}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M13.5 10A5.5 5.5 0 0 1 6 2.5a6 6 0 1 0 7.5 7.5Z"
              fill="currentColor"
            />
          </svg>
        {:else}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 1.5a6.5 6.5 0 1 0 0 13Z"
              fill="currentColor"
            />
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.4" fill="none" />
          </svg>
        {/if}
      </button>
    {/if}

    {#if onOpenHelp}
      <button
        type="button"
        class="icon-btn"
        data-testid="titlebar-help-btn"
        aria-label="Help (?)"
        aria-keyshortcuts="?"
        title="Help (?)"
        onclick={onOpenHelp}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.4" fill="none" />
          <path
            d="M6 6.2A2 2 0 0 1 10 6.2c0 1.2-2 1.4-2 2.6"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            fill="none"
          />
          <circle cx="8" cy="11.5" r="0.85" fill="currentColor" />
        </svg>
      </button>
    {/if}

    {#if onOpenSettings}
      <button
        bind:this={settingsBtn}
        type="button"
        class="icon-btn"
        data-testid="settings-btn"
        aria-label="Settings"
        aria-keyshortcuts="Control+Comma"
        title="Settings (Ctrl+,)"
        onclick={onOpenSettings}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8.97 1.5h-1.94a.6.6 0 0 0-.59.49l-.22 1.18a4.7 4.7 0 0 0-1.18.68l-1.13-.42a.6.6 0 0 0-.72.27l-.97 1.68a.6.6 0 0 0 .13.76l.91.77a4.7 4.7 0 0 0 0 1.36l-.91.77a.6.6 0 0 0-.13.76l.97 1.68a.6.6 0 0 0 .72.27l1.13-.42c.36.28.76.51 1.18.68l.22 1.18a.6.6 0 0 0 .59.49h1.94a.6.6 0 0 0 .59-.49l.22-1.18a4.7 4.7 0 0 0 1.18-.68l1.13.42a.6.6 0 0 0 .72-.27l.97-1.68a.6.6 0 0 0-.13-.76l-.91-.77a4.7 4.7 0 0 0 0-1.36l.91-.77a.6.6 0 0 0 .13-.76l-.97-1.68a.6.6 0 0 0-.72-.27l-1.13.42a4.7 4.7 0 0 0-1.18-.68l-.22-1.18A.6.6 0 0 0 8.97 1.5Z"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
            fill="none"
          />
          <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3" fill="none" />
        </svg>
      </button>
    {/if}
  </div>

  {#if isTauriRuntime()}
    <div class="title-bar-controls">
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

{#snippet panelToggleBtn(side: "left" | "right", visible: boolean, onToggle: () => void)}
  {@const label = visible
    ? `Hide ${side} panel`
    : `Show ${side} panel`}
  <button
    type="button"
    class="icon-btn"
    class:active={visible}
    data-testid={`titlebar-toggle-${side}`}
    aria-label={label}
    aria-pressed={visible}
    title={label}
    onclick={onToggle}
  >
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="1.5"
        stroke="currentColor"
        stroke-width="1.4"
        fill="none"
      />
      <rect
        x={side === "left" ? 1.5 : 9.5}
        y="2.5"
        width="5"
        height="11"
        fill="currentColor"
        opacity="0.55"
      />
    </svg>
  </button>
{/snippet}

<style>
  .title-bar {
    display: flex;
    align-items: stretch;
    height: 40px;
    min-height: 40px;
    background: var(--tandem-surface-muted);
    border-bottom: 1px solid var(--tandem-border);
    user-select: none;
    flex-shrink: 0;
  }

  /* drag region — left brand area + center spacer carry data-tauri-drag-region */
  .title-bar-left {
    display: flex;
    align-items: center;
    padding-left: var(--tandem-space-3);
    flex-shrink: 0;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--tandem-space-2);
    color: var(--tandem-fg);
    font-weight: 700;
    font-size: var(--tandem-text-sm);
    letter-spacing: 0;
    pointer-events: none;
  }

  .brand-mark {
    display: inline-block;
    flex-shrink: 0;
  }

  .brand-wordmark {
    white-space: nowrap;
  }

  .title-bar-drag {
    flex: 1;
    min-width: 0;
  }

  .title-bar-actions {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-2);
    padding: 0 var(--tandem-space-2);
    flex-shrink: 0;
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

  .actions-divider {
    width: 1px;
    height: 18px;
    background: var(--tandem-border);
    margin: 0 var(--tandem-space-1);
    flex-shrink: 0;
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: var(--tandem-r-2);
    background: transparent;
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

  .title-bar-controls {
    display: flex;
    height: 100%;
    flex-shrink: 0;
  }

  .title-bar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 100%;
    border: none;
    background: transparent;
    color: var(--tandem-fg-muted);
    cursor: pointer;
    transition: background 0.1s;
  }

  .title-bar-btn:hover:not(:disabled) {
    background: var(--tandem-surface);
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
