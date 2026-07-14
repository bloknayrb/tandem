<script lang="ts">
import { USER_NAME_MAX_LEN } from "../../../shared/constants";
import { createUserName } from "../../hooks/useUserName.svelte";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// Keep `$props()` as a single proxy variable and read fields via `ctx.foo`.
// Capturing into a local and then destructuring (`let c = $props(); let { settings } = c`)
// would freeze the inner getters at mount (feedback_svelte_getter_destructuring).
let ctx: SettingsTabContext = $props();

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
</script>

<div>
  <label for="settings-modal-display-name" class="settings-section-label">Display Name</label>
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
  <div id="settings-modal-default-mode-label" class="settings-section-label">Default Mode</div>
  <div
    role="radiogroup"
    aria-labelledby="settings-modal-default-mode-label"
    class="settings-mode-btns"
  >
    <button
      type="button"
      data-testid="settings-modal-default-mode-tandem-btn"
      role="radio"
      aria-checked={ctx.settings.defaultMode === "tandem"}
      disabled={ctx.readOnly}
      onclick={() => ctx.onUpdate({ defaultMode: "tandem" })}
      class="settings-mode-btn"
      style="cursor: {ctx.readOnly ? 'not-allowed' : 'pointer'}; opacity: {ctx.readOnly ? 0.5 : 1};"
    >
      Tandem
    </button>
    <button
      type="button"
      data-testid="settings-modal-default-mode-solo-btn"
      role="radio"
      aria-checked={ctx.settings.defaultMode === "solo"}
      disabled={ctx.readOnly}
      onclick={() => ctx.onUpdate({ defaultMode: "solo" })}
      class="settings-mode-btn"
      style="cursor: {ctx.readOnly ? 'not-allowed' : 'pointer'}; opacity: {ctx.readOnly ? 0.5 : 1};"
    >
      Solo
    </button>
  </div>
  <div class="settings-hint" style="margin-top: var(--tandem-space-1);">
    Sets the preferred starting mode for new sessions.
  </div>
</div>

<label
  data-testid="settings-modal-solo-rail-hidden-toggle"
  style="display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;"
>
  <input
    type="checkbox"
    checked={ctx.settings.soloRailHidden}
    disabled={ctx.readOnly}
    onchange={(e) => ctx.onUpdate({ soloRailHidden: (e.target as HTMLInputElement).checked })}
    style="accent-color: var(--tandem-accent); cursor: {ctx.readOnly ? 'not-allowed' : 'pointer'}; opacity: {ctx.readOnly ? 0.5 : 1};"
  />
  <span>Hide side panel in Solo mode</span>
</label>
<div class="settings-hint" style="margin-top: var(--tandem-space-1);">
  When enabled, the annotation panel hides automatically when you enter Solo mode and
  restores when you return to Tandem.
</div>
