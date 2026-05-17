<script lang="ts">
import {
  SELECTION_DWELL_MAX_MS,
  SELECTION_DWELL_MIN_MS,
  TANDEM_ISSUES_NEW_URL,
  USER_NAME_MAX_LEN,
} from "../../shared/constants";
import { ACTION_GROUPS, getActionsMap } from "../actions/registry.svelte.js";
import { isTauriRuntime } from "../cowork/cowork-helpers";
import { createAppInfo } from "../hooks/useAppInfo.svelte";
import type { TandemSettings } from "../hooks/useTandemSettings.svelte";
import { createUserName } from "../hooks/useUserName.svelte";
import { openServerPath } from "../utils/server-paths";
import AccessibilitySettings from "./AccessibilitySettings.svelte";
import AppearanceSettings from "./AppearanceSettings.svelte";
import EditorSettings from "./EditorSettings.svelte";
import NetworkSettings from "./NetworkSettings.svelte";

const HEADING_ID = "tandem-settings-heading";
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
type SettingsSection =
  | "appearance"
  | "editor"
  | "network"
  | "accessibility"
  | "collaboration"
  | "claude-code"
  | "shortcuts"
  | "about";

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: string }> = [
  {
    id: "appearance",
    label: "Appearance",
    icon: "M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  },
  {
    id: "editor",
    label: "Editor",
    icon: "M4 4h11M4 9h16M4 14h11M4 19h16",
  },
  {
    id: "network",
    label: "Network",
    icon: "M3 12h18M3 12a9 9 0 0 1 18 0M3 12a9 9 0 0 0 18 0M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  },
  {
    id: "accessibility",
    label: "Accessibility",
    icon: "M12 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM4 9h16M9 9v5l-2 7M15 9v5l2 7M9 14h6",
  },
  {
    id: "collaboration",
    label: "Collaboration",
    icon: "M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM21 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11",
  },
  {
    id: "claude-code",
    label: "AI Assistant",
    icon: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z",
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: "M3 7h2v2H3V7Zm0 4h2v2H3v-2Zm0 4h2v2H3v-2Zm4-8h2v2H7V7Zm0 4h2v2H7v-2Zm0 4h10v2H7v-2Zm4-8h10v2H11V7Zm0 4h6v2h-6v-2Zm8 0h2v2h-2v-2Z",
  },
  {
    id: "about",
    label: "About",
    icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v6m0 4h.01",
  },
];

// Static shortcuts not yet in the action registry (nav, help, modifier keys)
const STATIC_SHORTCUT_ROWS = [
  { keys: "Ctrl+B", description: "Bold" },
  { keys: "Ctrl+I", description: "Italic" },
  { keys: "Ctrl+Z", description: "Undo" },
  { keys: "Ctrl+Y", description: "Redo" },
  { keys: "Ctrl+F", description: "Find / Replace" },
  { keys: "?", description: "Show keyboard shortcuts" },
  { keys: "Ctrl+Tab", description: "Next document tab" },
  { keys: "Ctrl+Shift+Tab", description: "Previous document tab" },
];

// Derive sections from registry — groups with shortcut-bearing actions
const registryShortcutSections = $derived.by(() => {
  const actionsMap = getActionsMap();
  const byGroup = new Map<string, Array<{ keys: string; description: string }>>();
  for (const action of actionsMap.values()) {
    if (!action.shortcut) continue;
    const group = action.group;
    const rows = byGroup.get(group) ?? [];
    rows.push({ keys: action.shortcut, description: action.label });
    byGroup.set(group, rows);
  }
  return ACTION_GROUPS.map((g) => ({
    title: g.charAt(0).toUpperCase() + g.slice(1),
    rows: byGroup.get(g) ?? [],
  })).filter((s) => s.rows.length > 0);
});

interface Props {
  open: boolean;
  onClose: () => void;
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
  returnFocusEl?: HTMLElement | null;
  anchorEl?: HTMLElement | null;
  connected?: boolean;
  reconnectAttempts?: number;
}

let {
  open,
  onClose,
  settings,
  onUpdate,
  returnFocusEl,
  anchorEl,
  connected = false,
  reconnectAttempts = 0,
}: Props = $props();

let popoverEl: HTMLDivElement | undefined = $state();
let inputEl: HTMLInputElement | undefined = $state();

const userNameState = createUserName();
let nameInput = $state(userNameState.userName);

const appInfo = createAppInfo(() => open);
let changelogLoading = $state(false);
let changelogError = $state<string | null>(null);
let docsLoading = $state(false);
let docsError = $state<string | null>(null);
let activeSection = $state<SettingsSection>("appearance");

// Clear stale fetch errors when the user navigates between sections.
$effect(() => {
  activeSection;
  changelogError = null;
  docsError = null;
});

// Idle-sync: sync only when NOT focused and value differs
$effect(() => {
  const currentUserName = userNameState.userName;
  if (nameInput !== currentUserName && document.activeElement !== inputEl) {
    nameInput = currentUserName;
  }
});

// Initial focus + focus return on close
$effect(() => {
  if (!open) return;
  popoverEl?.focus();
  return () => {
    returnFocusEl?.focus();
  };
});

// Outside-dismiss on pointerdown
$effect(() => {
  if (!open) return;
  const handler = (e: PointerEvent) => {
    const target = e.target as Node;
    if (anchorEl?.contains(target)) return;
    if (popoverEl && !popoverEl.contains(target)) {
      onClose();
    }
  };
  // Defer to avoid immediately firing on the click that opened the popover
  const timer = setTimeout(() => document.addEventListener("pointerdown", handler), 0);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("pointerdown", handler);
  };
});

// Escape to close + focus trap on Tab
$effect(() => {
  if (!open) return;
  const handler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key !== "Tab" || !popoverEl) return;
    // Re-query focusables on every Tab press (intentional). At the 640px
    // breakpoint the layout reflows from two-column to single-column, which
    // can add or remove scrollable overflow elements — a stale cached list
    // would produce dead-ends in the focus cycle.
    const focusables = popoverEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!popoverEl.contains(active)) {
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

async function openReadOnlyFile(
  filePath: string | undefined,
  setLoading: (v: boolean) => void,
  setError: (v: string | null) => void,
  labels: { notFound: string; failed: string },
): Promise<void> {
  if (!filePath) {
    setError(labels.notFound);
    return;
  }
  setLoading(true);
  setError(null);
  try {
    const result = await openServerPath(filePath, {
      readOnly: true,
      notFoundMessage: labels.notFound,
      failureMessage: labels.failed,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  } finally {
    setLoading(false);
  }
}

function handleViewDocumentation(): Promise<void> {
  return openReadOnlyFile(
    appInfo.info?.workflowsPath,
    (v) => (docsLoading = v),
    (v) => (docsError = v),
    { notFound: "Documentation file not found.", failed: "Failed to open documentation." },
  );
}

function handleViewChangelog(): Promise<void> {
  return openReadOnlyFile(
    appInfo.info?.changelogPath,
    (v) => (changelogLoading = v),
    (v) => (changelogError = v),
    { notFound: "Changelog file not found.", failed: "Failed to open changelog." },
  );
}

const sectionLabelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";

function panelHeading(section: SettingsSection): string {
  return SECTIONS.find((s) => s.id === section)?.label ?? "Settings";
}

function aboutRows() {
  const info = appInfo.info;
  if (!info) return [];

  const rows: Array<{ label: string; value: string }> = [
    { label: "Version", value: `Tandem v${info.version}` },
    {
      label: "Tools",
      value:
        info.toolCount === null ? "Tool count unavailable" : `${info.toolCount} tools available`,
    },
    { label: "MCP SDK", value: `MCP SDK ${info.mcpSdkVersion}` },
    { label: "Transport", value: info.transport?.toUpperCase() ?? "—" },
  ];

  if (info.storagePath) rows.push({ label: "Storage", value: info.storagePath });
  if (info.tokenRotatedAt !== undefined) {
    rows.push({
      label: "Token",
      value:
        info.tokenRotatedAt === null
          ? "Token not created"
          : `Token rotated ${new Date(info.tokenRotatedAt).toLocaleString()}`,
    });
  }
  if (info.changelogPath) rows.push({ label: "Changelog", value: info.changelogPath });

  return rows;
}
</script>

{#if open}
  <div
    aria-hidden="true"
    onclick={onClose}
    style="position: fixed; inset: 0; background: color-mix(in srgb, var(--tandem-bg) 70%, transparent); z-index: 9998;"
  ></div>
  <div
    bind:this={popoverEl}
    data-testid="settings-popover"
    role="dialog"
    aria-modal="true"
    aria-labelledby={HEADING_ID}
    tabindex={-1}
    class="settings-dialog"
  >
    <aside class="settings-sidebar">
      <div class="settings-sidebar-head">
        <div id={HEADING_ID} class="settings-sidebar-title">Settings</div>
        {#if appInfo.info}
          <span class="settings-version-chip" data-testid="settings-sidebar-version">
            v{appInfo.info.version}
          </span>
        {/if}
      </div>

      <nav aria-label="Settings sections" class="settings-sidebar-nav">
        {#each SECTIONS as section (section.id)}
          <button
            type="button"
            aria-current={activeSection === section.id ? "page" : undefined}
            data-active={activeSection === section.id ? "true" : "false"}
            onclick={() => (activeSection = section.id)}
            class="settings-nav-btn"
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
              <path d={section.icon} />
            </svg>
            <span>{section.label}</span>
          </button>
        {/each}
      </nav>

      <div class="settings-sidebar-foot" data-testid="settings-sidebar-footer">
        <button
          type="button"
          data-testid="view-changelog-btn"
          onclick={() => void handleViewChangelog()}
          disabled={changelogLoading || appInfo.loading}
          class="settings-sidebar-link"
        >
          {changelogLoading ? "Opening…" : "Changelog"}
        </button>
        {#if changelogError}
          <div
            role="alert"
            data-testid="changelog-error"
            style="font-size: 11px; color: var(--tandem-error-fg); padding: 0 var(--tandem-space-2);"
          >
            {changelogError}
          </div>
        {/if}
        <a
          href={TANDEM_ISSUES_NEW_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="report-bug-link"
          class="settings-sidebar-link"
        >
          Report a bug
        </a>
        <div
          class="settings-sidebar-status"
          data-testid="settings-mcp-status"
          aria-live="polite"
        >
          <span
            class="settings-status-dot"
            data-state={connected
              ? "connected"
              : reconnectAttempts > 0
                ? "reconnecting"
                : "disconnected"}
          ></span>
          <span class="settings-status-label">
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

    <section class="settings-content" data-testid="settings-content">
      <header
        style="display: flex; align-items: center; justify-content: space-between; min-height: 56px; padding: 0 var(--tandem-space-5); border-bottom: 1px solid var(--tandem-border); background: var(--tandem-surface);"
      >
        <h2 style="font-size: 16px; font-weight: 700; color: var(--tandem-fg); margin: 0;">
          {panelHeading(activeSection)}
        </h2>
        <button
          onclick={onClose}
          style="background: none; border: 1px solid transparent; cursor: pointer; color: var(--tandem-fg-subtle); font-size: 18px; line-height: 1; padding: 4px 8px; min-width: 30px; min-height: 30px; border-radius: var(--tandem-r-2);"
          aria-label="Close settings"
        >
          ×
        </button>
      </header>

      <div style="flex: 1; overflow-y: auto; padding: var(--tandem-space-5);">
        <div style="display: flex; flex-direction: column; gap: var(--tandem-space-5); max-width: 620px;">
          {#if activeSection === "collaboration"}
            <div>
              <label for="settings-display-name" style={sectionLabelStyle}>Display Name</label>
              <input
                bind:this={inputEl}
                id="settings-display-name"
                data-testid="settings-display-name"
                type="text"
                value={nameInput}
                oninput={(e) => { nameInput = (e.target as HTMLInputElement).value; }}
                onblur={() => userNameState.setUserName(nameInput)}
                onkeydown={(e) => {
                  if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    nameInput = userNameState.userName;
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
                maxlength={USER_NAME_MAX_LEN}
                style="width: 100%; padding: 8px 10px; font-size: 13px; color: var(--tandem-fg); background: var(--tandem-surface); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); outline: none;"
              />
            </div>

            <div>
              <div id="settings-default-mode-label" style={sectionLabelStyle}>Default Mode</div>
              <div
                role="radiogroup"
                aria-labelledby="settings-default-mode-label"
                style="display: flex; gap: var(--tandem-space-2);"
              >
                <button
                  type="button"
                  data-testid="default-mode-tandem-btn"
                  role="radio"
                  aria-checked={settings.defaultMode === "tandem"}
                  onclick={() => onUpdate({ defaultMode: "tandem" })}
                  style="flex: 1; padding: var(--tandem-space-2); min-height: 30px; border: 2px solid {settings.defaultMode === 'tandem' ? 'var(--tandem-accent)' : 'var(--tandem-border)'}; border-radius: var(--tandem-r-3); background: {settings.defaultMode === 'tandem' ? 'var(--tandem-accent-bg)' : 'var(--tandem-surface)'}; color: {settings.defaultMode === 'tandem' ? 'var(--tandem-accent-fg-strong)' : 'var(--tandem-fg-muted)'}; font-size: 12px; font-weight: {settings.defaultMode === 'tandem' ? 600 : 400}; cursor: pointer;"
                >
                  Tandem
                </button>
                <button
                  type="button"
                  data-testid="default-mode-solo-btn"
                  role="radio"
                  aria-checked={settings.defaultMode === "solo"}
                  onclick={() => onUpdate({ defaultMode: "solo" })}
                  style="flex: 1; padding: var(--tandem-space-2); min-height: 30px; border: 2px solid {settings.defaultMode === 'solo' ? 'var(--tandem-accent)' : 'var(--tandem-border)'}; border-radius: var(--tandem-r-3); background: {settings.defaultMode === 'solo' ? 'var(--tandem-accent-bg)' : 'var(--tandem-surface)'}; color: {settings.defaultMode === 'solo' ? 'var(--tandem-accent-fg-strong)' : 'var(--tandem-fg-muted)'}; font-size: 12px; font-weight: {settings.defaultMode === 'solo' ? 600 : 400}; cursor: pointer;"
                >
                  Solo
                </button>
              </div>
              <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
                Sets the preferred starting mode for new sessions.
              </div>
            </div>

            <label
              data-testid="solo-rail-hidden-toggle"
              style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;"
            >
              <input
                type="checkbox"
                checked={settings.soloRailHidden}
                onchange={(e) => onUpdate({ soloRailHidden: (e.target as HTMLInputElement).checked })}
                style="accent-color: var(--tandem-accent);"
              />
              <span>Hide side panel in Solo mode</span>
            </label>
            <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);">
              When enabled, the annotation panel hides automatically when you enter Solo mode and
              restores when you return to Tandem.
            </div>
          {:else if activeSection === "appearance"}
            <AppearanceSettings {open} {settings} {onUpdate} {connected} {reconnectAttempts} />
          {:else if activeSection === "editor"}
            <EditorSettings {open} {settings} {onUpdate} {connected} {reconnectAttempts} />
          {:else if activeSection === "network"}
            <NetworkSettings
              {open}
              {settings}
              {onUpdate}
              {connected}
              {reconnectAttempts}
            />
          {:else if activeSection === "accessibility"}
            <AccessibilitySettings {open} {settings} {onUpdate} {connected} {reconnectAttempts} />
          {:else if activeSection === "claude-code"}
            <div>
              <div style={sectionLabelStyle}>
                Selection Sensitivity:
                <span style="font-weight: 400; text-transform: none;">
                  {(settings.selectionDwellMs / 1000).toFixed(1)}s
                </span>
              </div>
              <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-bottom: 6px;">
                How long you must hold a selection before your AI notices it
              </div>
              <input
                data-testid="dwell-time-slider"
                type="range"
                min={SELECTION_DWELL_MIN_MS}
                max={SELECTION_DWELL_MAX_MS}
                step={100}
                value={settings.selectionDwellMs}
                oninput={(e) => onUpdate({ selectionDwellMs: Number((e.target as HTMLInputElement).value) })}
                style="width: 100%; accent-color: var(--tandem-accent);"
                aria-label="Selection dwell time"
              />
              <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--tandem-fg-subtle);">
                <span>{(SELECTION_DWELL_MIN_MS / 1000).toFixed(1)}s</span>
                <span>{(SELECTION_DWELL_MAX_MS / 1000).toFixed(1)}s</span>
              </div>
            </div>

            <label
              data-testid="selection-toolbar-toggle"
              style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;"
            >
              <input
                type="checkbox"
                checked={settings.selectionToolbar}
                onchange={(e) => onUpdate({ selectionToolbar: (e.target as HTMLInputElement).checked })}
                style="accent-color: var(--tandem-accent);"
              />
              <span>Show floating selection toolbar</span>
            </label>

            <label
              data-testid="margin-view-toggle"
              style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;"
            >
              <input
                type="checkbox"
                checked={settings.marginView}
                onchange={(e) => onUpdate({ marginView: (e.target as HTMLInputElement).checked })}
                style="accent-color: var(--tandem-accent);"
              />
              <span>Margin annotation view (Word-style)</span>
            </label>
            {#if isTauriRuntime()}
              {#await import("./CoworkSettings.svelte")}
                <div
                  data-testid="cowork-settings-suspense-fallback"
                  style="font-size: 12px; color: var(--tandem-fg-subtle);"
                >
                  Loading Cowork integration...
                </div>
              {:then mod}
                {@const CoworkSettingsComp = mod.default}
                <CoworkSettingsComp />
              {/await}
            {/if}
          {:else if activeSection === "shortcuts"}
            <div
              data-testid="settings-shortcuts-list"
              style="display: flex; flex-direction: column; gap: var(--tandem-space-4);"
            >
              {#each registryShortcutSections as section (section.title)}
                <section>
                  <div style={sectionLabelStyle}>{section.title}</div>
                  <div style="display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 14px; align-items: center;">
                    {#each section.rows as row (row.keys + row.description)}
                      <kbd style="justify-self: start; padding: 1px 6px; font-family: var(--tandem-font-mono); font-size: 11px; color: var(--tandem-fg); background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border-strong); border-bottom-width: 2px; border-radius: var(--tandem-r-2);">
                        {row.keys}
                      </kbd>
                      <span style="font-size: 13px; color: var(--tandem-fg-muted);">{row.description}</span>
                    {/each}
                  </div>
                </section>
              {/each}
              <!-- Static shortcuts not yet in the action registry -->
              <section>
                <div style={sectionLabelStyle}>Other</div>
                <div style="display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 14px; align-items: center;">
                  {#each STATIC_SHORTCUT_ROWS as row (row.keys + row.description)}
                    <kbd style="justify-self: start; padding: 1px 6px; font-family: var(--tandem-font-mono); font-size: 11px; color: var(--tandem-fg); background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border-strong); border-bottom-width: 2px; border-radius: var(--tandem-r-2);">
                      {row.keys}
                    </kbd>
                    <span style="font-size: 13px; color: var(--tandem-fg-muted);">{row.description}</span>
                  {/each}
                </div>
              </section>
            </div>
          {:else}
            <div>
              <button
                data-testid="view-documentation-btn"
                onclick={() => void handleViewDocumentation()}
                disabled={docsLoading || appInfo.loading}
                style="width: 100%; padding: var(--tandem-space-2); font-size: 13px; font-weight: 500; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); cursor: {docsLoading || appInfo.loading ? 'not-allowed' : 'pointer'}; background: var(--tandem-surface-muted); color: var(--tandem-fg); opacity: {docsLoading || appInfo.loading ? 0.6 : 1};"
              >
                {docsLoading ? "Opening…" : "View Documentation"}
              </button>
              {#if docsError}
                <div style="margin-top: 6px; font-size: 11px; color: var(--tandem-error-fg);">
                  {docsError}
                </div>
              {/if}
            </div>

            <div
              data-testid="app-info-footer"
              style="border-top: 1px solid var(--tandem-border); padding-top: 10px;"
            >
              <div style={sectionLabelStyle}>About</div>
              {#if appInfo.loading}
                <div style="font-size: 11px; color: var(--tandem-fg-subtle);">Loading...</div>
              {:else if appInfo.info}
                <dl style="display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 12px; margin: 0; font-size: 11px;">
                  {#each aboutRows() as row (row.label)}
                    <dt style="color: var(--tandem-fg-subtle);">{row.label}</dt>
                    <dd style="margin: 0; color: var(--tandem-fg-muted); overflow-wrap: anywhere;">{row.value}</dd>
                  {/each}
                </dl>
              {:else}
                <div style="font-size: 11px; color: var(--tandem-fg-subtle);">App info unavailable.</div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </section>
  </div>
{/if}

<style>
  .settings-dialog {
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

  .settings-sidebar {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-4);
    padding: var(--tandem-space-5) var(--tandem-space-3);
    border-right: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted);
    overflow-y: auto;
  }

  .settings-sidebar-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--tandem-space-2);
    padding: 0 var(--tandem-space-2);
  }

  .settings-sidebar-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--tandem-fg);
  }

  .settings-version-chip {
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

  .settings-sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }

  .settings-nav-btn {
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

  .settings-nav-btn[data-active="true"] {
    background: var(--tandem-accent-bg);
    color: var(--tandem-accent-fg-strong);
    font-weight: 600;
  }

  .settings-sidebar-foot {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: var(--tandem-space-3) var(--tandem-space-2) 0;
    margin-top: auto;
    border-top: 1px solid var(--tandem-border);
  }

  .settings-sidebar-link {
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

  .settings-sidebar-link:hover:not(:disabled),
  .settings-sidebar-link:focus-visible {
    color: var(--tandem-fg);
    background: var(--tandem-surface);
    outline: none;
  }

  .settings-sidebar-link:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .settings-sidebar-status {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px var(--tandem-space-2);
    font-size: 11px;
    color: var(--tandem-fg-subtle);
  }

  .settings-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tandem-fg-subtle);
    flex-shrink: 0;
  }

  .settings-status-dot[data-state="connected"] {
    background: var(--tandem-success);
  }

  .settings-status-dot[data-state="reconnecting"] {
    background: var(--tandem-warning);
  }

  .settings-status-dot[data-state="disconnected"] {
    background: var(--tandem-error);
  }

  .settings-status-label {
    font-family: var(--tandem-font-mono);
    font-size: 10px;
    letter-spacing: 0.02em;
  }

  .settings-content {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  @media (max-width: 640px) {
    .settings-dialog {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(auto, 45%) 1fr;
    }

    .settings-sidebar {
      border-right: none;
      border-bottom: 1px solid var(--tandem-border);
      padding: var(--tandem-space-3);
    }
  }
</style>
