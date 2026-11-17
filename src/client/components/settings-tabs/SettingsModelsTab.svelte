<script lang="ts">
import { onDestroy, onMount } from "svelte";
import type { ChatAnswerer } from "../../../shared/models/contract";
import { MODELS_TAB_ORDER, PROVIDER_LABEL } from "../../../shared/models/provider-ui";
import { createChatAnswerer } from "../../hooks/useChatAnswerer.svelte";
import { licenseStore } from "../../hooks/useLicense.svelte";
import { createLocalModelSettings } from "../../hooks/useLocalModelSettings.svelte";
import { createModels } from "../../hooks/useModels.svelte";
import { createModelsWriteAccess } from "../../hooks/useModelsWriteAccess.svelte";
import { createRadioGroup } from "../../hooks/useRadioGroup.svelte";
import type { ModelProvider, ModelRegistryEntry } from "../../hooks/useTandemSettings.svelte";
import { MCP_BASE_URL } from "../../utils/backend-ports";
import { disabledControlStyle } from "../../utils/colors";
import { LOCAL_REQUEST_LINE, LOCAL_SERVERS_LINE } from "../../utils/local-model-copy";
import LiveRegion from "../LiveRegion.svelte";
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

// Only Tandem's own window can change these settings (#2404). When this page
// is not that — by its own origin, or because the server has refused a write —
// the tab says so ONCE, at the top, and shows every control that would write
// as unavailable instead of failing on each click. A page at
// `http://localhost:<port>` cannot read any `/api` answer at all, so the
// decision is the client's own (`models/own-window.ts`).
//
// Unavailable means `aria-disabled`, never native `disabled`: the controls stay
// in the tab order (a `disabled` control that had focus drops it to the page),
// and each one's handler does nothing.
const access = createModelsWriteAccess();

// Heard, not only seen. A live region announces a CHANGE to a region that is
// already in the accessibility tree; this tab is rebuilt on every tab switch,
// so a region that mounted with its text would be read out by nothing
// (`LiveRegion.svelte`). The region below is mounted empty and its text
// arrives after a real delay — or, when the server's refusal lands while the
// tab is open, with that state change itself.
//
// KNOWN LIMIT, accepted — do not "fix" it by filling the region at once. For
// these 300 ms the element the unavailable controls are described by is empty,
// so a control focused inside that window is announced as unavailable with no
// reason. Filling it at mount removes the delay and, with it, the announcement.
const ANNOUNCE_DELAY_MS = 300;
let announceReady = $state(false);
onMount(() => {
  const timer = setTimeout(() => {
    announceReady = true;
  }, ANNOUNCE_DELAY_MS);
  return () => clearTimeout(timer);
});
const ownWindowAnnouncement = $derived(announceReady && access.blocked ? access.notice : "");

/** For a radio or checkbox: cancel the activation, so the DOM never toggles
 *  and no `change` fires (covers the label, Space and the pointer). */
function refuseWhenBlocked(event: Event) {
  if (access.blocked) event.preventDefault();
}

/** The Default radios. A cancelled activation should put the previously
 *  checked radio back by itself; this does not rely on it, and re-states the
 *  whole group from the store once the event has finished. */
function refuseDefaultWhenBlocked(event: Event) {
  if (!access.blocked) return;
  event.preventDefault();
  const group = (event.currentTarget as HTMLInputElement).name;
  queueMicrotask(() => {
    for (const el of document.getElementsByName(group)) {
      const radio = el as HTMLInputElement;
      radio.checked = radio.value === models.defaultModelId;
    }
  });
}

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
/** A control that writes is unavailable: read-only settings, or not Tandem's
 *  own window. Styling only — the two states disable differently. */
const unavailable = $derived(readOnly || access.blocked);

// Retry and Switch off are replaced or removed by the state change they cause.
// A focused button that unmounts drops keyboard focus to the page, so each
// hands focus to the checkbox first — the one control here that never unmounts.
let editingBox = $state<HTMLInputElement | undefined>(undefined);

function retryEditingRead() {
  editingBox?.focus();
  void localModel.load();
}

function forceEditingOff() {
  if (access.blocked) return;
  editingBox?.focus();
  void localModel.setEditing(false);
}

function syncEditingBox(input: HTMLInputElement) {
  input.checked = editingSettled && localModel.editing;
  input.indeterminate = !editingSettled;
}

async function onEditingChange(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  if (!editingSettled || access.blocked) {
    syncEditingBox(input); // undo the browser's own toggle
    return;
  }
  await localModel.setEditing(input.checked);
  // Svelte skips a `checked` update whose value did not change, so after a
  // save that the server did not take, the DOM would keep the user's click.
  syncEditingBox(input);
}

// --- Who answers your chat (#1123 part B, R2; Decision B1) --------------------
//
// The one place the switch is changed. The store (`useChatAnswerer`) holds
// the editor's read; this section reads it and sends the switch ONLY on the
// user's own selection — a click, or Space/Enter, which a <button> turns into
// a click (so `onclick` alone: a keydown handler too would send twice). Arrow
// keys, Home and End move focus only. Nothing sends on mount, on a read, on a
// models save or on Retry: re-sending "local" upgrades the server's record
// from "told" to "chosen" (#2417), so this is a correctness rule, not a nicety.
//
// Not gated on `readOnly` (R2.9): the switch is a server file, and setting
// chat to Claude must always be possible.
const chatAnswerer = createChatAnswerer();
// R1.2: the tab opening is a trigger. Component init, outside any reaction;
// the store starts its read on a microtask. No-op while dark (the tab is not
// mounted then anyway).
void chatAnswerer.load();
// An outcome line belongs to the press that produced it (R2.4); it is not
// shown again the next time the tab opens.
onDestroy(() => chatAnswerer.clearOutcome());

const ANSWERER_VALUES = ["claude", "local"] as const satisfies readonly ChatAnswerer[];
/** The radio checked: the server's value, only while the read is known. */
const shownAnswerer = $derived<ChatAnswerer | null>(
  chatAnswerer.known ? chatAnswerer.answerer : null,
);
/**
 * Where the roving tab stop and the arrow keys stand. Its own state (R2.2),
 * set only from event handlers (focus, the arrow keys) and cleared when a
 * switch settles, so it falls back to the server's value — never re-synced by
 * an effect, which would move the tab stop off the focused radio on every read.
 * Always one of the two values, so exactly one radio is tabbable even when
 * neither is checked.
 */
let focusOverride = $state<ChatAnswerer | null>(null);
const focusedAnswerer = (): ChatAnswerer => focusOverride ?? shownAnswerer ?? "claude";
// `setValue` moves focus and nothing else (the group focuses the radio after
// it); no `isDisabled`, which would stop the keys moving focus while pending.
const answererRg = createRadioGroup<ChatAnswerer>(focusedAnswerer, ANSWERER_VALUES, (v) => {
  focusOverride = v;
});
/** Selecting is unavailable: not known, a switch pending, or not Tandem's
 *  own window. `aria-disabled`, never `disabled` (focus stays in the group). */
const answererUnavailable = $derived(
  !chatAnswerer.known || chatAnswerer.postPending || access.blocked,
);
let answererGroup = $state<HTMLDivElement | undefined>(undefined);

function focusAnswererRadio(value: ChatAnswerer) {
  const radios = answererGroup?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  radios?.[ANSWERER_VALUES.indexOf(value)]?.focus();
}

async function selectAnswerer(value: ChatAnswerer) {
  // A refused or unreadable page, or one that has not read the switch, sends
  // nothing: it cannot see what it would be changing.
  if (!chatAnswerer.known || chatAnswerer.postPending || access.blocked) return;
  chatAnswerer.clearOutcome();
  if (value === chatAnswerer.answerer) {
    // The position already shown: no POST, but read again.
    void chatAnswerer.load();
    return;
  }
  await chatAnswerer.set(value);
  // R2.3: after any outcome, focus stays on the radio that shows the
  // server's value — only if focus is still in the group now (never steal it
  // from wherever the user tabbed during a slow POST).
  focusOverride = null;
  const hasFocus = answererGroup?.contains(document.activeElement) === true;
  if (hasFocus && chatAnswerer.known) focusAnswererRadio(chatAnswerer.answerer);
}

/** The read is pending, or a retry of a failed read is in flight (R2.5). */
const answererChecking = $derived(
  chatAnswerer.status === "pending" || (chatAnswerer.status === "failed" && chatAnswerer.reading),
);
/** R2.6's line, or "" when it does not apply. */
const setToClaudeDoneLine = $derived(
  !chatAnswerer.known && chatAnswerer.setToClaudeDone ? "Chat was set to Claude." : "",
);

/** "Set chat to Claude" (R2.5, R2.6): offered whenever the page's access is
 *  not foreign and no write refusal has latched. */
const offerSetClaude = $derived(
  !access.blocked && !chatAnswerer.known && chatAnswerer.status !== "unavailable",
);

function focusAnswererGroup() {
  focusAnswererRadio(focusedAnswerer());
}

function retryAnswererRead() {
  focusAnswererGroup();
  void chatAnswerer.load();
}

async function setChatToClaude() {
  if (access.blocked || chatAnswerer.postPending) return;
  // Hand focus to the group first: this button may unmount with the answer.
  focusAnswererGroup();
  chatAnswerer.clearOutcome();
  await chatAnswerer.set("claude");
}

const ANSWERER_UNUSABLE_LINE: Record<string, string> = {
  none: "Chat is set to your local model, but no local model can be used now. Turn on a local model and mark it Default, or set chat to Claude.",
  "no-default-chosen":
    "Chat is set to your local model, but none of your enabled local models is marked Default, so none can be used. Mark one as Default, or set chat to Claude.",
  "endpoint-rejected":
    "Chat is set to your local model, but its Endpoint was not accepted, so it can't be used. Edit the model, or set chat to Claude.",
  "no-endpoint":
    "Chat is set to your local model, but it has no Endpoint saved, so it can't be used. Edit the model, or set chat to Claude.",
};
/** Decision B6's sentence, after every known-local line. */
const LOCAL_NOT_SENT_SENTENCE =
  "While chat is set to your local model, Tandem does not send Claude the chat messages you send, then or later.";

/** R2.8: the one line under the group while the read is known. */
const answererStatusLines = $derived.by<string[]>(() => {
  if (!chatAnswerer.known) return [];
  const lines: string[] = [];
  if (chatAnswerer.answerer === "claude") {
    lines.push("Chat is set to Claude. Local models are not sent your chat.");
  } else {
    const state = chatAnswerer.localModelState;
    lines.push(
      state === "usable"
        ? "Chat is set to your local model."
        : state === "threw"
          ? "Chat is set to your local model. Tandem couldn't check whether it can be used."
          : ANSWERER_UNUSABLE_LINE[state],
    );
    lines.push(LOCAL_NOT_SENT_SENTENCE);
  }
  if (licenseStore.ui.aiOff) {
    lines.push("AI features are off, so chat is not sent to any model. See Settings → License.");
  }
  return lines;
});

const REFUSED_READ_LINE = `This page can't show what chat is set to, because Tandem could not confirm it as Tandem's own window. To see or change it, use the Tandem desktop app, or open Tandem at ${MCP_BASE_URL} in an up-to-date browser.`;

// Anthropic first per the D4 ordering anchor; remaining providers in
// declaration order. Derived from the contract (#1123): `grouped` makes a
// bucket only for a provider in this list, so a hand-written list silently
// stopped listing an entry of any provider it missed.
const PROVIDER_ORDER = MODELS_TAB_ORDER;

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
  if (access.blocked) return;
  editingEntry = undefined;
  modalError = null;
  models.clearError(); // drop a stale list banner so it can't co-show with a modal error
  editorOpen = true;
}

function openEdit(entry: ModelRegistryEntry) {
  if (access.blocked) return;
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
      // Refused because this is not Tandem's own window: the dialog stays
      // open with what was typed, Save goes unavailable, and it says why.
      modalError = access.blocked
        ? access.notice
        : (models.saveError ?? "Failed to save model changes.");
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
  if (access.blocked) return;
  await models.deleteModel(id);
  // Refused because this is not Tandem's own window: keep the pair on screen
  // (Confirm now unavailable, Cancel live) so the focused button does not
  // unmount under the keyboard.
  if (access.blocked) return;
  pendingDeleteId = null;
}

function askDelete(id: string) {
  if (access.blocked) return;
  pendingDeleteId = id;
}
</script>

<!-- Mounted always and empty until there is something to say; see the comment
     on `announceReady`. The visible copy below is hidden from assistive tech so
     the sentence is not read twice. -->
<LiveRegion srOnly message={ownWindowAnnouncement} id="models-own-window-msg" data-testid="models-own-window-live" />
{#if access.blocked}
  <div
    aria-hidden="true"
    data-testid="models-own-window-notice"
    style="margin-bottom: var(--tandem-space-3); padding: var(--tandem-space-2) var(--tandem-space-3); border: 1px solid var(--tandem-warning-border); border-radius: var(--tandem-r-3); background: var(--tandem-warning-bg); color: var(--tandem-warning-fg-strong); font-size: 13px;"
  >
    {access.notice}
  </div>
{/if}

<!-- Who answers your chat (#1123 part B, R2). First in the tab: it is the
     setting the merged notices send the user to ("set who answers your chat
     back to Claude in Settings → Models"). Live-region roles sit on the text
     lines only; R2.8's line is not a live region. -->
<section
  data-testid="chat-answerer-section"
  style="display: flex; flex-direction: column; gap: var(--tandem-space-2); margin-bottom: var(--tandem-space-4); padding-bottom: var(--tandem-space-3); border-bottom: 1px solid var(--tandem-border);"
>
  <div class="settings-section-label" id="chat-answerer-label">Who answers your chat</div>
  <div
    bind:this={answererGroup}
    role="radiogroup"
    aria-labelledby="chat-answerer-label"
    aria-describedby="chat-answerer-description models-own-window-msg"
    aria-disabled={answererUnavailable}
    tabindex="-1"
    onkeydown={answererRg.handleKeyDown}
    onfocusout={(e) => {
      // Focus left the group: the tab stop goes back to the server's value
      // (R2.2: re-synced to the read), from an event handler, never an effect.
      if (!answererGroup?.contains(e.relatedTarget as Node | null)) focusOverride = null;
    }}
    style="display: inline-flex; align-self: flex-start; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); overflow: hidden;"
  >
    {#each [["claude", "Claude"], ["local", "Local model"]] as const as [value, label] (value)}
      {@const checked = shownAnswerer === value}
      <button
        type="button"
        role="radio"
        data-testid={`chat-answerer-${value}`}
        aria-checked={checked}
        aria-disabled={answererUnavailable}
        aria-describedby="chat-answerer-description models-own-window-msg"
        tabindex={answererRg.tabIndexFor(value)}
        onfocus={() => (focusOverride = value)}
        onclick={() => void selectAnswerer(value)}
        style="padding: 4px var(--tandem-space-3); font-size: 13px; border: none; background: {checked
          ? 'var(--tandem-accent)'
          : 'var(--tandem-surface)'}; color: {checked
          ? 'var(--tandem-accent-fg)'
          : 'var(--tandem-fg)'}; cursor: {answererUnavailable
          ? 'not-allowed'
          : 'pointer'}; opacity: {answererUnavailable && !checked ? 0.6 : 1};"
      >
        {label}
      </button>
    {/each}
  </div>
  <div
    id="chat-answerer-description"
    style="display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--tandem-fg-muted);"
  >
    {#if chatAnswerer.known}
      <p data-testid="chat-answerer-status" style="margin: 0;">{answererStatusLines.join(" ")}</p>
    {:else if chatAnswerer.status === "unavailable"}
      <p data-testid="chat-answerer-unavailable" style="margin: 0;">
        Who answers your chat can't be changed with this version of Tandem's server.
      </p>
    {:else if chatAnswerer.status === "refused" || chatAnswerer.status === "unreadable"}
      {#if !access.blocked}
        <p data-testid="chat-answerer-refused" style="margin: 0;">{REFUSED_READ_LINE}</p>
      {/if}
    {:else if chatAnswerer.status === "failed" && !chatAnswerer.reading}
      <div style="display: flex; flex-wrap: wrap; align-items: center; gap: var(--tandem-space-2);">
        <span role="alert" data-testid="chat-answerer-load-error">Couldn't read what chat is set to.</span>
        <button
          type="button"
          data-testid="chat-answerer-retry"
          onclick={retryAnswererRead}
          style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); cursor: pointer;"
        >
          Retry
        </button>
      </div>
    {/if}
    <!-- "Checking…" and R2.6's line: LiveRegion's announcer shape, because this
         column is a gapped flex parent (an empty host would sit in it as dead
         space). Each announcer is mounted for good and out of flow, so a
         sentence's arrival is a mutation a screen reader announces; the
         visible copy exists only while there is a sentence, aria-hidden so it
         is not read twice. -->
    <!-- "Checking…" is usually already true when the tab opens, so the
         announcer takes it only after `announceReady` (the same real yield as
         the own-window announcer above): created empty, it then receives the
         sentence as a mutation instead of being inserted holding it. The
         same accepted limit as above: for those 300 ms the radios'
         description (#chat-answerer-description) lacks "Checking…" (the
         visible copy is aria-hidden); do not fill the region at mount. -->
    <LiveRegion srOnly message={announceReady && answererChecking ? "Checking…" : ""} data-testid="chat-answerer-loading" />
    {#if answererChecking}
      <p aria-hidden="true" style="margin: 0;">Checking…</p>
    {/if}
    <LiveRegion srOnly message={setToClaudeDoneLine} data-testid="chat-answerer-set-claude-done" />
    {#if setToClaudeDoneLine}
      <p aria-hidden="true" style="margin: 0;">{setToClaudeDoneLine}</p>
    {/if}
    {#if offerSetClaude}
      <button
        type="button"
        data-testid="chat-answerer-use-claude"
        onclick={() => void setChatToClaude()}
        style="align-self: flex-start; padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); cursor: pointer;"
      >
        Set chat to Claude
      </button>
    {/if}
  </div>
  {#if chatAnswerer.outcomeLine && !access.blocked}
    <div
      role="alert"
      data-testid="chat-answerer-error"
      style="padding: var(--tandem-space-2) var(--tandem-space-3); border: 1px solid var(--tandem-error-border); border-radius: var(--tandem-r-3); background: var(--tandem-error-bg); color: var(--tandem-error-fg-strong); font-size: 12px;"
    >
      {chatAnswerer.outcomeLine}
    </div>
  {/if}
</section>

<!-- #1123 R4 (S1, S2): what a local model can be and what Tandem sends it.
     Outside the list-state branch below, so it shows in all five states. -->
<div
  data-testid="models-local-intro"
  style="display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--tandem-space-3); font-size: 12px; color: var(--tandem-fg-muted);"
>
  <p style="margin: 0;">{LOCAL_SERVERS_LINE}</p>
  <p style="margin: 0;">{LOCAL_REQUEST_LINE}</p>
</div>

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
  {:else if models.loadFailed && access.foreign}
    <!-- A page that is plainly not Tandem's own (`http://localhost:<port>` can
         read nothing from the server) AND the read failed: the notice above is
         the whole explanation. No alert and no Retry — a Retry here could never
         succeed. (A development page that was merely refused a write can still
         read, so it keeps the ordinary load error and its Retry below.) This branch is still TAKEN, so the list never
         falls through to "No models configured". -->
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
        aria-disabled={access.blocked}
        aria-describedby="models-own-window-msg"
        onclick={openAdd}
        style="padding: 6px var(--tandem-space-3); font-size: 13px; font-weight: 500; border: none; border-radius: var(--tandem-r-2); {disabledControlStyle(unavailable)} background: var(--tandem-accent); color: var(--tandem-accent-fg);"
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
                      value={entry.id}
                      checked={models.defaultModelId === entry.id}
                      disabled={readOnly}
                      aria-disabled={access.blocked}
                      aria-describedby="models-own-window-msg"
                      onclick={refuseDefaultWhenBlocked}
                      onchange={() => {
                        if (!access.blocked) void models.setDefault(entry.id);
                      }}
                      style="accent-color: var(--tandem-accent); {disabledControlStyle(unavailable)}"
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
                      aria-disabled={access.blocked}
                      aria-describedby="models-own-window-msg"
                      onclick={refuseWhenBlocked}
                      onchange={() => {
                        if (!access.blocked) void models.toggleEnabled(entry.id);
                      }}
                      style="accent-color: var(--tandem-accent); {disabledControlStyle(unavailable)}"
                    />
                    <span>{entry.enabled ? "On" : "Off"}</span>
                  </label>
                  <button
                    type="button"
                    data-testid={`model-edit-btn-${entry.id}`}
                    disabled={readOnly}
                    aria-disabled={access.blocked}
                    aria-describedby="models-own-window-msg"
                    onclick={() => openEdit(entry)}
                    style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); {disabledControlStyle(unavailable)}"
                  >
                    Edit
                  </button>
                  {#if pendingDeleteId === entry.id}
                    <button
                      type="button"
                      data-testid={`model-delete-confirm-${entry.id}`}
                      disabled={readOnly}
                      aria-disabled={access.blocked}
                      aria-describedby="models-own-window-msg"
                      onclick={() => confirmDelete(entry.id)}
                      style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-error-border); border-radius: var(--tandem-r-2); background: var(--tandem-error-bg); color: var(--tandem-error-fg-strong); {disabledControlStyle(unavailable)}"
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
                      aria-disabled={access.blocked}
                      aria-describedby="models-own-window-msg"
                      onclick={() => askDelete(entry.id)}
                      style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-error-fg-strong); {disabledControlStyle(unavailable)}"
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
      aria-disabled={access.blocked}
      aria-describedby="models-own-window-msg"
      onclick={openAdd}
      style="align-self: flex-start; padding: 6px var(--tandem-space-3); font-size: 13px; font-weight: 500; border: 1px solid var(--tandem-accent-border); border-radius: var(--tandem-r-2); {disabledControlStyle(unavailable)} background: var(--tandem-surface); color: var(--tandem-accent);"
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
      aria-disabled={!editingSettled || access.blocked}
      aria-describedby="local-model-editing-help models-own-window-msg"
      onchange={onEditingChange}
      style="margin-top: 2px; accent-color: var(--tandem-accent); cursor: {editingSettled &&
      !access.blocked
        ? 'pointer'
        : 'not-allowed'}; opacity: {access.blocked ? 0.5 : 1};"
    />
    <span>Let local models comment and suggest changes</span>
  </label>
  {#if !editingSettled && !access.foreign}
    <!-- (Not shown on a page that can read nothing from the server, #2404: a
         Retry there could never succeed. On a page that was merely refused a
         write, the read error and its Retry stay — reads still work — but
         neither Switch off is offered: Off follows the same rule as On.)
         The server's value is not known (still reading, or the read failed), so
         the box above is indeterminate and inert. Switch off is offered in both
         cases: a read that hangs or fails must not be the reason commenting
         cannot be turned off. Live-region roles sit on the TEXT only.
         Known limit: "Checking…" mounts with its text already inside its
         `role="status"` element, and some screen readers announce a live
         region only when its content changes after it exists. -->
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
        {#if !access.blocked}
          <button
            type="button"
            data-testid="local-model-editing-force-off"
            onclick={forceEditingOff}
            style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); cursor: pointer;"
          >
            Switch off
          </button>
        {/if}
      {:else}
        <span role="status" data-testid="local-model-editing-loading">Checking…</span>
        {#if !access.blocked}
          <button
            type="button"
            data-testid="local-model-editing-force-off-pending"
            onclick={forceEditingOff}
            style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg); cursor: pointer;"
          >
            Switch off
          </button>
        {/if}
      {/if}
    </div>
  {/if}
  <p
    id="local-model-editing-help"
    style="margin: 0; font-size: 12px; color: var(--tandem-fg-muted);"
  >
    Experimental — review every suggestion. This applies only while chat is set to your local
    model; while chat is set to Claude, local models are sent nothing. When this is on, your
    local model can add comments and suggest replacements, except in Solo mode, where it replies
    in chat only. When it is off, it can read your document and reply in chat only. A change here
    applies from your next message; switching it off also stops a reply that is already running
    from adding more.
  </p>
  {#if localModel.saveNotice && !access.blocked}
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
{#if models.saveError && !editorOpen && !models.loadFailed && !access.blocked}
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
    error={modalError ?? (access.blocked ? access.notice : null)}
    saveUnavailable={access.blocked}
    onCancel={closeModal}
    onSave={handleSave}
  />
{/if}
