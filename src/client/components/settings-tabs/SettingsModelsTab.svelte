<script lang="ts">
import { createLocalModelSettings } from "../../hooks/useLocalModelSettings.svelte";
import { createModels } from "../../hooks/useModels.svelte";
import type { ModelProvider, ModelRegistryEntry } from "../../hooks/useTandemSettings.svelte";
import { disabledControlStyle } from "../../utils/colors";
import ModelEditModal from "../ModelEditModal.svelte";
import type { SettingsTabContext } from "../SettingsModal.svelte";

// `SettingsTabContext` is the registry's uniform Props contract; besides
// `readOnly` this tab reads none of its fields directly (the Models
// registry is the server-authoritative store singleton, mutated via
// `models` below). Direct destructure off `$props()` keeps `readOnly` a
// live getter (never capture-then-destructure — see the SettingsTabContext
// doc-comment).
const { readOnly }: SettingsTabContext = $props();

// `createModels()` is a facade over the module-level store singleton —
// every caller shares the same server-loaded `$state`, so mutations
// propagate across consumers via shared reactivity.
const models = createModels();

// The server-owned "let local models comment and suggest changes" setting
// (#1123, ADR-039's opt-in tier). Loaded on every mount of this tab: the tab
// body is rebuilt on each tab switch and modal open, so this is also how a
// change made in another window is picked up (there is no live refresh). The
// call returns at once while dark. Lit, it sets the store's `loading` flag
// during this component's initialisation, which is outside any reaction, and
// everything else lands in promise continuations.
//
// Deliberately NOT gated on `readOnly`. That flag means the localStorage
// settings were written by a newer Tandem; this setting is a server file with
// no such schema, and switching it off must always be possible.
const localModel = createLocalModelSettings();
void localModel.load();

// The value is "settled" when a read or a save has told us what the server
// holds and no read is in flight. Otherwise the box is shown indeterminate and
// inert: it stays MOUNTED and focusable (`aria-disabled`, not `disabled`, which
// would drop keyboard focus to the page), but it claims nothing and a click on
// it does nothing — Retry and Switch off are the controls for that state.
const editingSettled = $derived(localModel.known && !localModel.loading);

// Retry and Switch off are replaced or removed by the state change they cause.
// A focused button that unmounts drops keyboard focus to the page, so each
// hands focus to the checkbox first — the one control here that never unmounts.
let editingBox = $state<HTMLInputElement | undefined>(undefined);

function retryEditingRead() {
  editingBox?.focus();
  void localModel.load();
}

function forceEditingOff() {
  editingBox?.focus();
  void localModel.setEditing(false);
}

function syncEditingBox(input: HTMLInputElement) {
  input.checked = editingSettled && localModel.editing;
  input.indeterminate = !editingSettled;
}

async function onEditingChange(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  if (!editingSettled) {
    syncEditingBox(input); // undo the browser's own toggle
    return;
  }
  await localModel.setEditing(input.checked);
  // Svelte skips a `checked` update whose value did not change, so after a
  // save that the server did not take, the DOM would keep the user's click.
  syncEditingBox(input);
}

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
// Modal-scoped error: a save failure (pre-write keychain throw OR a write that
// rolled back) shown INSIDE the open ModelEditModal — the active surface during
// a save. The list-level banner below binds the store's reactive `saveError`,
// which surfaces failures from the fire-and-forget mutators (default/toggle/
// delete) that have no modal.
let modalError = $state<string | null>(null);

function openAdd() {
  editingEntry = undefined;
  modalError = null;
  models.clearError(); // drop a stale list banner so it can't co-show with a modal error
  editorOpen = true;
}

function openEdit(entry: ModelRegistryEntry) {
  editingEntry = entry;
  modalError = null;
  models.clearError();
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
  modalError = null;
  try {
    // The store rolls back WITHOUT throwing, so branch on the return, not the
    // try/catch: a non-commit keeps the modal open with the error visible.
    const committed = editingEntry
      ? await models.updateModel(editingEntry.id, patch, plaintextApiKey)
      : (await models.addModel(patch, plaintextApiKey)) !== null;
    if (!committed) {
      modalError = models.saveError ?? "Failed to save model changes.";
      return;
    }
    editorOpen = false;
    editingEntry = undefined;
  } catch (err) {
    // Pre-write throw (keychain unavailable / store failed). Hygiene: never echo
    // the plaintext or raw server output — `useModels` already shapes the message
    // (`KEYCHAIN_UNAVAILABLE` / `STORE_FAILED`); surface it as-is.
    modalError = err instanceof Error ? err.message : "Failed to save";
  }
}

function closeModal() {
  editorOpen = false;
  editingEntry = undefined;
  modalError = null;
  models.clearError();
}

async function confirmDelete(id: string) {
  await models.deleteModel(id);
  pendingDeleteId = null;
}
</script>

<div style="display: flex; flex-direction: column; gap: var(--tandem-space-3);">
  {#if models.loading}
    <!-- Load in flight: a skeleton, NOT the "No models configured" empty state —
         `_models` is still [] mid-load and asserting "none" would be a lie. -->
    <div
      data-testid="models-loading"
      aria-busy="true"
      aria-label="Loading models"
      style="display: flex; flex-direction: column; gap: 4px;"
    >
      {#each [0, 1, 2] as i (i)}
        <div
          style="height: 44px; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-3); background: var(--tandem-surface-muted);"
        ></div>
      {/each}
    </div>
  {:else if models.loadFailed}
    <!-- Load threw: distinct from the empty state so we never claim "no models"
         when the truth is the fetch failed. Offers a retry via `reload`. -->
    <div
      role="alert"
      data-testid="models-load-error"
      style="padding: var(--tandem-space-5) var(--tandem-space-3); text-align: center; border: 1px dashed var(--tandem-error-border); border-radius: var(--tandem-r-3); color: var(--tandem-fg-muted); font-size: 13px;"
    >
      <p style="margin: 0 0 var(--tandem-space-3) 0;">Couldn't load your models from the server.</p>
      <button
        type="button"
        data-testid="models-reload-btn"
        onclick={() => models.reload()}
        style="padding: 6px var(--tandem-space-3); font-size: 13px; font-weight: 500; border: 1px solid var(--tandem-accent-border); border-radius: var(--tandem-r-2); cursor: pointer; background: var(--tandem-surface); color: var(--tandem-accent);"
      >
        Retry
      </button>
    </div>
  {:else if models.models.length === 0}
    <div
      data-testid="models-empty-state"
      style="padding: var(--tandem-space-5) var(--tandem-space-3); text-align: center; border: 1px dashed var(--tandem-border-strong); border-radius: var(--tandem-r-3); color: var(--tandem-fg-muted); font-size: 13px;"
    >
      <p style="margin: 0 0 var(--tandem-space-3) 0;">No models configured.</p>
      <button
        type="button"
        data-testid="model-add-btn"
        disabled={readOnly}
        onclick={openAdd}
        style="padding: 6px var(--tandem-space-3); font-size: 13px; font-weight: 500; border: none; border-radius: var(--tandem-r-2); {disabledControlStyle(readOnly)} background: var(--tandem-accent); color: var(--tandem-accent-fg);"
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
            <div class="settings-section-label">
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
                      disabled={readOnly}
                      onchange={() => models.setDefault(entry.id)}
                      style="accent-color: var(--tandem-accent); {disabledControlStyle(readOnly)}"
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
                      disabled={readOnly}
                      onchange={() => models.toggleEnabled(entry.id)}
                      style="accent-color: var(--tandem-accent); {disabledControlStyle(readOnly)}"
                    />
                    <span>{entry.enabled ? "On" : "Off"}</span>
                  </label>
                  <button
                    type="button"
                    data-testid={`model-edit-btn-${entry.id}`}
                    disabled={readOnly}
                    onclick={() => openEdit(entry)}
                    style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); {disabledControlStyle(readOnly)}"
                  >
                    Edit
                  </button>
                  {#if pendingDeleteId === entry.id}
                    <button
                      type="button"
                      data-testid={`model-delete-confirm-${entry.id}`}
                      disabled={readOnly}
                      onclick={() => confirmDelete(entry.id)}
                      style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-error-border); border-radius: var(--tandem-r-2); background: var(--tandem-error-bg); color: var(--tandem-error-fg-strong); {disabledControlStyle(readOnly)}"
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
                      disabled={readOnly}
                      onclick={() => (pendingDeleteId = entry.id)}
                      style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-error-fg-strong); {disabledControlStyle(readOnly)}"
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
      disabled={readOnly}
      onclick={openAdd}
      style="align-self: flex-start; padding: 6px var(--tandem-space-3); font-size: 13px; font-weight: 500; border: 1px solid var(--tandem-accent-border); border-radius: var(--tandem-r-2); {disabledControlStyle(readOnly)} background: var(--tandem-surface); color: var(--tandem-accent);"
    >
      + Add model
    </button>
  {/if}
</div>

<!-- Rendered outside the loading / load-failed / empty / list chain above, so
     the off switch is there in every state of the list. -->
<section
  data-testid="local-model-editing-section"
  style="display: flex; flex-direction: column; gap: var(--tandem-space-2); margin-top: var(--tandem-space-4); padding-top: var(--tandem-space-3); border-top: 1px solid var(--tandem-border);"
>
  <div class="settings-section-label">Local models and your document</div>
  <label
    style="display: flex; align-items: flex-start; gap: var(--tandem-space-2); font-size: 13px; color: var(--tandem-fg);"
  >
    <input
      type="checkbox"
      data-testid="local-model-editing-toggle"
      bind:this={editingBox}
      checked={editingSettled && localModel.editing}
      indeterminate={!editingSettled}
      aria-disabled={!editingSettled}
      aria-describedby="local-model-editing-help"
      onchange={onEditingChange}
      style="margin-top: 2px; accent-color: var(--tandem-accent); cursor: {editingSettled
        ? 'pointer'
        : 'not-allowed'};"
    />
    <span>Let local models comment and suggest changes</span>
  </label>
  {#if !editingSettled}
    <!-- The server's value is not known (still reading, or the read failed), so
         the box above is indeterminate and inert. Switch off is offered in both
         cases: a read that hangs or fails must not be the reason commenting
         cannot be turned off. Live-region roles sit on the TEXT only. -->
    <div
      style="display: flex; flex-wrap: wrap; align-items: center; gap: var(--tandem-space-2); font-size: 12px; color: var(--tandem-fg-muted);"
    >
      {#if localModel.loadFailed && !localModel.loading}
        <span role="alert" data-testid="local-model-editing-load-error">
          Couldn't read whether local models may comment and suggest changes.
        </span>
        <button
          type="button"
          data-testid="local-model-editing-retry"
          onclick={retryEditingRead}
          style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); cursor: pointer;"
        >
          Retry
        </button>
        <button
          type="button"
          data-testid="local-model-editing-force-off"
          onclick={forceEditingOff}
          style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); cursor: pointer;"
        >
          Switch off
        </button>
      {:else}
        <span role="status" data-testid="local-model-editing-loading">Checking…</span>
        <button
          type="button"
          data-testid="local-model-editing-force-off-pending"
          onclick={forceEditingOff}
          style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); cursor: pointer;"
        >
          Switch off
        </button>
      {/if}
    </div>
  {/if}
  <p
    id="local-model-editing-help"
    style="margin: 0; font-size: 12px; color: var(--tandem-fg-muted);"
  >
    Experimental — review every suggestion. When this is on, a local model can add comments,
    suggest replacements and reply in comment threads. When it is off, local models can read
    your document and reply in chat only. A change here applies from your next message;
    switching it off also stops a reply that is already running from adding more.
  </p>
  {#if localModel.saveNotice}
    <div
      role="alert"
      data-testid="local-model-editing-error"
      style="padding: var(--tandem-space-2) var(--tandem-space-3); border: 1px solid var(--tandem-error-border); border-radius: var(--tandem-r-3); background: var(--tandem-error-bg); color: var(--tandem-error-fg-strong); font-size: 12px;"
    >
      {localModel.saveNotice}
    </div>
  {/if}
</section>

<!-- List-level banner: the store's reactive `saveError`, set by a rolled-back
     fire-and-forget mutator (default/toggle/delete). Suppressed while the editor
     is open (the modal owns error display via `modalError` — else the same
     message co-shows here behind the scrim) and while `loadFailed` (that state
     renders its own message + retry above). -->
{#if models.saveError && !editorOpen && !models.loadFailed}
  <div
    role="alert"
    data-testid="models-save-error"
    style="padding: var(--tandem-space-2) var(--tandem-space-3); border: 1px solid var(--tandem-error-border); border-radius: var(--tandem-r-3); background: var(--tandem-error-bg); color: var(--tandem-error-fg-strong); font-size: 12px;"
  >
    {models.saveError}
  </div>
{/if}

{#if editorOpen}
  <ModelEditModal
    entry={editingEntry}
    error={modalError}
    onCancel={closeModal}
    onSave={handleSave}
  />
{/if}
