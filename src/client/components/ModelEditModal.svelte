<script lang="ts">
import { untrack } from "svelte";
import { isLocalProvider } from "../../shared/models/contract.js";
import type { ModelProvider, ModelRegistryEntry } from "../hooks/useTandemSettings.svelte.js";
import CollapsibleSection from "./CollapsibleSection.svelte";

interface Props {
  /** Existing entry when editing; `undefined` when adding. */
  entry?: ModelRegistryEntry;
  /**
   * Save-failure message to surface inside the dialog (pre-write keychain error,
   * or a write that rolled back). Null when there's no error. Shown here rather
   * than the tab banner because the modal is the active surface during a save.
   */
  error?: string | null;
  onCancel: () => void;
  /**
   * Save handler.
   *
   * **Secrets contract (#659).** Plaintext API keys are stored server-side
   * in the OS keychain; the entry on disk carries only the opaque
   * `apiKeyRef`. This component therefore returns `plaintextApiKey` only
   * when the user is creating an entry or has clicked "Replace key" — in
   * the no-op edit case (user didn't touch the key field), `plaintextApiKey`
   * is `undefined` and the parent must preserve the existing `apiKeyRef`.
   *
   * The parent (`SettingsModelsTab` / first-run picker) is responsible for
   * routing `plaintextApiKey` through `useModels.addModel` /
   * `useModels.updateModel`, which post it to the secrets endpoint and
   * persist only the ref.
   */
  onSave: (data: {
    provider: ModelProvider;
    displayName: string;
    modelId: string;
    /** Plaintext key for keychain storage; `undefined` to preserve existing ref. */
    plaintextApiKey?: string;
    endpoint?: string;
    enabled: boolean;
  }) => void;
}

const { entry, error, onCancel, onSave }: Props = $props();

// v1.0 ships LOCAL providers only; cloud BYO keys are v1.1. `disabled` is
// derived from the contract's `isLocalProvider` (single source of truth for the
// local/cloud split) so the picker can never drift from what the collaborator
// loop will actually resolve. Cloud options render disabled + a "coming soon"
// note rather than being hidden, so the roadmap stays visible. Local-first order.
const PROVIDER_OPTIONS: Array<{ value: ModelProvider; label: string; disabled: boolean }> = (
  [
    { value: "local-ollama", label: "Ollama (local)" },
    { value: "local-llamacpp", label: "llama.cpp (local)" },
    { value: "anthropic", label: "Anthropic" },
    { value: "openai", label: "OpenAI" },
    { value: "gemini", label: "Gemini" },
  ] satisfies Array<{ value: ModelProvider; label: string }>
).map((opt) => ({ ...opt, disabled: !isLocalProvider(opt.value) }));

// Discrete $state per field, hydrated ONCE from the `entry` prop snapshot.
// We deliberately don't track `entry` reactively: the parent unmounts and
// remounts this component when the editing target changes ({#if editorOpen}),
// so a stable prop snapshot is the contract — `untrack` quiets the
// svelte-check warning while pinning the intent. Reactive form state lives
// in the per-field $state below.
const initialEntry = untrack(() => entry);

// Default a NEW entry to the first local provider (cloud is disabled below); an
// existing entry keeps its stored provider even if it's a now-disabled cloud one.
let provider = $state<ModelProvider>(initialEntry?.provider ?? "local-ollama");
let displayName = $state(initialEntry?.displayName ?? "");
let modelId = $state(initialEntry?.modelId ?? "");
let endpoint = $state(initialEntry?.endpoint ?? "");
let enabled = $state(initialEntry?.enabled ?? true);

// Reveal-gated apiKey state. The plaintext key only enters this DOM when
// the user is adding a new entry or has clicked "Replace key". On edit
// mode without replacement, the input is not rendered at all — the
// existing `apiKeyRef` is opaque and the actual secret lives in the OS
// keychain (no client read path).
let apiKey = $state("");
const hasExistingKey = initialEntry !== undefined && Boolean(initialEntry.apiKeyRef);
let replacingKey = $state(initialEntry === undefined || !hasExistingKey);

const isEditing = initialEntry !== undefined;
// Derive both off the contract helper so the key/endpoint field gating and the
// picker's disabled split can never disagree about what "cloud" means.
const isLocal = $derived(isLocalProvider(provider));
const isCloud = $derived(!isLocal);

// Last 4 chars of the opaque `apiKeyRef` for the masked preview. The ref
// is not sensitive (no read path exposes the plaintext from it), but it
// also isn't user-meaningful — surfacing four chars is enough to
// disambiguate "I have a key stored" vs "I don't" without leaking the
// secret itself.
const existingKeyTail = initialEntry?.apiKeyRef ? initialEntry.apiKeyRef.slice(-4) : "";

const canSave = $derived(
  displayName.trim().length > 0 &&
    modelId.trim().length > 0 &&
    // Cloud providers require either the existing key (not replacing) OR a
    // freshly-entered key (replacing). Local providers don't need a key.
    (!isCloud || !replacingKey || apiKey.trim().length > 0),
);

function handleSubmit(e: SubmitEvent) {
  e.preventDefault();
  if (!canSave) return;

  // Build the payload. plaintextApiKey is set ONLY when the user typed a
  // new key (add mode or "Replace key" path). In no-op edit, the field is
  // omitted and the parent preserves the existing `apiKeyRef`. Endpoint
  // is similarly gated to local providers.
  const payload: Parameters<typeof onSave>[0] = {
    provider,
    displayName: displayName.trim(),
    modelId: modelId.trim(),
    enabled,
  };
  if (isCloud && replacingKey && apiKey.trim()) {
    payload.plaintextApiKey = apiKey.trim();
  }
  if (isLocal && endpoint.trim()) {
    payload.endpoint = endpoint.trim();
  }
  onSave(payload);
}

function startReplacingKey() {
  replacingKey = true;
  apiKey = "";
}
</script>

<div
  role="dialog"
  aria-modal="true"
  aria-label={isEditing ? "Edit model" : "Add model"}
  tabindex={-1}
  data-testid="model-edit-modal"
  class="mem-scrim"
  onclick={(e) => {
    if (e.target === e.currentTarget) onCancel();
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") onCancel();
  }}
>
  <form class="mem-dialog" onsubmit={handleSubmit}>
    <div class="mem-header">
      <h3 class="mem-title">
        {isEditing ? "Edit model" : "Add model"}
      </h3>
      <button
        type="button"
        class="mem-close"
        data-testid="model-edit-cancel"
        onclick={onCancel}
        aria-label="Close"
      >
        ×
      </button>
    </div>

    <label class="mem-field">
      <span class="mem-label">Provider</span>
      <select
        data-testid="model-edit-provider"
        class="mem-input"
        bind:value={provider}
      >
        {#each PROVIDER_OPTIONS as opt (opt.value)}
          <option value={opt.value} disabled={opt.disabled}>
            {opt.label}{opt.disabled ? " — coming soon" : ""}
          </option>
        {/each}
      </select>
      {#if isCloud}
        <span class="mem-provider-note" data-testid="model-edit-provider-note">
          Cloud providers are coming in a future release. For now, choose a local
          provider (Ollama or llama.cpp).
        </span>
      {/if}
    </label>

    <label class="mem-field">
      <span class="mem-label">Display name</span>
      <input
        data-testid="model-edit-displayname"
        class="mem-input"
        type="text"
        autocomplete="off"
        bind:value={displayName}
        placeholder="My Anthropic key"
      />
    </label>

    <label class="mem-field">
      <span class="mem-label">Model ID</span>
      <input
        data-testid="model-edit-modelid"
        class="mem-input mem-input--mono"
        type="text"
        autocomplete="off"
        bind:value={modelId}
        placeholder="e.g. claude-opus-4-7"
      />
    </label>

    {#if isCloud}
      <label class="mem-field">
        <span class="mem-label">API key</span>
        {#if isEditing && initialEntry?.apiKeyRef && !replacingKey}
          <div class="mem-key-row">
            <span class="mem-key-preview" aria-label="Existing API key (masked)">
              ••••••••{existingKeyTail}
            </span>
            <button
              type="button"
              class="mem-key-replace-btn"
              data-testid="model-edit-apikey-replace-btn"
              onclick={startReplacingKey}
            >
              Replace key
            </button>
          </div>
        {:else}
          <input
            data-testid="model-edit-apikey"
            class="mem-input mem-input--mono"
            type="password"
            autocomplete="off"
            bind:value={apiKey}
            placeholder={isEditing ? "Enter new key" : "Paste your API key"}
          />
        {/if}
      </label>
    {/if}

    {#if isLocal}
      <label class="mem-field">
        <span class="mem-label">Endpoint</span>
        <input
          data-testid="model-edit-endpoint"
          class="mem-input mem-input--mono"
          type="text"
          autocomplete="off"
          bind:value={endpoint}
          placeholder="http://localhost:11434"
        />
      </label>
    {/if}

    <label class="mem-enabled-row">
      <input type="checkbox" class="mem-enabled-cbx" bind:checked={enabled} />
      <span>Enabled</span>
    </label>

    <CollapsibleSection label="Advanced parameters" testid="model-edit-advanced">
      <p class="mem-advanced-help">
        Per-model parameter overrides (temperature, max tokens, etc.) are not editable in
        this preview. The data model accepts a `params` map for forward-compat with
        Wave 6 surfaces.
      </p>
    </CollapsibleSection>

    {#if error}
      <div role="alert" data-testid="model-edit-error" class="mem-error">
        {error}
      </div>
    {/if}

    <div class="mem-actions">
      <button type="button" class="mem-btn mem-btn--ghost" onclick={onCancel}>
        Cancel
      </button>
      <button
        type="submit"
        class="mem-btn mem-btn--primary"
        data-testid="model-edit-save"
        disabled={!canSave}
      >
        {isEditing ? "Save changes" : "Add model"}
      </button>
    </div>
  </form>
</div>

<style>
  /* Model edit modal — mirrors the FirstRunModelPickerModal family so the
     two modals read as one surface. Aligned to cluster-3.2 modal recipe
     (r-5 dialog, color-mix backdrop). */
  .mem-scrim {
    position: fixed;
    inset: 0;
    z-index: var(--tandem-z-above-titlebar);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 80px;
    background: color-mix(in srgb, var(--tandem-bg) 70%, transparent);
  }
  .mem-dialog {
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-5);
    box-shadow: var(--tandem-shadow-3);
    width: min(480px, calc(100vw - 40px));
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-3);
  }
  .mem-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .mem-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--tandem-fg);
  }
  /* Close button shape mirrors `.settings-modal-close` so the modal family
     reads as one. Inline styles can't express :hover / :focus-visible. */
  .mem-close {
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
  .mem-close:hover,
  .mem-close:focus-visible {
    color: var(--tandem-fg);
    background: var(--tandem-surface-sunk);
    outline: none;
  }

  .mem-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .mem-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--tandem-fg);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .mem-input {
    padding: 6px 8px;
    font-size: 13px;
    color: var(--tandem-fg);
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border-strong);
    border-radius: var(--tandem-r-2);
  }
  .mem-input:focus-visible {
    outline: none;
    border-color: var(--tandem-accent-border);
  }
  select.mem-input {
    cursor: pointer;
  }
  .mem-input--mono {
    font-family: var(--tandem-font-mono);
  }

  /* API-key masked-preview branch. The 4-char tail and `Replace key` flow
     are the secrets-contract visual (#659); presentation only — no logic
     change to `replacingKey` / `existingKeyTail` / `apiKeyRef`. */
  .mem-key-row {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-2);
  }
  .mem-key-preview {
    flex: 1;
    padding: 6px 8px;
    font-size: 13px;
    color: var(--tandem-fg-muted);
    background: var(--tandem-surface-muted);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-2);
    font-family: var(--tandem-font-mono);
  }
  .mem-key-replace-btn {
    padding: 4px var(--tandem-space-2);
    font-size: 11px;
    border: 1px solid var(--tandem-border-strong);
    border-radius: var(--tandem-r-2);
    background: var(--tandem-surface);
    color: var(--tandem-fg);
    cursor: pointer;
  }
  .mem-key-replace-btn:hover {
    background: var(--tandem-surface-sunk);
  }

  .mem-enabled-row {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-2);
    font-size: 12px;
    color: var(--tandem-fg);
  }
  .mem-enabled-cbx {
    accent-color: var(--tandem-accent);
  }

  .mem-advanced-help {
    font-size: 11px;
    color: var(--tandem-fg-subtle);
    margin: 0;
  }

  /* Shown when a now-disabled cloud provider is selected (an existing entry can
     still carry one). Points the user back at the local providers. */
  .mem-provider-note {
    font-size: 11px;
    color: var(--tandem-fg-subtle);
    margin-top: 2px;
  }

  .mem-error {
    padding: var(--tandem-space-2) var(--tandem-space-3);
    border: 1px solid var(--tandem-error-border);
    border-radius: var(--tandem-r-2);
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
    font-size: 12px;
  }

  .mem-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--tandem-space-2);
    margin-top: var(--tandem-space-2);
  }
  .mem-btn {
    padding: 6px var(--tandem-space-3);
    font-size: 13px;
    border-radius: var(--tandem-r-2);
    cursor: pointer;
  }
  .mem-btn--ghost {
    border: 1px solid var(--tandem-border-strong);
    background: var(--tandem-surface);
    color: var(--tandem-fg);
  }
  .mem-btn--ghost:hover {
    background: var(--tandem-surface-sunk);
  }
  .mem-btn--primary {
    border: none;
    font-weight: 500;
    background: var(--tandem-accent);
    color: var(--tandem-accent-fg);
  }
  .mem-btn--primary:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
</style>
