<script lang="ts">
import { untrack } from "svelte";
import type { ModelProvider, ModelRegistryEntry } from "../hooks/useTandemSettings.svelte.js";
import CollapsibleSection from "./CollapsibleSection.svelte";

interface Props {
  /** Existing entry when editing; `undefined` when adding. */
  entry?: ModelRegistryEntry;
  onCancel: () => void;
  /**
   * Save handler. `apiKey` and `endpoint` are passed through verbatim;
   * the parent decides whether to call `models.addModel` or
   * `models.updateModel` based on whether `entry` was supplied.
   *
   * On edit mode the parent passes `entry.apiKey` as the existing value;
   * if the user did NOT click "Replace key", `apiKey` in the payload
   * carries the existing value unchanged (round-trips through this
   * component but never through the DOM). If the user did click
   * "Replace key", `apiKey` carries the new plaintext value.
   */
  onSave: (data: {
    provider: ModelProvider;
    displayName: string;
    modelId: string;
    apiKey?: string;
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

// Reveal-gated apiKey state. On edit mode with an existing key, `apiKey`
// stays empty in the DOM (`type="password"` masks visually, but the DOM
// `value` attribute is still serialized by DevTools snapshots — we
// double-defend by never round-tripping the existing key through the
// editable input). `replacingKey` flips to true only when the user
// explicitly clicks "Replace key", at which point the input becomes
// editable and the parent's save handler will write whatever the user
// types.
let apiKey = $state("");
let replacingKey = $state(initialEntry === undefined || !initialEntry.apiKey);

const isEditing = initialEntry !== undefined;
const isCloud = $derived(
  provider === "anthropic" || provider === "openai" || provider === "gemini",
);
const isLocal = $derived(provider.startsWith("local-"));

// Last 4 chars of the existing key for the masked preview. Reading the
// existing key value here keeps it confined to the script block; it never
// reaches a DOM attribute. Empty string when no existing key.
const existingKeyTail = initialEntry?.apiKey ? initialEntry.apiKey.slice(-4) : "";

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

  // Build the payload. apiKey: if replacing, use the new value; else
  // round-trip the existing one (only present in edit mode). endpoint
  // is similarly gated to local providers.
  const payload: Parameters<typeof onSave>[0] = {
    provider,
    displayName: displayName.trim(),
    modelId: modelId.trim(),
    enabled,
  };
  if (isCloud) {
    if (replacingKey) {
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
    } else if (initialEntry?.apiKey) {
      payload.apiKey = initialEntry.apiKey;
    }
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
        {#if isEditing && initialEntry?.apiKey && !replacingKey}
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
