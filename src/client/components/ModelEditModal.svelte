<script lang="ts">
import { onMount, untrack } from "svelte";
import { isLocalProvider } from "../../shared/models/contract.js";
import {
  endpointPrefill,
  PROVIDER_LABEL,
  PROVIDER_OPTION_ORDER,
  providerHeading,
} from "../../shared/models/provider-ui.js";
import type { ModelProvider, ModelRegistryEntry } from "../hooks/useTandemSettings.svelte.js";
import { trapTab } from "../utils/focus-trap.js";
import { endpointHint, LOCAL_REQUEST_LINE, LOCAL_SERVERS_LINE } from "../utils/local-model-copy.js";
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
  /**
   * The server will not take a save from this page (#2404: only Tandem's own
   * window can change these settings). Save stays in the dialog and focusable
   * (`aria-disabled`, not `disabled`, which would drop keyboard focus) but does
   * nothing, by click or by Enter; `error` carries the reason. The dialog is
   * kept open so nothing the user typed is thrown away.
   */
  saveUnavailable?: boolean;
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

const { entry, error, saveUnavailable = false, onCancel, onSave }: Props = $props();

// Only LOCAL providers are offered (#1123, ADR-039 P4 "Hide until they work"):
// a cloud provider is neither listed nor selectable, so no option can promise a
// cloud key. The split is the contract's `isLocalProvider`, the same predicate
// the collaborator loop resolves by; the order is the contract-derived
// `PROVIDER_OPTION_ORDER`, so no local provider can be left out.
//
// An OLD cloud entry (saved by an earlier version, or by a non-UI caller) never
// reaches the form below: it opens the unavailable view instead (ADR-039's
// "Shown as unavailable" pick). The form's cloud half — the API-key block, its
// `replacingKey` / `apiKey` state and the cloud arms of `canSave` and
// `handleSubmit` — is therefore unreachable, and kept on purpose: its test ids
// (`model-edit-apikey`, `model-edit-apikey-replace-btn`) are in the test-id
// contract (`testid-coverage.test.ts`), and cloud keys may return.
const PROVIDER_OPTIONS: Array<{ value: ModelProvider; label: string }> =
  PROVIDER_OPTION_ORDER.filter((p) => isLocalProvider(p)).map((value) => ({
    value,
    label: PROVIDER_LABEL[value],
  }));

// Discrete $state per field, hydrated ONCE from the `entry` prop snapshot.
// We deliberately don't track `entry` reactively: the parent unmounts and
// remounts this component when the editing target changes ({#if editorOpen}),
// so a stable prop snapshot is the contract — `untrack` quiets the
// svelte-check warning while pinning the intent. Reactive form state lives
// in the per-field $state below.
const initialEntry = untrack(() => entry);

// A NEW entry defaults to the first local provider. An existing entry keeps its
// stored provider; a cloud one is shown by the unavailable view, never the form.
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
// An old cloud entry: the window shows it as unavailable — its name, its
// provider and why — with Close as the only action, and no form. Plain, from
// the snapshot: the parent remounts this component per entry.
const providerUnavailable = initialEntry !== undefined && !isLocalProvider(initialEntry.provider);
const UNAVAILABLE_TITLE = "Model unavailable";
const UNAVAILABLE_TEXT = "This provider can't be used in Tandem.";
// The entry as the user named it, or its model ID when it has no name (and its
// id when a hand-edited file left both empty), so the user can tell which it is.
const unavailableName =
  [initialEntry?.displayName, initialEntry?.modelId, initialEntry?.id].find(
    (v) => v !== undefined && v.trim() !== "",
  ) ?? "";
// Derived from the contract helper, the same predicate that filters the
// provider options above and decides the unavailable view, so the key/endpoint
// field gating can never disagree with them about what "cloud" means.
const isLocal = $derived(isLocalProvider(provider));
const isCloud = $derived(!isLocal);
// #1123 Ruling L-f: a new entry's address stays empty; the selected provider's
// documented address (or nothing) is the placeholder and the hint's example.
const prefill = $derived(endpointPrefill(provider));

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
    (!isCloud || !replacingKey || apiKey.trim().length > 0) &&
    // Local providers require an endpoint (the loop can't resolve an endpoint-less
    // local model) — matches FirstRunModelPickerModal's canSave so the two pickers
    // can't diverge on what a saveable local entry is.
    (isCloud || endpoint.trim().length > 0),
);

function handleSubmit(e: SubmitEvent) {
  e.preventDefault();
  if (!canSave || saveUnavailable) return;

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

let dialogEl: HTMLDivElement | undefined = $state();

// The unavailable view only: move focus to Close, so its name and the sentence
// describing the dialog are read on open. The local edit and Add windows move
// no focus on mount (that is ADR-039 item 27's, the accessibility PR).
onMount(() => {
  // Found through the dialog's existing binding: a `bind:this` of its own would
  // need a new `$state` for nothing reactive.
  if (providerUnavailable) {
    dialogEl
      ?.querySelector<HTMLButtonElement>('[data-testid="model-edit-unavailable-close"]')
      ?.focus();
  }
});

// Tab focus trap (#1778). `aria-modal="true"` promises assistive tech that
// everything outside is inert, and without this real focus walked the app
// behind the scrim on the first Tab.
//
// Window-level rather than an element `onkeydown`, because `trapTab`'s
// recover-focus branch is the half that matters: a click on the dialog's own
// padding leaves `document.activeElement` on `<body>`, and an element handler
// never fires again once focus is outside.
//
// The owner bail is required, not decorative. `trapTab`'s recover branch fires
// whenever focus is outside ITS container — including inside another open
// dialog — with no `defaultPrevented` check, so two live traps ping-pong within
// one keydown. A bare `if (e.defaultPrevented) return;` is NOT a substitute:
// `trapTab` preventDefaults only on the wrap and recover branches, so ordinary
// mid-dialog Tabs would still reach both handlers.
$effect(() => {
  const handler = (e: KeyboardEvent) => {
    const owner = (document.activeElement as Element | null)?.closest('[aria-modal="true"]');
    if (owner && owner !== dialogEl && !dialogEl?.contains(owner)) return;
    trapTab(e, dialogEl ?? null);
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
});

function startReplacingKey() {
  replacingKey = true;
  apiKey = "";
}
</script>

<div
  bind:this={dialogEl}
  role="dialog"
  aria-modal="true"
  aria-label={providerUnavailable ? UNAVAILABLE_TITLE : isEditing ? "Edit model" : "Add model"}
  aria-describedby={providerUnavailable ? "model-edit-unavailable-text" : undefined}
  tabindex={-1}
  data-testid="model-edit-modal"
  class="mem-scrim"
  onclick={(e) => {
    if (e.target === e.currentTarget) onCancel();
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") {
      // Stop it here: this dialog renders inside SettingsModal, whose
      // document-level Escape listener stands down only while another
      // aria-modal dialog is still in the DOM — and with a real key press
      // Svelte's flush removes this one in the microtask gap before that
      // listener runs, so one press would close Settings as well.
      e.stopPropagation();
      onCancel();
    }
  }}
>
  {#if providerUnavailable}
  <div class="mem-dialog">
    <div class="mem-header">
      <h3 class="mem-title">{UNAVAILABLE_TITLE}</h3>
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

    <div class="mem-unavailable-name">{unavailableName}</div>

    <!-- Not a <label>: there is no control to label (svelte-check refuses one). -->
    <div class="mem-field">
      <span class="mem-label">Provider</span>
      <span class="mem-unavailable-provider" data-testid="model-edit-unavailable-provider">
        {providerHeading(provider)}
      </span>
    </div>

    <p id="model-edit-unavailable-text" data-testid="model-edit-provider-note" class="mem-unavailable">
      {UNAVAILABLE_TEXT}
    </p>

    <div class="mem-actions">
      <button
        type="button"
        class="mem-btn mem-btn--ghost"
        data-testid="model-edit-unavailable-close"
        onclick={onCancel}
      >
        Close
      </button>
    </div>
  </div>
  {:else}
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
        value={provider}
        onchange={(e) => (provider = e.currentTarget.value as ModelProvider)}
      >
        {#each PROVIDER_OPTIONS as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </label>

    {#if isLocal}
      <div class="mem-local-intro" data-testid="model-edit-local-intro">
        <p>{LOCAL_SERVERS_LINE}</p>
        <p>{LOCAL_REQUEST_LINE}</p>
      </div>
    {/if}

    <label class="mem-field">
      <span class="mem-label">Display name</span>
      <input
        data-testid="model-edit-displayname"
        class="mem-input"
        type="text"
        autocomplete="off"
        bind:value={displayName}
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
      <!-- The hint sits OUTSIDE the label and is linked by aria-describedby, so
           the field's accessible name stays "Endpoint". -->
      <div class="mem-field">
        <label class="mem-field">
          <span class="mem-label">Endpoint</span>
          <input
            data-testid="model-edit-endpoint"
            class="mem-input mem-input--mono"
            type="text"
            autocomplete="off"
            bind:value={endpoint}
            placeholder={prefill}
            aria-describedby="model-edit-endpoint-hint"
          />
        </label>
        <p id="model-edit-endpoint-hint" class="mem-hint" data-testid="model-edit-endpoint-hint">
          {endpointHint(prefill)}
        </p>
      </div>
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
      <div role="alert" id="model-edit-error-text" data-testid="model-edit-error" class="mem-error">
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
        aria-disabled={saveUnavailable}
        aria-describedby={saveUnavailable ? "model-edit-error-text" : undefined}
        style={saveUnavailable ? "opacity: 0.5; cursor: not-allowed;" : undefined}
      >
        {isEditing ? "Save changes" : "Add model"}
      </button>
    </div>
  </form>
  {/if}
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

  /* An old cloud entry's window (#1123): the entry's name, its provider and why
     it can't be used. Muted, never `--tandem-fg-subtle`, which forced colours
     turn into GrayText. */
  .mem-unavailable-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--tandem-fg);
    overflow-wrap: anywhere;
  }
  .mem-unavailable-provider {
    font-size: 13px;
    color: var(--tandem-fg);
  }
  .mem-unavailable {
    margin: 0;
    font-size: 12px;
    color: var(--tandem-fg-muted);
  }

  .mem-local-intro {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--tandem-fg-muted);
  }
  .mem-local-intro p {
    margin: 0;
  }
  .mem-hint {
    margin: 0;
    font-size: 11px;
    color: var(--tandem-fg-muted);
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
