<script lang="ts" module>
import type { Component } from "svelte";
import type { TandemSettings } from "../hooks/useTandemSettings.svelte";

/**
 * Context passed to every settings tab body component.
 *
 * Wave 2 retires `SettingsPopover.svelte` and consolidates onto this modal.
 * Tab body components must accept this prop shape. Treat this contract as
 * stable: new fields should be added with defaults rather than breaking
 * existing tab implementations.
 *
 * **Do not destructure** the context with `const` — pass it through to
 * children so reactivity is preserved (see `feedback_svelte_getter_destructuring`).
 */
export interface SettingsTabContext {
  open: boolean;
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
  connected: boolean;
  reconnectAttempts: number;
}

/**
 * Registry entry for one tab in the SettingsModal sidebar.
 *
 * `icon` is an SVG path `d` attribute string, rendered in a 24x24 viewBox
 * with `stroke="currentColor"` (matches the existing `SettingsPopover` shape).
 *
 * Wave 2 (e.g. Network 2.0 panel, integrations registry) ships additional
 * tabs by passing an extended array to the `tabs` prop. The defaults from
 * `DEFAULT_SETTINGS_TABS` cover the same sections the popover renders.
 */
export interface SettingsTab {
  id: string;
  label: string;
  icon: string;
  component: Component<SettingsTabContext>;
}
</script>

<script lang="ts">
import { onMount, untrack } from "svelte";
import { TANDEM_ISSUES_NEW_URL } from "../../shared/constants";
import { API_OPEN } from "../../shared/api-paths";
import { createAppInfo } from "../hooks/useAppInfo.svelte";
import { API_BASE } from "../utils/fileUpload";
import AccessibilitySettings from "./AccessibilitySettings.svelte";
import AppearanceSettings from "./AppearanceSettings.svelte";
import EditorSettings from "./EditorSettings.svelte";
import NetworkSettings from "./NetworkSettings.svelte";
import SettingsCollaborationTab from "./settings-tabs/SettingsCollaborationTab.svelte";
import SettingsClaudeCodeTab from "./settings-tabs/SettingsClaudeCodeTab.svelte";
import SettingsShortcutsTab from "./settings-tabs/SettingsShortcutsTab.svelte";
import SettingsAboutTab from "./settings-tabs/SettingsAboutTab.svelte";

const HEADING_ID = "tandem-settings-modal-heading";
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Default tabs — mirror the sections exposed by `SettingsPopover.svelte`.
 *
 * Wave 2 will retire the popover; any Wave 2 additions land here as new
 * entries (or via the `tabs` prop) without touching this default array.
 *
 * **About the `as unknown as Component<SettingsTabContext>` casts:** the
 * existing settings sub-components (`AppearanceSettings`, `EditorSettings`,
 * `NetworkSettings`, `AccessibilitySettings`) declare narrower `Props`
 * interfaces — they only read a subset of the context fields. Svelte 5
 * silently drops unknown props when a component uses non-rest destructuring
 * in `$props()`, which is the desired runtime behavior: pass the uniform
 * context to every tab and let each component consume what it needs. The
 * casts are load-bearing; do not "fix" them by widening the sub-component
 * Props interfaces — that would force every Wave 2 settings panel to
 * declare fields it doesn't read.
 */
export const DEFAULT_SETTINGS_TABS: SettingsTab[] = [
  {
    id: "appearance",
    label: "Appearance",
    icon: "M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
    component: AppearanceSettings as unknown as Component<SettingsTabContext>,
  },
  {
    id: "editor",
    label: "Editor",
    icon: "M4 4h11M4 9h16M4 14h11M4 19h16",
    component: EditorSettings as unknown as Component<SettingsTabContext>,
  },
  {
    id: "network",
    label: "Network",
    icon: "M3 12h18M3 12a9 9 0 0 1 18 0M3 12a9 9 0 0 0 18 0M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
    component: NetworkSettings as unknown as Component<SettingsTabContext>,
  },
  {
    id: "accessibility",
    label: "Accessibility",
    icon: "M12 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM4 9h16M9 9v5l-2 7M15 9v5l2 7M9 14h6",
    component: AccessibilitySettings as unknown as Component<SettingsTabContext>,
  },
  {
    id: "collaboration",
    label: "Collaboration",
    icon: "M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM21 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11",
    component: SettingsCollaborationTab as unknown as Component<SettingsTabContext>,
  },
  {
    id: "claude-code",
    label: "Claude Code/Cowork",
    icon: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z",
    component: SettingsClaudeCodeTab as unknown as Component<SettingsTabContext>,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: "M3 7h2v2H3V7Zm0 4h2v2H3v-2Zm0 4h2v2H3v-2Zm4-8h2v2H7V7Zm0 4h2v2H7v-2Zm0 4h10v2H7v-2Zm4-8h10v2H11V7Zm0 4h6v2h-6v-2Zm8 0h2v2h-2v-2Z",
    component: SettingsShortcutsTab as unknown as Component<SettingsTabContext>,
  },
  {
    id: "about",
    label: "About",
    icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v6m0 4h.01",
    component: SettingsAboutTab as unknown as Component<SettingsTabContext>,
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
  returnFocusEl?: HTMLElement | null;
  /**
   * Trigger element to exempt from click-outside dismissal. The modal
   * container is exempted automatically.
   */
  triggerEl?: HTMLElement | null;
  connected?: boolean;
  reconnectAttempts?: number;
  /**
   * Optional override for the tabs list. Defaults to `DEFAULT_SETTINGS_TABS`.
   * Wave 2 lands additional tabs additively via this prop.
   */
  tabs?: SettingsTab[];
}

let {
  open,
  onClose,
  settings,
  onUpdate,
  returnFocusEl = null,
  triggerEl = null,
  connected = false,
  reconnectAttempts = 0,
  tabs = DEFAULT_SETTINGS_TABS,
}: Props = $props();

let modalEl: HTMLDivElement | undefined = $state();
const appInfo = createAppInfo(() => open);
let changelogLoading = $state(false);
let changelogError = $state<string | null>(null);

const resolvedTabs = $derived(tabs.length > 0 ? tabs : DEFAULT_SETTINGS_TABS);
let activeTabId = $state<string>(DEFAULT_SETTINGS_TABS[0].id);
// Always settle on a tab that exists in the current registry — handles the
// case where a caller passes a tabs prop that omits the previously active id.
const activeTab = $derived(
  resolvedTabs.find((t) => t.id === activeTabId) ?? resolvedTabs[0],
);
const activeTabLabel = $derived(activeTab.label);

const tabContext = $derived<SettingsTabContext>({
  open,
  settings,
  onUpdate,
  connected,
  reconnectAttempts,
});

// Initial focus on open. We deliberately avoid reading the bound modalEl
// from inside an $effect — that combination produces the
// $state+bind:this+$effect reactive loop (feedback_svelte_state_bind_this_loop).
// onMount fires only once after the first DOM commit, so it's safe to read
// modalEl there; on subsequent opens we re-focus via the open-watching
// effect that uses untrack() to avoid registering modalEl as a dependency.
onMount(() => {
  if (open) modalEl?.focus();
});

$effect(() => {
  if (!open) return;
  // Reading modalEl inside untrack() avoids the reactive loop while still
  // letting us focus on each open->true transition.
  untrack(() => modalEl?.focus());
  return () => {
    returnFocusEl?.focus();
  };
});

// Click-outside dismissal. Exempts BOTH the trigger element AND the modal
// container (feedback_click_outside_exempt_menu). Using .contains() is safe
// here because the modal is rendered inline (no portal); if a future caller
// portals it, swap to `.closest()` per feedback_portal_breaks_contains.
$effect(() => {
  if (!open) return;
  const handler = (e: PointerEvent) => {
    const target = e.target as Node | null;
    if (!target) return;
    if (triggerEl?.contains(target)) return;
    if (modalEl && !modalEl.contains(target)) {
      onClose();
    }
  };
  // Defer to next tick so the click that opened the modal doesn't immediately
  // close it.
  const timer = setTimeout(() => document.addEventListener("pointerdown", handler), 0);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("pointerdown", handler);
  };
});

// Escape + focus trap. Identical wrap-around behavior to SettingsPopover —
// re-query focusables on every Tab press because the 640px breakpoint
// reflows the sidebar into a row, which changes the focusable set.
$effect(() => {
  if (!open) return;
  const handler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key !== "Tab" || !modalEl) return;
    const focusables = modalEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!modalEl.contains(active)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
});

// Clear stale view-changelog errors when tab changes.
$effect(() => {
  activeTabId;
  changelogError = null;
});

async function handleViewChangelog(): Promise<void> {
  const filePath = appInfo.info?.changelogPath;
  if (!filePath) {
    changelogError = "Changelog file not found.";
    return;
  }
  changelogLoading = true;
  changelogError = null;
  try {
    const res = await fetch(`${API_BASE}${API_OPEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath, readOnly: true }),
    });
    if (!res.ok) {
      let msg = "Failed to open changelog.";
      try {
        const data = (await res.json()) as { message?: string };
        if (data.message) msg = data.message;
      } catch {
        // ignore JSON parse failure
      }
      if (res.status === 404) msg = "Changelog file not found.";
      changelogError = msg;
      return;
    }
    onClose();
  } catch (err) {
    console.warn("[Tandem] Failed to open changelog:", err);
    changelogError = "Server unavailable.";
  } finally {
    changelogLoading = false;
  }
}
</script>

{#if open}
  <div
    aria-hidden="true"
    onclick={onClose}
    data-testid="settings-modal-scrim"
    style="position: fixed; inset: 0; background: color-mix(in srgb, var(--tandem-bg) 70%, transparent); z-index: 9998;"
  ></div>
  <div
    bind:this={modalEl}
    data-testid="settings-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby={HEADING_ID}
    tabindex={-1}
    class="settings-modal"
  >
    <aside class="settings-modal-sidebar">
      <div class="settings-modal-sidebar-head">
        <div id={HEADING_ID} class="settings-modal-sidebar-title">Settings</div>
        {#if appInfo.info}
          <span
            class="settings-modal-version-chip"
            data-testid="settings-modal-sidebar-version"
          >
            v{appInfo.info.version}
          </span>
        {/if}
      </div>

      <nav aria-label="Settings sections" class="settings-modal-sidebar-nav">
        {#each resolvedTabs as tab (tab.id)}
          <button
            type="button"
            aria-current={activeTabId === tab.id ? "page" : undefined}
            data-active={activeTabId === tab.id ? "true" : "false"}
            data-testid={`settings-modal-tab-${tab.id}`}
            onclick={() => (activeTabId = tab.id)}
            class="settings-modal-nav-btn"
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              style="flex-shrink: 0;"
            >
              <path d={tab.icon} />
            </svg>
            <span>{tab.label}</span>
          </button>
        {/each}
      </nav>

      <div
        class="settings-modal-sidebar-foot"
        data-testid="settings-modal-sidebar-footer"
      >
        <button
          type="button"
          data-testid="settings-modal-view-changelog-btn"
          onclick={() => void handleViewChangelog()}
          disabled={changelogLoading || appInfo.loading}
          class="settings-modal-sidebar-link"
        >
          {changelogLoading ? "Opening…" : "Changelog"}
        </button>
        {#if changelogError}
          <div
            role="alert"
            data-testid="settings-modal-changelog-error"
            style="font-size: 11px; color: var(--tandem-error-fg); padding: 0 var(--tandem-space-2);"
          >
            {changelogError}
          </div>
        {/if}
        <a
          href={TANDEM_ISSUES_NEW_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="settings-modal-report-bug-link"
          class="settings-modal-sidebar-link"
        >
          Report a bug
        </a>
        <div
          class="settings-modal-sidebar-status"
          data-testid="settings-modal-mcp-status"
          aria-live="polite"
        >
          <span
            class="settings-modal-status-dot"
            data-state={connected
              ? "connected"
              : reconnectAttempts > 0
                ? "reconnecting"
                : "disconnected"}
          ></span>
          <span class="settings-modal-status-label">
            {#if connected}
              MCP connected
            {:else if reconnectAttempts > 0}
              Reconnecting…
            {:else}
              MCP offline
            {/if}
          </span>
        </div>
      </div>
    </aside>

    <section class="settings-modal-content" data-testid="settings-modal-content">
      <header class="settings-modal-content-head">
        <h2 class="settings-modal-content-title">{activeTabLabel}</h2>
        <button
          type="button"
          onclick={onClose}
          data-testid="settings-modal-close-btn"
          class="settings-modal-close"
          aria-label="Close settings"
        >
          ×
        </button>
      </header>

      <div class="settings-modal-content-body">
        <div class="settings-modal-content-inner">
          {#key activeTab.id}
            <activeTab.component {...tabContext} />
          {/key}
        </div>
      </div>
    </section>
  </div>
{/if}

<style>
  .settings-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(900px, calc(100vw - 32px));
    height: min(680px, calc(100vh - 32px));
    background: var(--tandem-surface);
    color: var(--tandem-fg);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-4);
    box-shadow: var(--tandem-shadow-3);
    z-index: 9999;
    display: grid;
    grid-template-columns: 188px minmax(0, 1fr);
    outline: none;
    overflow: hidden;
  }

  .settings-modal-sidebar {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-4);
    padding: var(--tandem-space-5) var(--tandem-space-3);
    border-right: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted);
    overflow-y: auto;
  }

  .settings-modal-sidebar-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--tandem-space-2);
    padding: 0 var(--tandem-space-2);
  }

  .settings-modal-sidebar-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--tandem-fg);
  }

  .settings-modal-version-chip {
    font-family: var(--tandem-font-mono);
    font-size: 10px;
    font-weight: 500;
    color: var(--tandem-fg-subtle);
    padding: 1px 6px;
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-surface);
    line-height: 1.5;
  }

  .settings-modal-sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }

  .settings-modal-nav-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--tandem-space-2);
    min-height: 34px;
    padding: 0 var(--tandem-space-3);
    border: 1px solid transparent;
    border-radius: var(--tandem-r-3);
    background: transparent;
    color: var(--tandem-fg-muted);
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }

  .settings-modal-nav-btn:hover {
    background: var(--tandem-surface);
    color: var(--tandem-fg);
  }

  .settings-modal-nav-btn:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }

  .settings-modal-nav-btn[data-active="true"] {
    background: var(--tandem-accent-bg);
    color: var(--tandem-accent-fg-strong);
    font-weight: 600;
  }

  .settings-modal-sidebar-foot {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: var(--tandem-space-3) var(--tandem-space-2) 0;
    margin-top: auto;
    border-top: 1px solid var(--tandem-border);
  }

  .settings-modal-sidebar-link {
    appearance: none;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--tandem-r-2);
    color: var(--tandem-fg-muted);
    font-size: 12px;
    font-weight: 500;
    text-align: left;
    text-decoration: none;
    padding: 6px var(--tandem-space-2);
    cursor: pointer;
  }

  .settings-modal-sidebar-link:hover:not(:disabled),
  .settings-modal-sidebar-link:focus-visible {
    color: var(--tandem-fg);
    background: var(--tandem-surface);
    outline: none;
  }

  .settings-modal-sidebar-link:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .settings-modal-sidebar-status {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px var(--tandem-space-2);
    font-size: 11px;
    color: var(--tandem-fg-subtle);
  }

  .settings-modal-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tandem-fg-subtle);
    flex-shrink: 0;
  }

  .settings-modal-status-dot[data-state="connected"] {
    background: var(--tandem-success);
  }

  .settings-modal-status-dot[data-state="reconnecting"] {
    background: var(--tandem-warning);
  }

  .settings-modal-status-dot[data-state="disconnected"] {
    background: var(--tandem-error);
  }

  .settings-modal-status-label {
    font-family: var(--tandem-font-mono);
    font-size: 10px;
    letter-spacing: 0.02em;
  }

  .settings-modal-content {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .settings-modal-content-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 56px;
    padding: 0 var(--tandem-space-5);
    border-bottom: 1px solid var(--tandem-border);
    background: var(--tandem-surface);
  }

  .settings-modal-content-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--tandem-fg);
    margin: 0;
  }

  .settings-modal-close {
    background: none;
    border: 1px solid transparent;
    cursor: pointer;
    color: var(--tandem-fg-subtle);
    font-size: 18px;
    line-height: 1;
    padding: 4px 8px;
    min-width: 30px;
    min-height: 30px;
    border-radius: var(--tandem-r-2);
  }

  .settings-modal-close:hover,
  .settings-modal-close:focus-visible {
    color: var(--tandem-fg);
    background: var(--tandem-surface-muted);
    outline: none;
  }

  .settings-modal-content-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--tandem-space-5);
  }

  .settings-modal-content-inner {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-5);
    max-width: 620px;
  }

  @media (max-width: 640px) {
    .settings-modal {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(auto, 45%) 1fr;
    }

    .settings-modal-sidebar {
      border-right: none;
      border-bottom: 1px solid var(--tandem-border);
      padding: var(--tandem-space-3);
    }
  }
</style>
