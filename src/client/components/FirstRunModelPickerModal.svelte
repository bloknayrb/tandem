<script lang="ts">
/**
 * The first-run window, "Add a local model (optional)" (#1123, ADR-039 items
 * 21–23): pick a local provider, name the model and save it. The window
 * makes no default itself: with no default set and this the only enabled
 * local model, the Models store marks it as the default inside the add's own
 * write (the automatic default, Label decision L6 of 2026-11-17). The
 * caller's `onComplete` fires on save or on any close.
 *
 * Mounted by `App.svelte` behind `modelPickerOpen` (offered once, when the
 * integration wizard closes after Claude was set up in it), which is gated on
 * `BYO_MODELS_ENABLED` — so this stays DARK (never mounts) until the flag flips.
 *
 * Only local providers are listed (P4); the cloud branch below stays in source
 * (its `data-testid`s are a contract) but is unreachable.
 */
import { onDestroy, tick, untrack } from "svelte";
import { isLocalProvider, type ModelProvider } from "../../shared/models/contract.js";
import {
  endpointPrefill,
  PROVIDER_LABEL,
  PROVIDER_OPTION_ORDER,
} from "../../shared/models/provider-ui.js";
import { createModels } from "../hooks/useModels.svelte.js";
import { createModelsWriteAccess } from "../hooks/useModelsWriteAccess.svelte";
import { trapTab } from "../utils/focus-trap.js";
import {
  endpointHint,
  PICKER_LOCAL_SUBTITLE,
  PICKER_MODEL_ID_HINT,
  PICKER_TITLE,
  pickerSaveReason,
} from "../utils/local-model-copy.js";

interface Props {
  /** Fires after Save (success) or Skip. Caller should advance its state. */
  onComplete: () => void;
}

const { onComplete }: Props = $props();

const models = createModels();
// Once the server has refused a save from this page (#2404: only Tandem's own
// window can change these settings), Save stays focusable but does nothing;
// the refusal's own sentence is already in `saveError`. Skip stays live.
const access = createModelsWriteAccess();

interface ProviderOption {
  value: ModelProvider;
  label: string;
  /** Display name placeholder, and the name a blank Display name saves as. */
  nameFallback: string;
}

// Picker-only per-provider data. `Record`s, so a provider added to the
// contract is a type error here until it has a row. The cloud labels keep
// their brand hint; the local ones are the Models tab's.
const PICKER_LABEL: Record<ModelProvider, string> = {
  ...PROVIDER_LABEL,
  anthropic: "Anthropic (Claude)",
  gemini: "Gemini (Google)",
};
// #1123 Ruling L-h: Other's long label is not a name; it saves as "Local server".
const NAME_FALLBACK: Record<ModelProvider, string> = {
  ...PICKER_LABEL,
  "local-other": "Local server",
};

// Option data for every provider, in the contract's order. Only the local ones
// are listed (`LISTED_OPTIONS`, P4: no cloud row until cloud keys work); the
// cloud/local split is the contract's `isLocalProvider`. No model id is
// prefilled for any provider (V8): the field starts empty, with a hint.
const PROVIDER_OPTIONS: ProviderOption[] = PROVIDER_OPTION_ORDER.map((value) => ({
  value,
  label: PICKER_LABEL[value],
  nameFallback: NAME_FALLBACK[value],
}));
const LISTED_OPTIONS = PROVIDER_OPTIONS.filter((o) => isLocalProvider(o.value));

let provider = $state<ModelProvider>("local-ollama");
let displayName = $state("");
let modelId = $state("");
let apiKey = $state("");
let endpoint = $state(endpointPrefill("local-ollama"));
let saving = $state(false);
let saveError = $state<string | null>(null);
// Save can be unavailable before anything was tried here: the one-time
// reconcile at boot may already have been refused (a development page with
// models in browser storage and no allowance). An inert Save with no words is
// the thing to avoid, so the reason is shown whenever the page is blocked and
// no other error is on screen.
const shownError = $derived(saveError ?? (access.blocked ? access.notice : null));
// Set when the window has closed (any exit, a finished save, or unmount). A save
// still in flight then leaves no error on the shared store and does not
// complete twice (R2.4). It cannot stop the default: that rides in the add's
// own write (CD-2). Plain, not `$state`: nothing renders from it.
let closed = false;
onDestroy(() => {
  closed = true;
});
let dialogEl: HTMLElement | null = $state(null);
let saveEl: HTMLButtonElement | null = $state(null);
let prevFocus: Element | null = null;

const currentProvider = $derived(
  PROVIDER_OPTIONS.find((p) => p.value === provider) ?? PROVIDER_OPTIONS[0],
);
const isCloud = $derived(!isLocalProvider(provider));

// Why Save cannot save yet (V14), or null. `canSave` is derived from it, so the
// visible reason and Save's state never disagree. The cloud test stays for the
// unreachable cloud branch.
const saveReason = $derived(isCloud ? null : pickerSaveReason({ endpoint, modelId }));
const canSave = $derived(
  isCloud ? modelId.trim().length > 0 && apiKey.trim().length > 0 : saveReason === null,
);
/** Save is focusable but does nothing: refused page, or a field missing. */
const saveInert = $derived(access.blocked || !canSave);

$effect(() => {
  const el = untrack(() => dialogEl);
  if (!el) return;
  prevFocus = document.activeElement;
  el.focus();
  return () => {
    if (prevFocus instanceof HTMLElement && document.contains(prevFocus)) prevFocus.focus();
  };
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

function selectProvider(next: ModelProvider) {
  // The Model ID is never touched: no provider fills it (V8), and a typed one
  // is kept.
  // #1123 R2.3: the same rule for the address, by string equality only — the
  // field is replaced only while it still holds the previous provider's
  // prefill ("" for a provider with none). Read before `provider` changes.
  if (endpoint === endpointPrefill(provider)) {
    endpoint = endpointPrefill(next);
  }
  provider = next;
}

/** Every exit and a finished save end here: the window is closed for good. */
function finish() {
  closed = true;
  onComplete();
}

async function handleSave(e: SubmitEvent) {
  e.preventDefault();
  if (!canSave || saving || access.blocked) return;
  saving = true;
  saveError = null;
  // Save is natively disabled while saving, and a browser moves focus off a
  // disabled control to <body>, where the dialog's Escape no longer reaches.
  // Keep focus in the dialog so the exits stay live from the keyboard (R2.4);
  // a failed save then puts it on Save below, whichever control submitted
  // (CD-7: Enter from a field included).
  const parkedFocus =
    dialogEl !== null &&
    dialogEl.contains(document.activeElement) &&
    document.activeElement !== dialogEl;
  if (parkedFocus) dialogEl?.focus();
  try {
    const id = await models.addModel(
      {
        provider,
        displayName: displayName.trim() || currentProvider.nameFallback,
        modelId: modelId.trim(),
        enabled: true,
        ...(isCloud ? {} : { endpoint: endpoint.trim() }),
      },
      isCloud ? apiKey.trim() : undefined,
    );
    // Closed while the add was in flight (R2.4): the model is saved if the add
    // committed, and not otherwise (and made the default exactly when its own
    // write marked it, CD-2); a rollback's error is not left on the store for
    // Settings → Models.
    if (closed) {
      models.clearError();
      return;
    }
    // `addModel` returns null when the write did NOT commit (rolled back /
    // reconciled away): keep the window open and surface the store's error.
    if (id === null) {
      // Refused as not Tandem's own window: one sentence for that state,
      // the same one this dialog shows when it opens already blocked.
      saveError = access.blocked
        ? access.notice
        : (models.saveError ?? "Failed to save model changes.");
      return;
    }
    // The model committed, and with it the default when the store's rule
    // marked one in the same write: there is no second write to fail.
    finish();
  } catch (err) {
    if (closed) {
      models.clearError();
      return;
    }
    saveError = err instanceof Error ? err.message : "Failed to save";
  } finally {
    saving = false;
    // A failed save leaves the window open with the reason shown: move focus
    // to Save (enabled again after this render) if it is still parked on the
    // dialog, whichever control submitted — after Enter from a field that is
    // Save, not the field (CD-7). In `finally`, because the failure branches
    // `return` out of the `try`.
    if (parkedFocus && !closed && saveError !== null && document.activeElement === dialogEl) {
      await tick();
      saveEl?.focus();
    }
  }
}

function handleSkip() {
  // Drop any error left on the shared store singleton (e.g. a rolled-back add)
  // so it can't co-show on the next Settings → Models open.
  models.clearError();
  finish();
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
    aria-labelledby="first-run-title"
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
        <h2 id="first-run-title" class="frm-title">{PICKER_TITLE}</h2>
        <div class="frm-step" data-testid="first-run-subtitle">{PICKER_LOCAL_SUBTITLE}</div>
      </div>
      <button
        type="button"
        class="frm-close"
        onclick={handleSkip}
        data-testid="first-run-skip"
        aria-label="Close"
      >
        ×
      </button>
    </header>

    <form onsubmit={handleSave} class="frm-form">
      <fieldset class="frm-providers" data-testid="first-run-providers">
        <legend class="frm-label">Provider</legend>
        {#each LISTED_OPTIONS as opt (opt.value)}
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
          placeholder={currentProvider.nameFallback}
          autocomplete="off"
        />
      </label>

      <!-- The hint sits OUTSIDE the label, linked by aria-describedby, so the
           field's accessible name stays "Model ID" (V8: it names no model). -->
      <div class="frm-field">
        <label class="frm-field">
          <span class="frm-label">Model ID</span>
          <input
            type="text"
            data-testid="first-run-modelid"
            bind:value={modelId}
            autocomplete="off"
            class="frm-mono"
            aria-describedby="first-run-modelid-hint"
          />
        </label>
        <p id="first-run-modelid-hint" class="frm-hint" data-testid="first-run-modelid-hint">
          {PICKER_MODEL_ID_HINT}
        </p>
      </div>

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
        <!-- The hint sits OUTSIDE the label, linked by aria-describedby, so the
             field's accessible name stays "Endpoint URL". -->
        <div class="frm-field">
          <label class="frm-field">
            <span class="frm-label">Endpoint URL</span>
            <input
              type="text"
              data-testid="first-run-endpoint"
              bind:value={endpoint}
              autocomplete="off"
              class="frm-mono"
              aria-describedby="first-run-endpoint-hint"
            />
          </label>
          <p id="first-run-endpoint-hint" class="frm-hint" data-testid="first-run-endpoint-hint">
            {endpointHint(endpointPrefill(provider))}
          </p>
        </div>
      {/if}

      {#if shownError}
        <div role="alert" id="first-run-error-text" class="frm-error" data-testid="first-run-error">
          {shownError}
        </div>
      {/if}

      <div class="frm-actions">
        <button
          type="button"
          onclick={handleSkip}
          data-testid="first-run-skip-secondary"
          class="frm-btn frm-btn-secondary"
        >
          No thanks
        </button>
        <!-- V14: while Save cannot save it stays focusable (aria-disabled) and
             is described by the reason; the own-window refusal, when shown,
             wins. Natively disabled only while a save is in flight. -->
        <button
          type="submit"
          bind:this={saveEl}
          disabled={saving}
          aria-disabled={saveInert}
          aria-describedby={access.blocked
            ? "first-run-error-text"
            : saveReason !== null
              ? "first-run-save-reason"
              : undefined}
          data-testid="first-run-save"
          class="frm-btn frm-btn-primary"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {#if saveReason !== null && !access.blocked}
        <p id="first-run-save-reason" class="frm-hint frm-save-reason" data-testid="first-run-save-reason">
          {saveReason}
        </p>
      {/if}
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
.frm-hint {
  margin: 0;
  font-size: 11px;
  color: var(--tandem-fg-muted);
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
/* Focusable but inert (V14): dimmed by colour, not opacity, so the focus ring
   keeps its full strength. */
.frm-btn-primary[aria-disabled="true"]:not(:disabled) {
  background: var(--tandem-surface-sunk);
  color: var(--tandem-fg-muted);
  cursor: not-allowed;
}
/* Save's reason sits under the buttons, aligned with Save. */
.frm-save-reason {
  text-align: right;
}
</style>
