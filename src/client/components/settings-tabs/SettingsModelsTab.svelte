<script lang="ts">
import { createModels } from "../../hooks/useModels.svelte";
import type { ModelProvider, ModelRegistryEntry } from "../../hooks/useTandemSettings.svelte";
import { createTandemSettings } from "../../hooks/useTandemSettings.svelte";
import ModelEditModal from "../ModelEditModal.svelte";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// `SettingsTabContext` is the registry's uniform Props contract; this
// tab reads none of its fields directly (the Models registry hangs off
// the shared `createTandemSettings()` singleton, mutated via `models`
// below). We type via a no-op destructure for registry conformance.
const {}: SettingsTabContext = $props();

// `createTandemSettings()` is a module-level singleton — calling it
// here returns the same instance App.svelte uses. Mutations propagate
// via shared `$state` reactivity, and serial localStorage writes
// accumulate instead of clobbering across consumers.
const settingsState = createTandemSettings();
const models = createModels(settingsState);

const PROVIDER_LABEL: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  "local-ollama": "Ollama (local)",
  "local-llamacpp": "llama.cpp (local)",
};

// Anthropic first per the D4 ordering anchor; remaining providers in
// declaration order.
const PROVIDER_ORDER: ModelProvider[] = [
  "anthropic",
  "openai",
  "gemini",
  "local-ollama",
  "local-llamacpp",
];

const grouped = $derived.by(() => {
  const out = new Map<ModelProvider, ModelRegistryEntry[]>();
  for (const p of PROVIDER_ORDER) out.set(p, []);
  for (const m of models.models) {
    const bucket = out.get(m.provider);
    if (bucket) bucket.push(m);
  }
  return out;
});

let editingEntry = $state<ModelRegistryEntry | undefined>(undefined);
let editorOpen = $state(false);
let pendingDeleteId = $state<string | null>(null);
let saveError = $state<string | null>(null);
let migratingLegacy = $state(false);
let migrationStatus = $state<string | null>(null);

function openAdd() {
  editingEntry = undefined;
  saveError = null;
  editorOpen = true;
}

function openEdit(entry: ModelRegistryEntry) {
  editingEntry = entry;
  saveError = null;
  editorOpen = true;
}

async function handleSave(data: {
  provider: ModelProvider;
  displayName: string;
  modelId: string;
  plaintextApiKey?: string;
  endpoint?: string;
  enabled: boolean;
}) {
  const { plaintextApiKey, ...patch } = data;
  try {
    if (editingEntry) {
      await models.updateModel(editingEntry.id, patch, plaintextApiKey);
    } else {
      await models.addModel(patch, plaintextApiKey);
    }
    editorOpen = false;
    editingEntry = undefined;
    saveError = null;
  } catch (err) {
    // Hygiene: never echo the plaintext or detailed server output. The
    // error message in `useModels` is already shaped (`KEYCHAIN_UNAVAILABLE`
    // / `HTTP_xxx`) — surface it as-is for diagnostic value without
    // leaking secret-bearing payload.
    saveError = err instanceof Error ? err.message : "Failed to save";
  }
}

async function confirmDelete(id: string) {
  await models.deleteModel(id);
  pendingDeleteId = null;
}

async function runLegacyMigration() {
  migratingLegacy = true;
  migrationStatus = null;
  try {
    const result = await models.migrateLegacyKeys();
    if (result.failed > 0) {
      migrationStatus = `Migrated ${result.migrated}; ${result.failed} failed. Retry?`;
    } else if (result.migrated > 0) {
      migrationStatus = `Migrated ${result.migrated} ${result.migrated === 1 ? "key" : "keys"} to OS keychain.`;
    }
  } finally {
    migratingLegacy = false;
  }
}

function setAsDefault(id: string) {
  models.setDefault(id);
}
</script>

<div style="display: flex; flex-direction: column; gap: var(--tandem-space-3);">
  <!-- Legacy-key migration banner (#659). Appears only when a pre-v7 blob
       carried plaintext `apiKey` values; one click migrates each to the
       OS keychain and rewrites the entry with an opaque `apiKeyRef`.
       Banner disappears as soon as the legacy fields are gone. -->
  {#if models.hasLegacyKeys}
    <div
      data-testid="models-legacy-migration-banner"
      role="note"
      style="padding: var(--tandem-space-2) var(--tandem-space-3); border: 1px solid var(--tandem-warning-border); border-radius: var(--tandem-r-3); background: var(--tandem-warning-bg); color: var(--tandem-warning-fg-strong); font-size: 12px; line-height: 1.5; display: flex; flex-direction: column; gap: var(--tandem-space-2);"
    >
      <div>
        <strong style="font-weight: 600;">Move API keys to OS keychain.</strong>
        Existing keys were stored unencrypted in browser storage. Move them now to
        encrypt them with your operating system's credential store.
      </div>
      <div style="display: flex; align-items: center; gap: var(--tandem-space-2);">
        <button
          type="button"
          data-testid="models-legacy-migrate-btn"
          disabled={migratingLegacy}
          onclick={runLegacyMigration}
          style={`padding: 4px var(--tandem-space-3); font-size: 12px; font-weight: 500; border: 1px solid var(--tandem-warning-border); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-warning-fg-strong); cursor: ${migratingLegacy ? "wait" : "pointer"};`}
        >
          {migratingLegacy ? "Migrating…" : "Migrate keys"}
        </button>
        {#if migrationStatus}
          <span data-testid="models-legacy-migration-status">{migrationStatus}</span>
        {/if}
      </div>
    </div>
  {/if}

  {#if models.models.length === 0}
    <div
      data-testid="models-empty-state"
      style="padding: var(--tandem-space-5) var(--tandem-space-3); text-align: center; border: 1px dashed var(--tandem-border-strong); border-radius: var(--tandem-r-3); color: var(--tandem-fg-muted); font-size: 13px;"
    >
      <p style="margin: 0 0 var(--tandem-space-3) 0;">No models configured.</p>
      <button
        type="button"
        data-testid="model-add-btn"
        onclick={openAdd}
        style="padding: 6px var(--tandem-space-3); font-size: 13px; font-weight: 500; border: none; border-radius: var(--tandem-r-2); cursor: pointer; background: var(--tandem-accent); color: var(--tandem-accent-fg);"
      >
        Add your first model
      </button>
    </div>
  {:else}
    <div style="display: flex; flex-direction: column; gap: var(--tandem-space-3);">
      {#each PROVIDER_ORDER as provider (provider)}
        {@const bucket = grouped.get(provider) ?? []}
        {#if bucket.length > 0}
          <div>
            <div
              style="font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;"
            >
              {PROVIDER_LABEL[provider]}
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px;">
              {#each bucket as entry (entry.id)}
                <div
                  data-testid={`model-row-${entry.id}`}
                  style="display: flex; align-items: center; gap: var(--tandem-space-2); padding: var(--tandem-space-2) var(--tandem-space-3); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-3); background: var(--tandem-surface);"
                >
                  <div style="flex: 1; min-width: 0;">
                    <div
                      style="font-size: 13px; color: var(--tandem-fg); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                    >
                      {entry.displayName}
                    </div>
                    <div
                      style="font-size: 11px; color: var(--tandem-fg-subtle); font-family: var(--tandem-font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                    >
                      {entry.modelId}
                    </div>
                  </div>
                  <label
                    style="display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--tandem-fg-muted);"
                    title="Use as the default model"
                  >
                    <input
                      type="radio"
                      name="default-model"
                      data-testid={`model-default-${entry.id}`}
                      checked={models.defaultModelId === entry.id}
                      onchange={() => setAsDefault(entry.id)}
                      style="accent-color: var(--tandem-accent);"
                    />
                    <span>Default</span>
                  </label>
                  <label
                    style="display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--tandem-fg-muted);"
                  >
                    <input
                      type="checkbox"
                      data-testid={`model-toggle-${entry.id}`}
                      checked={entry.enabled}
                      onchange={() => models.toggleEnabled(entry.id)}
                      style="accent-color: var(--tandem-accent);"
                    />
                    <span>{entry.enabled ? "On" : "Off"}</span>
                  </label>
                  <button
                    type="button"
                    data-testid={`model-edit-btn-${entry.id}`}
                    onclick={() => openEdit(entry)}
                    style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); cursor: pointer;"
                  >
                    Edit
                  </button>
                  {#if pendingDeleteId === entry.id}
                    <button
                      type="button"
                      data-testid={`model-delete-confirm-${entry.id}`}
                      onclick={() => confirmDelete(entry.id)}
                      style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-error-border); border-radius: var(--tandem-r-2); background: var(--tandem-error-bg); color: var(--tandem-error-fg-strong); cursor: pointer;"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onclick={() => (pendingDeleteId = null)}
                      style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: pointer;"
                    >
                      Cancel
                    </button>
                  {:else}
                    <button
                      type="button"
                      data-testid={`model-delete-btn-${entry.id}`}
                      onclick={() => (pendingDeleteId = entry.id)}
                      style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-error-fg); cursor: pointer;"
                    >
                      Delete
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/each}
    </div>

    <button
      type="button"
      data-testid="model-add-btn"
      onclick={openAdd}
      style="align-self: flex-start; padding: 6px var(--tandem-space-3); font-size: 13px; font-weight: 500; border: 1px solid var(--tandem-accent-border); border-radius: var(--tandem-r-2); cursor: pointer; background: var(--tandem-surface); color: var(--tandem-accent);"
    >
      + Add model
    </button>
  {/if}
</div>

{#if saveError}
  <div
    role="alert"
    data-testid="models-save-error"
    style="padding: var(--tandem-space-2) var(--tandem-space-3); border: 1px solid var(--tandem-error-border); border-radius: var(--tandem-r-3); background: var(--tandem-error-bg); color: var(--tandem-error-fg-strong); font-size: 12px;"
  >
    {saveError}
  </div>
{/if}

{#if editorOpen}
  <ModelEditModal
    entry={editingEntry}
    onCancel={() => {
      editorOpen = false;
      editingEntry = undefined;
      saveError = null;
    }}
    onSave={handleSave}
  />
{/if}
