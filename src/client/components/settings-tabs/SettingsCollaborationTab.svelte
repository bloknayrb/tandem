<script lang="ts">
import { USER_NAME_MAX_LEN } from "../../../shared/constants";
import { createUserName } from "../../hooks/useUserName.svelte";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// Tab body components for SettingsModal accept the full SettingsTabContext
// even when they don't use every field — the modal passes the same shape
// to every tab so Wave 2 additions are uniform.
let { settings, onUpdate }: SettingsTabContext = $props();

const userNameState = createUserName();
let nameInput = $state(userNameState.userName);
let inputEl: HTMLInputElement | undefined = $state();

// Idle-sync: keep nameInput aligned with the underlying store when the user
// isn't actively editing. Same pattern as SettingsPopover.
$effect(() => {
  const currentUserName = userNameState.userName;
  if (nameInput !== currentUserName && document.activeElement !== inputEl) {
    nameInput = currentUserName;
  }
});

const sectionLabelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";
</script>

<div>
  <label for="settings-modal-display-name" style={sectionLabelStyle}>Display Name</label>
  <input
    bind:this={inputEl}
    id="settings-modal-display-name"
    data-testid="settings-modal-display-name"
    type="text"
    value={nameInput}
    oninput={(e) => {
      nameInput = (e.target as HTMLInputElement).value;
    }}
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
  <div id="settings-modal-default-mode-label" style={sectionLabelStyle}>Default Mode</div>
  <div
    role="radiogroup"
    aria-labelledby="settings-modal-default-mode-label"
    style="display: flex; gap: var(--tandem-space-2);"
  >
    <button
      type="button"
      data-testid="settings-modal-default-mode-tandem-btn"
      role="radio"
      aria-checked={settings.defaultMode === "tandem"}
      onclick={() => onUpdate({ defaultMode: "tandem" })}
      style="flex: 1; padding: var(--tandem-space-2); min-height: 30px; border: 2px solid {settings.defaultMode === 'tandem' ? 'var(--tandem-accent)' : 'var(--tandem-border)'}; border-radius: var(--tandem-r-3); background: {settings.defaultMode === 'tandem' ? 'var(--tandem-accent-bg)' : 'var(--tandem-surface)'}; color: {settings.defaultMode === 'tandem' ? 'var(--tandem-accent-fg-strong)' : 'var(--tandem-fg-muted)'}; font-size: 12px; font-weight: {settings.defaultMode === 'tandem' ? 600 : 400}; cursor: pointer;"
    >
      Tandem
    </button>
    <button
      type="button"
      data-testid="settings-modal-default-mode-solo-btn"
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
  data-testid="settings-modal-solo-rail-hidden-toggle"
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
