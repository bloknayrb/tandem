<script lang="ts">
import {
  SELECTION_DWELL_MAX_MS,
  SELECTION_DWELL_MIN_MS,
  USER_NAME_MAX_LEN,
} from "../../shared/constants";
import { isTauriRuntime } from "../cowork/cowork-helpers";
import { createAppInfo } from "../hooks/useAppInfo.svelte";
import type { TandemSettings } from "../hooks/useTandemSettings.svelte";
import { createUserName } from "../hooks/useUserName.svelte";
import { API_BASE } from "../utils/fileUpload";
import AccessibilitySettings from "./AccessibilitySettings.svelte";
import AppearanceSettings from "./AppearanceSettings.svelte";
import EditorSettings from "./EditorSettings.svelte";

const HEADING_ID = "tandem-settings-heading";
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
type SettingsSection =
  | "profile"
  | "appearance"
  | "editor"
  | "accessibility"
  | "automation"
  | "about";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "profile", label: "Profile" },
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "accessibility", label: "Accessibility" },
  { id: "automation", label: "Automation" },
  { id: "about", label: "About" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
  returnFocusEl?: HTMLElement | null;
  anchorEl?: HTMLElement | null;
}

let { open, onClose, settings, onUpdate, returnFocusEl, anchorEl }: Props = $props();

let popoverEl: HTMLDivElement | undefined = $state();
let inputEl: HTMLInputElement | undefined = $state();

const userNameState = createUserName();
let nameInput = $state(userNameState.userName);

const appInfo = createAppInfo(() => open);
let changelogLoading = $state(false);
let changelogError = $state<string | null>(null);
let activeSection = $state<SettingsSection>("appearance");

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

async function handleViewChangelog(): Promise<void> {
  const changelogPath = appInfo.info?.changelogPath;
  if (!changelogPath) {
    changelogError = "Changelog file not found.";
    return;
  }
  changelogLoading = true;
  changelogError = null;
  try {
    const res = await fetch(`${API_BASE}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: changelogPath, readOnly: true }),
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
  } catch {
    changelogError = "Server unavailable.";
  } finally {
    changelogLoading = false;
  }
}

const sectionLabelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";

function navButtonStyle(section: SettingsSection): string {
  const active = activeSection === section;
  return [
    "width: 100%;",
    "display: flex;",
    "align-items: center;",
    "min-height: 34px;",
    "padding: 0 var(--tandem-space-3);",
    "border: 1px solid transparent;",
    "border-radius: 6px;",
    "background: " + (active ? "var(--tandem-accent-bg)" : "transparent") + ";",
    "color: " + (active ? "var(--tandem-accent-fg-strong)" : "var(--tandem-fg-muted)") + ";",
    "font-size: 13px;",
    "font-weight: " + (active ? "600" : "500") + ";",
    "text-align: left;",
    "cursor: pointer;",
  ].join(" ");
}

function panelHeading(section: SettingsSection): string {
  return SECTIONS.find((s) => s.id === section)?.label ?? "Settings";
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
    style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(900px, calc(100vw - 32px)); height: min(680px, calc(100vh - 32px)); background: var(--tandem-surface); color: var(--tandem-fg); border: 1px solid var(--tandem-border); border-radius: 8px; box-shadow: 0 8px 36px color-mix(in srgb, var(--tandem-fg) 16%, transparent); z-index: 9999; display: grid; grid-template-columns: 188px minmax(0, 1fr); outline: none; overflow: hidden;"
  >
    <aside
      style="display: flex; flex-direction: column; gap: var(--tandem-space-4); padding: var(--tandem-space-5) var(--tandem-space-3); border-right: 1px solid var(--tandem-border); background: var(--tandem-surface-muted);"
    >
      <div style="padding: 0 var(--tandem-space-2);">
        <div id={HEADING_ID} style="font-size: 18px; font-weight: 700; color: var(--tandem-fg);">
          Settings
        </div>
        <div style="margin-top: 2px; font-size: 11px; color: var(--tandem-fg-subtle);">
          Tandem preferences
        </div>
      </div>

      <nav aria-label="Settings sections" style="display: flex; flex-direction: column; gap: 2px;">
        {#each SECTIONS as section (section.id)}
          <button
            type="button"
            aria-current={activeSection === section.id ? "page" : undefined}
            onclick={() => (activeSection = section.id)}
            style={navButtonStyle(section.id)}
          >
            {section.label}
          </button>
        {/each}
      </nav>
    </aside>

    <section style="display: flex; flex-direction: column; min-width: 0; min-height: 0;">
      <header
        style="display: flex; align-items: center; justify-content: space-between; min-height: 56px; padding: 0 var(--tandem-space-5); border-bottom: 1px solid var(--tandem-border); background: var(--tandem-surface);"
      >
        <h2 style="font-size: 16px; font-weight: 700; color: var(--tandem-fg); margin: 0;">
          {panelHeading(activeSection)}
        </h2>
        <button
          onclick={onClose}
          style="background: none; border: 1px solid transparent; cursor: pointer; color: var(--tandem-fg-subtle); font-size: 18px; line-height: 1; padding: 4px 8px; min-width: 30px; min-height: 30px; border-radius: 5px;"
          aria-label="Close settings"
        >
          ×
        </button>
      </header>

      <div style="flex: 1; overflow-y: auto; padding: var(--tandem-space-5);">
        <div style="display: flex; flex-direction: column; gap: var(--tandem-space-5); max-width: 620px;">
          {#if activeSection === "profile"}
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
                style="width: 100%; padding: 8px 10px; font-size: 13px; color: var(--tandem-fg); background: var(--tandem-surface); border: 1px solid var(--tandem-border-strong); border-radius: 5px; outline: none;"
              />
            </div>
          {:else if activeSection === "appearance"}
            <AppearanceSettings {open} {settings} {onUpdate} />
          {:else if activeSection === "editor"}
            <EditorSettings {settings} {onUpdate} />
          {:else if activeSection === "accessibility"}
            <AccessibilitySettings {settings} {onUpdate} />
          {:else if activeSection === "automation"}
            <div>
              <div style={sectionLabelStyle}>
                Selection Sensitivity:
                <span style="font-weight: 400; text-transform: none;">
                  {(settings.selectionDwellMs / 1000).toFixed(1)}s
                </span>
              </div>
              <div style="font-size: 10px; color: var(--tandem-fg-subtle); margin-bottom: 6px;">
                How long you must hold a selection before Claude notices it
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
          {:else}
            <div>
              <button
                data-testid="view-changelog-btn"
                onclick={() => void handleViewChangelog()}
                disabled={changelogLoading || appInfo.loading}
                style="width: 100%; padding: var(--tandem-space-2); font-size: 13px; font-weight: 500; border: 1px solid var(--tandem-border-strong); border-radius: 5px; cursor: {changelogLoading || appInfo.loading ? 'not-allowed' : 'pointer'}; background: var(--tandem-surface-muted); color: var(--tandem-fg); opacity: {changelogLoading || appInfo.loading ? 0.6 : 1};"
              >
                {changelogLoading ? "Opening…" : "View Changelog"}
              </button>
              {#if changelogError}
                <div style="margin-top: 6px; font-size: 11px; color: var(--tandem-error-fg);">
                  {changelogError}
                </div>
              {/if}
            </div>

            <div>
              <a
                href="https://github.com/bloknayrb/tandem/issues/new"
                target="_blank"
                rel="noreferrer"
                style="display: block; width: 100%; padding: var(--tandem-space-2); font-size: 13px; font-weight: 500; border: 1px solid var(--tandem-border-strong); border-radius: 5px; background: var(--tandem-surface-muted); color: var(--tandem-fg); text-align: center; text-decoration: none; box-sizing: border-box;"
              >
                Report a bug
              </a>
            </div>

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

            {#if appInfo.loading || appInfo.info !== null}
              <div
                data-testid="app-info-footer"
                style="border-top: 1px solid var(--tandem-border); padding-top: 10px;"
              >
                <div style={sectionLabelStyle}>About</div>
                {#if appInfo.loading}
                  <div style="font-size: 11px; color: var(--tandem-fg-subtle);">Loading...</div>
                {:else}
                  <div style="display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--tandem-fg-subtle);">
                    <span>Tandem v{appInfo.info?.version}</span>
                    <span>MCP SDK {appInfo.info?.mcpSdkVersion}</span>
                  </div>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      </div>
    </section>
  </div>
{/if}
