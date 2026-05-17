<script lang="ts">
import { createModels } from "../../hooks/useModels.svelte";
import type { ModelProvider, ModelRegistryEntry } from "../../hooks/useTandemSettings.svelte";
import { createTandemSettings } from "../../hooks/useTandemSettings.svelte";
import ModelEditModal from "../ModelEditModal.svelte";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// SettingsTabContext is the registry's uniform shape; this tab reads no
// fields off it directly (the Models registry hangs off a parallel
// settings instance created here so the tab can mutate `models` without
// the modal's parent caring). But the type contract is honored so the
// registry stays uniform.
// `SettingsTabContext` is the registry's uniform Props contract; this tab
// reads none of its fields (the Models registry hangs off a parallel
// `createTandemSettings()` instantiated below so the tab can mutate
// `models` without threading it through the parent modal's `onUpdate`).
// We type via a no-op destructure for registry conformance; nothing is
// destructured into local state.
const {}: SettingsTabContext = $props();

// We instantiate our own `createTandemSettings` rather than pull it
// through props. Reason: the rest of the SettingsModal threads a curated
// subset of fields via the `SettingsTabContext`, and routing the Models
// CRUD through that single `onUpdate` would require wiring `models`
// everywhere `onUpdate` is called. Instantiating here keeps the surface
// confined; both instances back to the same localStorage key so writes
// stay coherent.
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

function openAdd() {
  editingEntry = undefined;
  editorOpen = true;
}

function openEdit(entry: ModelRegistryEntry) {
  editingEntry = entry;
  editorOpen = true;
}

function handleSave(data: {
  provider: ModelProvider;
  displayName: string;
  modelId: string;
  apiKey?: string;
  endpoint?: string;
  enabled: boolean;
}) {
  if (editingEntry) {
    models.updateModel(editingEntry.id, data);
  } else {
    models.addModel(data);
  }
  editorOpen = false;
  editingEntry = undefined;
}

function confirmDelete(id: string) {
  models.deleteModel(id);
  pendingDeleteId = null;
}
</script>

<div style="display: flex; flex-direction: column; gap: var(--tandem-space-3);">
  <!-- In-product disclosure banner. Uses --tandem-warning-* per the
       token guidance. API keys live in plaintext localStorage today;
       the keychain migration is tracked alongside the Wave 6 work. -->
  <div
    data-testid="models-disclosure-banner"
    role="note"
    style="padding: var(--tandem-space-2) var(--tandem-space-3); border: 1px solid var(--tandem-warning-border); border-radius: var(--tandem-r-3); background: var(--tandem-warning-bg); color: var(--tandem-warning-fg-strong); font-size: 12px; line-height: 1.5;"
  >
    <strong style="font-weight: 600;">API keys are stored unencrypted in browser storage.</strong>
    A future release will move them to OS keychain.
  </div>

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

{#if editorOpen}
  <ModelEditModal
    entry={editingEntry}
    onCancel={() => {
      editorOpen = false;
      editingEntry = undefined;
    }}
    onSave={handleSave}
  />
{/if}
