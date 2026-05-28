<script lang="ts">
/**
 * First-run model picker: pick a provider, store the key in the OS
 * keychain, set as default. Runs ahead of the integration wizard. The
 * caller's `onComplete` fires on save or skip.
 */
import { untrack } from "svelte";
import { createModels } from "../hooks/useModels.svelte.js";
import type { ModelProvider } from "../hooks/useTandemSettings.svelte.js";
import { createTandemSettings } from "../hooks/useTandemSettings.svelte.js";

interface Props {
  /** Fires after Save (success) or Skip. Caller should advance its state. */
  onComplete: () => void;
}

const { onComplete }: Props = $props();

const settingsState = createTandemSettings();
const models = createModels(settingsState);

interface ProviderOption {
  value: ModelProvider;
  label: string;
  /** Default model ID surfaced as input placeholder + initial value. */
  defaultModelId: string;
  /** Provider-specific copy: "API key" for cloud, "Endpoint URL" for local. */
  isCloud: boolean;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: "anthropic",
    label: "Anthropic (Claude)",
    defaultModelId: "claude-sonnet-4-6",
    isCloud: true,
  },
  { value: "openai", label: "OpenAI", defaultModelId: "gpt-4o", isCloud: true },
  { value: "gemini", label: "Gemini (Google)", defaultModelId: "gemini-2.0-flash", isCloud: true },
  {
    value: "local-ollama",
    label: "Ollama (local)",
    defaultModelId: "llama3.1:70b",
    isCloud: false,
  },
  {
    value: "local-llamacpp",
    label: "llama.cpp (local)",
    defaultModelId: "local-model",
    isCloud: false,
  },
];

let provider = $state<ModelProvider>("anthropic");
let displayName = $state("");
let modelId = $state(PROVIDER_OPTIONS[0].defaultModelId);
let apiKey = $state("");
let endpoint = $state("http://localhost:11434");
let saving = $state(false);
let saveError = $state<string | null>(null);
let dialogEl: HTMLElement | null = $state(null);
let prevFocus: Element | null = null;

const currentProvider = $derived(
  PROVIDER_OPTIONS.find((p) => p.value === provider) ?? PROVIDER_OPTIONS[0],
);
const isCloud = $derived(currentProvider.isCloud);

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
    models.setDefault(id);
    onComplete();
  } catch (err) {
    saveError = err instanceof Error ? err.message : "Failed to save";
  } finally {
    saving = false;
  }
}

function handleSkip() {
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
          <label class="frm-provider-row">
            <input
              type="radio"
              name="first-run-provider"
              value={opt.value}
              checked={provider === opt.value}
              data-testid={`first-run-provider-${opt.value}`}
              onchange={() => selectProvider(opt.value)}
            />
            <span>{opt.label}</span>
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
