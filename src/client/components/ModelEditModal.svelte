<script lang="ts">
import { untrack } from "svelte";
import type { ModelProvider, ModelRegistryEntry } from "../hooks/useTandemSettings.svelte.js";
import CollapsibleSection from "./CollapsibleSection.svelte";

interface Props {
  /** Existing entry when editing; `undefined` when adding. */
  entry?: ModelRegistryEntry;
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

const { entry, onCancel, onSave }: Props = $props();

const PROVIDER_OPTIONS: Array<{ value: ModelProvider; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "local-ollama", label: "Ollama (local)" },
  { value: "local-llamacpp", label: "llama.cpp (local)" },
];

// Discrete $state per field, hydrated ONCE from the `entry` prop snapshot.
// We deliberately don't track `entry` reactively: the parent unmounts and
// remounts this component when the editing target changes ({#if editorOpen}),
// so a stable prop snapshot is the contract — `untrack` quiets the
// svelte-check warning while pinning the intent. Reactive form state lives
// in the per-field $state below.
const initialEntry = untrack(() => entry);

let provider = $state<ModelProvider>(initialEntry?.provider ?? "anthropic");
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
const isCloud = $derived(
  provider === "anthropic" || provider === "openai" || provider === "gemini",
);
const isLocal = $derived(provider.startsWith("local-"));

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
  style="position: fixed; inset: 0; z-index: var(--tandem-z-modal); display: flex; align-items: flex-start; justify-content: center; padding-top: 80px; background: rgba(0,0,0,0.3);"
  onclick={(e) => {
    if (e.target === e.currentTarget) onCancel();
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") onCancel();
  }}
>
  <form
    onsubmit={handleSubmit}
    style="background: var(--tandem-surface); border-radius: var(--tandem-r-4); box-shadow: var(--tandem-shadow-3); width: 480px; padding: 20px; display: flex; flex-direction: column; gap: var(--tandem-space-3);"
  >
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <h3 style="margin: 0; font-size: 15px; font-weight: 600; color: var(--tandem-fg);">
        {isEditing ? "Edit model" : "Add model"}
      </h3>
      <button
        type="button"
        data-testid="model-edit-cancel"
        onclick={onCancel}
        style="background: none; border: none; cursor: pointer; font-size: 16px; color: var(--tandem-fg-subtle);"
        aria-label="Close"
      >
        ×
      </button>
    </div>

    <label style="display: flex; flex-direction: column; gap: 4px;">
      <span style="font-size: 11px; font-weight: 600; color: var(--tandem-fg); text-transform: uppercase; letter-spacing: 0.5px;">Provider</span>
      <select
        data-testid="model-edit-provider"
        bind:value={provider}
        style="padding: 6px 8px; font-size: 13px; color: var(--tandem-fg); background: var(--tandem-surface); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); cursor: pointer;"
      >
        {#each PROVIDER_OPTIONS as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </label>

    <label style="display: flex; flex-direction: column; gap: 4px;">
      <span style="font-size: 11px; font-weight: 600; color: var(--tandem-fg); text-transform: uppercase; letter-spacing: 0.5px;">Display name</span>
      <input
        data-testid="model-edit-displayname"
        type="text"
        autocomplete="off"
        bind:value={displayName}
        placeholder="My Anthropic key"
        style="padding: 6px 8px; font-size: 13px; color: var(--tandem-fg); background: var(--tandem-surface); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2);"
      />
    </label>

    <label style="display: flex; flex-direction: column; gap: 4px;">
      <span style="font-size: 11px; font-weight: 600; color: var(--tandem-fg); text-transform: uppercase; letter-spacing: 0.5px;">Model ID</span>
      <input
        data-testid="model-edit-modelid"
        type="text"
        autocomplete="off"
        bind:value={modelId}
        placeholder="e.g. claude-opus-4-7"
        style="padding: 6px 8px; font-size: 13px; color: var(--tandem-fg); background: var(--tandem-surface); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); font-family: var(--tandem-font-mono);"
      />
    </label>

    {#if isCloud}
      <label style="display: flex; flex-direction: column; gap: 4px;">
        <span style="font-size: 11px; font-weight: 600; color: var(--tandem-fg); text-transform: uppercase; letter-spacing: 0.5px;">API key</span>
        {#if isEditing && initialEntry?.apiKeyRef && !replacingKey}
          <div style="display: flex; align-items: center; gap: var(--tandem-space-2);">
            <span
              style="flex: 1; padding: 6px 8px; font-size: 13px; color: var(--tandem-fg-muted); background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2); font-family: var(--tandem-font-mono);"
              aria-label="Existing API key (masked)"
            >
              ••••••••{existingKeyTail}
            </span>
            <button
              type="button"
              data-testid="model-edit-apikey-replace-btn"
              onclick={startReplacingKey}
              style="padding: 4px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); cursor: pointer;"
            >
              Replace key
            </button>
          </div>
        {:else}
          <input
            data-testid="model-edit-apikey"
            type="password"
            autocomplete="off"
            bind:value={apiKey}
            placeholder={isEditing ? "Enter new key" : "Paste your API key"}
            style="padding: 6px 8px; font-size: 13px; color: var(--tandem-fg); background: var(--tandem-surface); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); font-family: var(--tandem-font-mono);"
          />
        {/if}
      </label>
    {/if}

    {#if isLocal}
      <label style="display: flex; flex-direction: column; gap: 4px;">
        <span style="font-size: 11px; font-weight: 600; color: var(--tandem-fg); text-transform: uppercase; letter-spacing: 0.5px;">Endpoint</span>
        <input
          data-testid="model-edit-endpoint"
          type="text"
          autocomplete="off"
          bind:value={endpoint}
          placeholder="http://localhost:11434"
          style="padding: 6px 8px; font-size: 13px; color: var(--tandem-fg); background: var(--tandem-surface); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); font-family: var(--tandem-font-mono);"
        />
      </label>
    {/if}

    <label style="display: flex; align-items: center; gap: var(--tandem-space-2); font-size: 12px; color: var(--tandem-fg);">
      <input type="checkbox" bind:checked={enabled} style="accent-color: var(--tandem-accent);" />
      <span>Enabled</span>
    </label>

    <CollapsibleSection label="Advanced parameters" testid="model-edit-advanced">
      <p style="font-size: 11px; color: var(--tandem-fg-subtle); margin: 0;">
        Per-model parameter overrides (temperature, max tokens, etc.) are not editable in
        this preview. The data model accepts a `params` map for forward-compat with
        Wave 6 surfaces.
      </p>
    </CollapsibleSection>

    <div style="display: flex; justify-content: flex-end; gap: var(--tandem-space-2); margin-top: var(--tandem-space-2);">
      <button
        type="button"
        onclick={onCancel}
        style="padding: 6px var(--tandem-space-3); font-size: 13px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); cursor: pointer;"
      >
        Cancel
      </button>
      <button
        type="submit"
        data-testid="model-edit-save"
        disabled={!canSave}
        style={`padding: 6px var(--tandem-space-3); font-size: 13px; font-weight: 500; border: none; border-radius: var(--tandem-r-2); cursor: ${canSave ? "pointer" : "not-allowed"}; background: var(--tandem-accent); color: var(--tandem-accent-fg); opacity: ${canSave ? 1 : 0.5};`}
      >
        {isEditing ? "Save changes" : "Add model"}
      </button>
    </div>
  </form>
</div>
