<script lang="ts">
import { onMount, untrack } from "svelte";
import { isLocalProvider } from "../../shared/models/contract.js";
import {
  endpointAfterProviderChange,
  endpointPrefill,
  nameFallback,
  PROVIDER_LABEL,
  PROVIDER_OPTION_ORDER,
  providerHeading,
} from "../../shared/models/provider-ui.js";
import type { ModelProvider, ModelRegistryEntry } from "../hooks/useTandemSettings.svelte.js";
import { trapTab } from "../utils/focus-trap.js";
import {
  endpointHint,
  LOCAL_REQUEST_LINE,
  LOCAL_SERVERS_LINE,
  modelRowName,
  modelSaveReason,
} from "../utils/local-model-copy.js";
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
  }) => void | Promise<unknown>;
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
const initialProvider: ModelProvider = initialEntry?.provider ?? "local-ollama";
let provider = $state<ModelProvider>(initialProvider);
// On Add the name starts empty: a blank name saves as the provider's fallback
// (`nameFallback`, V18). On Edit it holds the stored name, and a provider change
// never touches it.
let displayName = $state(initialEntry?.displayName ?? "");
let modelId = $state(initialEntry?.modelId ?? "");
// #1123 V2: Add starts at the provider's usual address (Ollama's, or "" for a
// provider with none); an existing entry keeps its saved address, or "".
let endpoint = $state(
  initialEntry ? (initialEntry.endpoint ?? "") : endpointPrefill(initialProvider),
);
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
const unavailableName = initialEntry ? modelRowName(initialEntry) : "";
// Derived from the contract helper, the same predicate that filters the
// provider options above and decides the unavailable view, so the key/endpoint
// field gating can never disagree with them about what "cloud" means.
const isLocal = $derived(isLocalProvider(provider));
const isCloud = $derived(!isLocal);
// The selected provider's documented address (or nothing): the Endpoint's
// placeholder and the hint's example. A new entry also starts with it filled in
// (V2, which replaced Ruling L-f's edit-modal half).
const prefill = $derived(endpointPrefill(provider));

// Last 4 chars of the opaque `apiKeyRef` for the masked preview. The ref
// is not sensitive (no read path exposes the plaintext from it), but it
// also isn't user-meaningful — surfacing four chars is enough to
// disambiguate "I have a key stored" vs "I don't" without leaking the
// secret itself.
const existingKeyTail = initialEntry?.apiKeyRef ? initialEntry.apiKeyRef.slice(-4) : "";

// Why Save cannot save (a local provider), or null (#1123 P10(5), V9): one
// reason at a time, Model ID first. The address check is the server's own
// `validateEndpoint`, called for this line only; the server checks again at
// resolve and at fetch.
const saveReason = $derived(isCloud ? null : modelSaveReason({ modelId, endpoint }));
// A local entry can save exactly when there is no reason not to (the Display
// name is optional, V18). The cloud arm is unreachable (see above) and keeps
// its old conjuncts: a name, a model id, and the existing key or a new one.
const canSave = $derived(
  isCloud
    ? displayName.trim().length > 0 &&
        modelId.trim().length > 0 &&
        (!replacingKey || apiKey.trim().length > 0)
    : saveReason === null,
);
// Save is focusable but does nothing (`aria-disabled`, never `disabled`): while
// the page is refused (#2404), or while the form cannot save.
const saveInert = $derived(saveUnavailable || !canSave);

// One save per press (#1123, carried item 6): set from the press until the
// parent's save settles, so a second press (or a held Enter) sends nothing.
// Save stays focusable and `aria-disabled` meanwhile, never natively disabled,
// and reads "Saving…" (Ruling R-b). Each opened window has its own latch.
let saving = $state(false);

async function handleSubmit(e: SubmitEvent) {
  e.preventDefault();
  if (saving) return;
  if (!canSave || saveUnavailable) return;

  // Build the payload. plaintextApiKey is set ONLY when the user typed a
  // new key (add mode or "Replace key" path). In no-op edit, the field is
  // omitted and the parent preserves the existing `apiKeyRef`. Endpoint
  // is similarly gated to local providers.
  // A blank name on Add saves as the selected provider's fallback (V18), the
  // one shown as the placeholder; on Edit the field's text is saved, "" too.
  const payload: Parameters<typeof onSave>[0] = {
    provider,
    displayName: isEditing ? displayName.trim() : displayName.trim() || nameFallback(provider),
    modelId: modelId.trim(),
    enabled,
  };
  if (isCloud && replacingKey && apiKey.trim()) {
    payload.plaintextApiKey = apiKey.trim();
  }
  if (isLocal && endpoint.trim()) {
    payload.endpoint = endpoint.trim();
  }
  saving = true;
  try {
    await onSave(payload);
  } catch (err) {
    // `onSave` is a prop: the Models tab's never rejects, but a caller's might.
    console.warn("[models] save failed", err);
  } finally {
    // Harmless after unmount (a committed save closes this window).
    saving = false;
  }
}

let dialogEl: HTMLDivElement | undefined = $state();

// Focus moves in once, on open (#1123, ADR-039 item 27): the unavailable view
// to Close, so its name and the sentence describing the dialog are read; Add and
// Edit to the Provider select, the first field, so the dialog's name is read
// and Escape works at once (the dialog's Escape is its own `onkeydown`). A
// provider change never moves focus. `onMount`, never an `$effect`: it must run
// once, not again on a later state change.
onMount(() => {
  // Found through the dialog's existing binding: a `bind:this` of its own would
  // need a new `$state` for nothing reactive.
  const target = providerUnavailable
    ? '[data-testid="model-edit-unavailable-close"]'
    : '[data-testid="model-edit-provider"]';
  dialogEl?.querySelector<HTMLElement>(target)?.focus();
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
//
// Escape with focus stranded on the page (#1123, ADR-039 item 27, carried item
// 4): the dialog's own `onkeydown` cannot see it, and Settings' Escape stands
// down while this dialog is open, so without this branch Escape did nothing.
// Only when no other modal is open above this one (the first-run window, say),
// which owns that Escape instead. With focus inside the dialog the scrim's
// handler stops the event first, so this never runs twice.
$effect(() => {
  const handler = (e: KeyboardEvent) => {
    const owner = (document.activeElement as Element | null)?.closest('[aria-modal="true"]');
    if (owner && owner !== dialogEl && !dialogEl?.contains(owner)) return;
    if (e.key === "Escape") {
      if (e.defaultPrevented || e.isComposing) return;
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const above = Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
        (d) => d !== dialogEl && !d.contains(dialogEl ?? null) && !d.closest("[inert]"),
      );
      if (above) return;
      e.preventDefault();
      onCancel();
      return;
    }
    trapTab(e, dialogEl ?? null);
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
});

// The only writer of `provider` and, on Add, of `endpoint` besides the field's
// binding (#1123 R1.2). The address follows the provider only on Add and only
// while it still holds the previous provider's usual address; on Edit it is
// never replaced. Nothing is announced (P10(4)).
function selectProvider(next: ModelProvider) {
  if (!isEditing) endpoint = endpointAfterProviderChange(endpoint, provider, next);
  provider = next;
}

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
        onchange={(e) => selectProvider(e.currentTarget.value as ModelProvider)}
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
      <span class="mem-label">Display name (optional)</span>
      <input
        data-testid="model-edit-displayname"
        class="mem-input"
        type="text"
        autocomplete="off"
        bind:value={displayName}
        placeholder={isEditing ? "" : nameFallback(provider)}
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
        aria-disabled={saveInert || saving}
        aria-describedby={saveUnavailable
          ? "model-edit-error-text"
          : saveReason !== null
            ? "model-edit-save-reason"
            : undefined}
      >
        {saving ? "Saving…" : isEditing ? "Save changes" : "Add model"}
      </button>
    </div>
    <!-- Why Save is greyed out (P10(5)). Not a live region: nothing is
         announced as the fields change (P10(4)); Save's description reads it. -->
    {#if saveReason !== null && !saveUnavailable}
      <p id="model-edit-save-reason" class="mem-save-reason" data-testid="model-edit-save-reason">
        {saveReason}
      </p>
    {/if}
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
  .mem-close:hover {
    color: var(--tandem-fg);
    background: var(--tandem-surface-sunk);
  }
  /* A ring, not a colour alone: forced colours erase a colour change
     (#1123, ADR-039 item 27). */
  .mem-close:focus-visible {
    color: var(--tandem-fg);
    background: var(--tandem-surface-sunk);
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
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
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
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
  /* Focusable but inert (`aria-disabled`, never `disabled`): dimmed by colour,
     not opacity, so the focus ring keeps its full strength (as the first-run
     window's Save). */
  .mem-btn--primary[aria-disabled="true"] {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg-muted);
    cursor: not-allowed;
  }
  @media (forced-colors: active) {
    .mem-btn--primary[aria-disabled="true"] {
      color: GrayText;
      border: 1px solid GrayText;
    }
  }
  /* Save's reason, under the buttons and aligned with Save. Muted, never
     `--tandem-fg-subtle` (GrayText in forced colours). */
  .mem-save-reason {
    margin: 0;
    font-size: 12px;
    color: var(--tandem-fg-muted);
    text-align: right;
  }
</style>
