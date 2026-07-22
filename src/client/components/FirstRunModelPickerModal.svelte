<script lang="ts">
/**
 * First-run model picker: pick a provider, store the key in the OS
 * keychain, set as default. The caller's `onComplete` fires on save or skip.
 *
 * Mounted by `App.svelte` behind `shouldShowModelPicker` (an optional,
 * skippable step after the integration wizard, before the tutorial), which is
 * gated on `BYO_MODELS_ENABLED` — so this stays DARK (never mounts) until the
 * flag flips at v1.0, when the Settings → Models tab and the titlebar model chip
 * light up alongside it. Final first-run choreography copy is M4-owned.
 */
import { untrack } from "svelte";
import { isLocalProvider } from "../../shared/models/contract.js";
import { createModels } from "../hooks/useModels.svelte.js";
import type { ModelProvider } from "../hooks/useTandemSettings.svelte.js";

interface Props {
  /** Fires after Save (success) or Skip. Caller should advance its state. */
  onComplete: () => void;
}

const { onComplete }: Props = $props();

const models = createModels();

interface ProviderOption {
  value: ModelProvider;
  label: string;
  /** Default model ID surfaced as input placeholder + initial value. */
  defaultModelId: string;
}

// Local-first, matching ModelEditModal (§3.4): v1.0 ships local providers only,
// so a fresh first run defaults to Ollama and cloud rows render disabled (their
// BYO key support is v1.1). Cloud rows stay listed — disabled + "coming soon" —
// so the roadmap is visible; M4 finalizes first-run copy. The cloud/local split
// is derived from the contract's `isLocalProvider` (single source of truth,
// same as ModelEditModal) rather than a hand-maintained per-option flag.
const PROVIDER_OPTIONS: ProviderOption[] = [
  { value: "local-ollama", label: "Ollama (local)", defaultModelId: "llama3.1:70b" },
  { value: "local-llamacpp", label: "llama.cpp (local)", defaultModelId: "local-model" },
  { value: "anthropic", label: "Anthropic (Claude)", defaultModelId: "claude-sonnet-4-6" },
  { value: "openai", label: "OpenAI", defaultModelId: "gpt-4o" },
  { value: "gemini", label: "Gemini (Google)", defaultModelId: "gemini-2.0-flash" },
];

let provider = $state<ModelProvider>("local-ollama");
let displayName = $state("");
let modelId = $state(PROVIDER_OPTIONS[0].defaultModelId);
let apiKey = $state("");
let endpoint = $state("http://localhost:11434");
let saving = $state(false);
let saveError = $state<string | null>(null);
// Set once the add COMMITS. A retry after a setDefault failure re-attempts only
// setDefault against this id — never a second addModel (which would duplicate the
// entry). Lives for the modal's lifetime.
let addedId = $state<string | null>(null);
let dialogEl: HTMLElement | null = $state(null);
let prevFocus: Element | null = null;

const currentProvider = $derived(
  PROVIDER_OPTIONS.find((p) => p.value === provider) ?? PROVIDER_OPTIONS[0],
);
const isCloud = $derived(!isLocalProvider(provider));

const canSave = $derived(
  modelId.trim().length > 0 && (isCloud ? apiKey.trim().length > 0 : endpoint.trim().length > 0),
);

$effect(() => {
  const el = untrack(() => dialogEl);
  if (!el) return;
  prevFocus = document.activeElement;
  el.focus();
  return () => {
    if (prevFocus instanceof HTMLElement && document.contains(prevFocus)) prevFocus.focus();
  };
});

function selectProvider(next: ModelProvider) {
  const prev = PROVIDER_OPTIONS.find((p) => p.value === provider);
  const target = PROVIDER_OPTIONS.find((p) => p.value === next);
  // Only swap modelId when the field still holds the previous provider's
  // default — preserves any custom value the user typed.
  if (target && prev && modelId === prev.defaultModelId) {
    modelId = target.defaultModelId;
  }
  provider = next;
}

async function handleSave(e: SubmitEvent) {
  e.preventDefault();
  if (!canSave || saving) return;
  saving = true;
  saveError = null;
  try {
    // Add the model once. If a prior attempt already committed the add but its
    // setDefault failed, `addedId` is set — retry ONLY setDefault below.
    if (addedId === null) {
      const id = await models.addModel(
        {
          provider,
          displayName: displayName.trim() || currentProvider.label,
          modelId: modelId.trim(),
          enabled: true,
          ...(isCloud ? {} : { endpoint: endpoint.trim() }),
        },
        isCloud ? apiKey.trim() : undefined,
      );
      // `addModel` returns null when the write did NOT commit (rolled back /
      // reconciled away) — do NOT finish onboarding with a phantom default, keep
      // the modal open and surface the store's error.
      if (id === null) {
        saveError = models.saveError ?? "Failed to save model changes.";
        return;
      }
      addedId = id;
    }
    // The model committed. Setting it as default can still roll back (a
    // concurrent writer / blip). That is non-fatal — the model exists — but the
    // store's list banner does NOT render in first-run, so surface it locally and
    // let the user proceed via Skip rather than silently onboarding with no
    // default. (Do NOT reuse `models.saveError` here: its "failed to save"
    // wording would wrongly imply the model itself didn't save.)
    const defaulted = await models.setDefault(addedId);
    if (!defaulted) {
      saveError =
        "Model saved, but couldn't set it as the default. You can choose a default later in Settings.";
      return;
    }
    onComplete();
  } catch (err) {
    saveError = err instanceof Error ? err.message : "Failed to save";
  } finally {
    saving = false;
  }
}

function handleSkip() {
  // Drop any error left on the shared store singleton (e.g. a rolled-back add or
  // setDefault) so it can't co-show on the next Settings → Models open.
  models.clearError();
  onComplete();
}
</script>

<div
  role="presentation"
  class="frm-scrim"
  data-testid="first-run-model-modal"
  onclick={(e) => {
    if (e.target === e.currentTarget) handleSkip();
  }}
>
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Connect an AI model"
    tabindex={-1}
    bind:this={dialogEl}
    class="frm-dialog"
    onkeydown={(e) => {
      if (e.key === "Escape") handleSkip();
      if (e.key !== "Tab") e.stopPropagation();
    }}
  >
    <header class="frm-header">
      <div>
        <h2 class="frm-title">Connect an AI model</h2>
        <div class="frm-step">Step 1 of 2 — Tandem stores your key in the OS keychain.</div>
      </div>
      <button
        type="button"
        class="frm-close"
        onclick={handleSkip}
        data-testid="first-run-skip"
        aria-label="Skip for now"
      >
        ×
      </button>
    </header>

    <form onsubmit={handleSave} class="frm-form">
      <fieldset class="frm-providers" data-testid="first-run-providers">
        <legend class="frm-label">Provider</legend>
        {#each PROVIDER_OPTIONS as opt (opt.value)}
          {@const optDisabled = !isLocalProvider(opt.value)}
          <label class="frm-provider-row" class:frm-provider-row-disabled={optDisabled}>
            <input
              type="radio"
              name="first-run-provider"
              value={opt.value}
              checked={provider === opt.value}
              disabled={optDisabled}
              data-testid={`first-run-provider-${opt.value}`}
              onchange={() => selectProvider(opt.value)}
            />
            <span>{opt.label}{optDisabled ? " — coming soon" : ""}</span>
          </label>
        {/each}
      </fieldset>

      <label class="frm-field">
        <span class="frm-label">Display name (optional)</span>
        <input
          type="text"
          data-testid="first-run-displayname"
          bind:value={displayName}
          placeholder={currentProvider.label}
          autocomplete="off"
        />
      </label>

      <label class="frm-field">
        <span class="frm-label">Model ID</span>
        <input
          type="text"
          data-testid="first-run-modelid"
          bind:value={modelId}
          autocomplete="off"
          class="frm-mono"
        />
      </label>

      {#if isCloud}
        <label class="frm-field">
          <span class="frm-label">API key</span>
          <input
            type="password"
            data-testid="first-run-apikey"
            bind:value={apiKey}
            autocomplete="off"
            class="frm-mono"
            placeholder="Paste your provider API key"
          />
        </label>
      {:else}
        <label class="frm-field">
          <span class="frm-label">Endpoint URL</span>
          <input
            type="text"
            data-testid="first-run-endpoint"
            bind:value={endpoint}
            autocomplete="off"
            class="frm-mono"
          />
        </label>
      {/if}

      {#if saveError}
        <div role="alert" class="frm-error" data-testid="first-run-error">{saveError}</div>
      {/if}

      <div class="frm-actions">
        <button
          type="button"
          onclick={handleSkip}
          data-testid="first-run-skip-secondary"
          class="frm-btn frm-btn-secondary"
        >
          Skip for now
        </button>
        <button
          type="submit"
          disabled={!canSave || saving}
          data-testid="first-run-save"
          class="frm-btn frm-btn-primary"
        >
          {saving ? "Saving…" : "Save and continue"}
        </button>
      </div>
    </form>
  </div>
</div>

<style>
.frm-scrim {
  position: fixed;
  inset: 0;
  z-index: var(--tandem-z-above-titlebar);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 80px;
  /* Theme-adaptive backdrop (cluster 3.2 modal recipe). */
  background: color-mix(in srgb, var(--tandem-bg) 70%, transparent);
}
.frm-dialog {
  background: var(--tandem-surface);
  border: 1px solid var(--tandem-border);
  border-radius: var(--tandem-r-5);
  box-shadow: var(--tandem-shadow-4);
  width: 520px;
  max-width: calc(100vw - 40px);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: var(--tandem-space-3);
}
.frm-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--tandem-space-3);
}
.frm-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--tandem-fg);
}
.frm-step {
  margin-top: 4px;
  font-size: 12px;
  color: var(--tandem-fg-muted);
}
/* Close button mirrors the cluster-3.2 modal family (28×28, fg-subtle on
   transparent → fg + surface-sunk on hover/focus-visible). */
.frm-close {
  background: none;
  border: 1px solid transparent;
  cursor: pointer;
  color: var(--tandem-fg-subtle);
  font-size: 18px;
  line-height: 1;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border-radius: var(--tandem-r-2);
}
.frm-close:hover,
.frm-close:focus-visible {
  color: var(--tandem-fg);
  background: var(--tandem-surface-sunk);
  outline: none;
}
.frm-form {
  display: flex;
  flex-direction: column;
  gap: var(--tandem-space-3);
}
.frm-providers {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--tandem-border);
  border-radius: var(--tandem-r-3);
  padding: var(--tandem-space-2);
}
.frm-providers > legend {
  padding: 0 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--tandem-fg);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.frm-provider-row {
  display: flex;
  align-items: center;
  gap: var(--tandem-space-2);
  font-size: 13px;
  color: var(--tandem-fg);
  cursor: pointer;
  padding: 4px 6px;
  border-radius: var(--tandem-r-2);
}
.frm-provider-row:hover {
  background: var(--tandem-surface-muted);
}
/* Cloud providers are disabled until v1.1 (their BYO key support ships then). */
.frm-provider-row-disabled {
  color: var(--tandem-fg-subtle);
  cursor: not-allowed;
}
.frm-provider-row-disabled:hover {
  background: none;
}
.frm-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.frm-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--tandem-fg);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.frm-field > input {
  padding: 8px 10px;
  font-size: 13px;
  color: var(--tandem-fg);
  background: var(--tandem-surface);
  border: 1px solid var(--tandem-border-strong);
  border-radius: var(--tandem-r-2);
}
.frm-mono {
  font-family: var(--tandem-font-mono);
}
.frm-error {
  padding: var(--tandem-space-2) var(--tandem-space-3);
  border: 1px solid var(--tandem-error-border);
  border-radius: var(--tandem-r-2);
  background: var(--tandem-error-bg);
  color: var(--tandem-error-fg-strong);
  font-size: 12px;
}
.frm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--tandem-space-2);
  margin-top: var(--tandem-space-2);
}
.frm-btn {
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--tandem-r-2);
  cursor: pointer;
  border: 1px solid transparent;
}
.frm-btn-secondary {
  border-color: var(--tandem-border-strong);
  background: var(--tandem-surface);
  color: var(--tandem-fg);
}
.frm-btn-primary {
  background: var(--tandem-accent);
  color: var(--tandem-accent-fg);
}
.frm-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
