<script lang="ts">
import { activateLicenseClient } from "../hooks/useLicense";
import { licenseStore } from "../hooks/useLicense.svelte";

// Shared license-activation form (#1116). Used by both the restricted-mode wall
// and the Settings → License tab, so the activate testids are defined once.
interface Props {
  /** Called after a successful activation (e.g. to show a toast / close a wall). */
  onActivated?: () => void;
}
const { onActivated }: Props = $props();

let licenseInput = $state("");
let error = $state<string | null>(null);
let submitting = $state(false);

async function submit(): Promise<void> {
  const value = licenseInput.trim();
  if (!value) {
    error = "Paste your license key first.";
    return;
  }
  submitting = true;
  error = null;
  const result = await activateLicenseClient(value);
  submitting = false;
  if (result.ok) {
    licenseStore.set(result.state);
    licenseInput = "";
    onActivated?.();
  } else {
    error = result.error;
  }
}
</script>

<div class="license-activate">
  <textarea
    data-testid="license-activate-input"
    class="license-activate__input"
    bind:value={licenseInput}
    placeholder="Paste your license key"
    rows={4}
    disabled={submitting}
    spellcheck="false"
  ></textarea>
  {#if error}
    <div class="license-activate__error" data-testid="license-activate-error" role="alert">
      {error}
    </div>
  {/if}
  <button
    type="button"
    class="license-activate__submit"
    data-testid="license-activate-submit"
    onclick={() => void submit()}
    disabled={submitting}
  >
    {submitting ? "Activating…" : "Activate license"}
  </button>
</div>

<style>
.license-activate {
  display: flex;
  flex-direction: column;
  gap: var(--tandem-space-2);
}
.license-activate__input {
  width: 100%;
  padding: var(--tandem-space-2) var(--tandem-space-3);
  font-size: var(--tandem-text-sm);
  font-family: var(--tandem-font-mono, monospace);
  color: var(--tandem-fg);
  background: var(--tandem-surface);
  border: 1px solid var(--tandem-border-strong);
  border-radius: var(--tandem-r-2);
  outline: none;
  resize: vertical;
}
.license-activate__input:focus {
  border-color: var(--tandem-accent-border);
}
.license-activate__error {
  font-size: var(--tandem-text-sm);
  color: var(--tandem-error-fg-strong);
  background: var(--tandem-error-bg);
  border: 1px solid var(--tandem-error-border);
  border-radius: var(--tandem-r-2);
  padding: var(--tandem-space-2) var(--tandem-space-3);
}
.license-activate__submit {
  align-self: flex-start;
  padding: var(--tandem-space-2) var(--tandem-space-4);
  font-size: var(--tandem-text-sm);
  font-weight: 600;
  color: var(--tandem-accent-fg);
  background: var(--tandem-accent);
  border: none;
  border-radius: var(--tandem-r-2);
  cursor: pointer;
}
.license-activate__submit:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
