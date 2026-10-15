<script lang="ts">
/**
 * "Tandem's Claude" in Settings → AI Assistant (#2195): how Tandem's own
 * background Claude starts, and how long it runs.
 *
 * Four rules this component exists to keep:
 *   - **Partial saves.** Each control sends only its own field. A whole-object
 *     save from a stale view (a second window, this tab opened before the chat
 *     panel's Turn off) would put back a start mode the user had just changed.
 *   - **Controls stay disabled until a valid read.** A failed or malformed
 *     load must not render the defaults as if they were the saved choice — the
 *     first click would then write `auto` over a saved `off`.
 *   - **Saves are explicit `onchange`s, serialized.** No `$effect` over bound
 *     state (the load's own write would POST), and one request at a time:
 *     `saveLauncherSettings` shares the launcher claim with every other
 *     launcher action, because the nonce is single-use and global. The controls
 *     re-render from what the server stored, and roll back to it on failure.
 *   - **The server's message is never rendered.** Fixed strings per `code`,
 *     the same invariant as the working-directory section beside this one.
 */
import { onDestroy } from "svelte";
import { API_LAUNCHER_SETTINGS } from "../../../shared/api-paths";
import {
  isLauncherIdleMinutes,
  LAUNCHER_ERROR_IN_PROGRESS,
  LAUNCHER_ERROR_INVALID_NONCE,
  LAUNCHER_ERROR_OFF_NOT_SAVED,
  LAUNCHER_ERROR_SETTINGS_NEWER,
  LAUNCHER_IDLE_MINUTES_MAX,
  LAUNCHER_IDLE_MINUTES_MIN,
  type LauncherLifetime,
  type LauncherSettings,
  type LauncherSettingsPatch,
  type LauncherStartMode,
  parseLauncherSettings,
} from "../../../shared/launcher/contract";
import {
  fetchLauncherStatus,
  OFF_NOT_SAVED_MESSAGE,
  saveLauncherSettings,
} from "../../actions/builtin.svelte.js";
import { API_BASE } from "../../utils/fileUpload";

interface Props {
  /** The setup wizard's v1.0 walkthrough (#2198): the start choice alone,
   * with its own copy. Lifetime and idle stay in Settings. */
  startModeOnly?: boolean;
  /** Told when a save starts and when the last one settles, so a host can
   * hold an action that must read the saved mode (the wizard's Connect and
   * Keep, which ask the launcher to start under it). */
  onBusyChange?: (busy: boolean) => void;
}

let { startModeOnly = false, onBusyChange }: Props = $props();

const START_MODES: Array<{ value: LauncherStartMode; label: string; hint: string }> = [
  {
    value: "auto",
    label: "Start automatically",
    hint: "Tandem starts its Claude when Tandem starts.",
  },
  {
    value: "on-click",
    label: "Wait until I click Start",
    hint: "Start it from the status bar or the chat panel when you want it.",
  },
  {
    value: "off",
    label: "Off",
    hint: "Tandem doesn't run its own Claude. Choosing Off stops it now.",
  },
];

const LIFETIMES: Array<{ value: LauncherLifetime; label: string }> = [
  { value: "always", label: "Keep it running in the background" },
  { value: "idle", label: "Stop it when it has been idle" },
];

const LOAD_ERROR = "Couldn't load these settings.";

let settings = $state<LauncherSettings | null>(null);
let readOnly = $state(false);
/** The file could not be read: the controls show what Tandem is doing
 * (waiting for Start), and the first save rewrites the file. */
let unreadable = $state(false);
let keptLastGood = $state(false);
let loadError = $state<string | null>(null);
let saveError = $state<string | null>(null);
/** The launcher will not run here at all (stdio, or switched off by the
 * operator), so these settings change nothing until it does. */
let launcherAbsent = $state(false);
/** The idle-minutes field's own text, so an invalid entry can be shown and
 * corrected without being saved. */
let idleText = $state("");
let idleError = $state<string | null>(null);

let mounted = true;
onDestroy(() => {
  mounted = false;
  // A save cut short by an unmount must not leave the host held busy.
  onBusyChange?.(false);
});

let saving = false;
/** Patches waiting behind the save in flight, merged — latest value wins. */
let queued: LauncherSettingsPatch | null = null;

function errorForCode(code: string | undefined): string {
  switch (code) {
    case LAUNCHER_ERROR_OFF_NOT_SAVED:
      return OFF_NOT_SAVED_MESSAGE;
    case LAUNCHER_ERROR_SETTINGS_NEWER:
      return "These settings were saved by a newer version of Tandem. Update Tandem to change them.";
    case LAUNCHER_ERROR_IN_PROGRESS:
      return "Another Claude action is still running. Try again in a moment.";
    case LAUNCHER_ERROR_INVALID_NONCE:
      return "Couldn't save — another launcher action got there first. Try again.";
    default:
      return "Couldn't save this setting.";
  }
}

/** Render what the server stored. `idleText` is left alone unless the minutes
 * changed, so a value the user is still typing is not wiped by an unrelated
 * save landing. */
function show(next: LauncherSettings): void {
  if (settings === null || next.idleMinutes !== settings.idleMinutes) {
    idleText = String(next.idleMinutes);
  }
  settings = next;
}

/** Read the stored settings. Also the rollback after a failed save. */
async function loadSettings(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}${API_LAUNCHER_SETTINGS}`);
    const body = res.ok
      ? ((await res.json().catch(() => null)) as {
          settings?: unknown;
          readOnly?: unknown;
          unreadable?: unknown;
          keptLastGood?: unknown;
        } | null)
      : null;
    if (!mounted) return;
    const parsed = parseLauncherSettings(body?.settings);
    if (parsed === null) {
      loadError = LOAD_ERROR;
      return;
    }
    loadError = null;
    show(parsed);
    readOnly = body?.readOnly === true;
    unreadable = body?.unreadable === true;
    keptLastGood = unreadable && body?.keptLastGood === true;
  } catch {
    if (mounted) loadError = LOAD_ERROR;
  }
}

async function checkLauncherPresent(): Promise<void> {
  const status = await fetchLauncherStatus();
  if (!mounted || !status.ok || status.value.available) return;
  launcherAbsent =
    status.value.reason === "stdio-mode" || status.value.reason === "disabled-by-env";
}

void Promise.all([loadSettings(), checkLauncherPresent()]);

async function save(patch: LauncherSettingsPatch): Promise<void> {
  if (saving) {
    queued = { ...queued, ...patch };
    return;
  }
  saving = true;
  onBusyChange?.(true);
  saveError = null;
  let startModeChanged = false;
  let next: LauncherSettingsPatch | null = patch;
  while (next !== null) {
    const result = await saveLauncherSettings(next);
    if (!mounted) return;
    if (!result.ok) {
      saveError = errorForCode(result.code);
      queued = null;
      saving = false;
      onBusyChange?.(false);
      // Claude did stop, so the status bar and chat panel must re-read.
      if (result.code === LAUNCHER_ERROR_OFF_NOT_SAVED) {
        window.dispatchEvent(new CustomEvent("tandem:launcher-changed"));
      }
      // Roll the controls back to what is stored, read fresh rather than
      // trusting the pre-click copy.
      await loadSettings();
      return;
    }
    if (next.startMode !== undefined) startModeChanged = true;
    next = queued;
    queued = null;
    // Shown only once nothing is queued behind it: rendering an intermediate
    // answer would snap a control the user changed meanwhile back until its
    // own save landed.
    if (next === null) show(result.settings);
  }
  saving = false;
  onBusyChange?.(false);
  unreadable = false;
  // Only the start mode changes what the status bar and chat panel show
  // (choosing Off stops Claude), so only it asks them to re-read.
  if (startModeChanged) window.dispatchEvent(new CustomEvent("tandem:launcher-changed"));
}

/** Show a change at once, then save that field alone. */
function apply(patch: LauncherSettingsPatch): void {
  if (settings === null) return;
  const next = { ...settings, ...patch };
  if (
    next.startMode === settings.startMode &&
    next.lifetime === settings.lifetime &&
    next.idleMinutes === settings.idleMinutes
  ) {
    return;
  }
  settings = next;
  void save(patch);
}

function commitIdleMinutes(): void {
  const value = Number(idleText.trim());
  if (idleText.trim() === "" || !isLauncherIdleMinutes(value)) {
    idleError = `Enter a whole number of minutes from ${LAUNCHER_IDLE_MINUTES_MIN} to ${LAUNCHER_IDLE_MINUTES_MAX}.`;
    return;
  }
  idleError = null;
  apply({ idleMinutes: value });
}

const controlsDisabled = $derived(settings === null || readOnly);
</script>

<div class="tc-section" data-testid="settings-modal-tandem-claude">
  <div class="settings-section-label">Tandem's Claude</div>
  <div class="settings-hint" data-testid="settings-modal-tandem-claude-disclosure">
    Tandem's Claude is a Claude Code session that Tandem runs in the background, so it can answer
    your chat and comments.
    {#if startModeOnly}
      Choose when it starts. How long it runs, and this choice too, can be changed any time in
      Settings → AI Assistant.
    {:else}
      Once started, it keeps running in the background until Tandem itself stops, you turn it off,
      or — if you choose below — it has been idle for a while. An idle stop keeps its conversation:
      starting it again picks up where it left off.
    {/if}
  </div>

  {#if loadError}
    <div role="alert" class="tc-error" data-testid="settings-modal-tandem-claude-load-error">
      {loadError}
    </div>
  {/if}
  {#if readOnly}
    <div class="settings-hint" data-testid="settings-modal-tandem-claude-readonly">
      These settings were saved by a newer version of Tandem, so they can't be changed here.
    </div>
  {/if}
  {#if unreadable}
    <div class="settings-hint" data-testid="settings-modal-tandem-claude-unreadable">
      {#if keptLastGood}
        Tandem couldn't read its saved settings for its Claude, so it is keeping the ones it last
        read, shown here. Choosing a setting here saves a fresh copy.
      {:else}
        Tandem couldn't read its saved settings for its Claude, so it is waiting for you to click
        Start. Choosing a setting here saves a fresh copy.
      {/if}
    </div>
  {/if}
  {#if launcherAbsent}
    <div class="settings-hint" data-testid="settings-modal-tandem-claude-absent">
      Tandem isn't running its own Claude in this setup, so these settings have no effect right now.
    </div>
  {/if}

  <fieldset class="tc-fieldset" disabled={controlsDisabled}>
    <legend class="settings-hint tc-legend">When should it start?</legend>
    {#each START_MODES as mode (mode.value)}
      <label class="tc-option">
        <input
          type="radio"
          name="tandem-claude-start-mode"
          value={mode.value}
          checked={settings?.startMode === mode.value}
          onchange={() => apply({ startMode: mode.value })}
          data-testid="settings-modal-tandem-claude-start-{mode.value}"
        />
        <span>
          {mode.label}
          <span class="tc-option-hint">{mode.hint}</span>
        </span>
      </label>
    {/each}
  </fieldset>

  {#if !startModeOnly}
  <fieldset class="tc-fieldset" disabled={controlsDisabled}>
    <legend class="settings-hint tc-legend">How long should it run?</legend>
    {#each LIFETIMES as lifetime (lifetime.value)}
      <label class="tc-option">
        <input
          type="radio"
          name="tandem-claude-lifetime"
          value={lifetime.value}
          checked={settings?.lifetime === lifetime.value}
          onchange={() => apply({ lifetime: lifetime.value })}
          data-testid="settings-modal-tandem-claude-lifetime-{lifetime.value}"
        />
        <span>{lifetime.label}</span>
      </label>
    {/each}
    <div class="tc-option tc-indented">
      <label for="tandem-claude-idle-minutes">Idle for</label>
      <input
        id="tandem-claude-idle-minutes"
        class="tc-minutes"
        type="number"
        min={LAUNCHER_IDLE_MINUTES_MIN}
        max={LAUNCHER_IDLE_MINUTES_MAX}
        step="1"
        value={idleText}
        oninput={(e) => {
          idleText = e.currentTarget.value;
        }}
        onchange={commitIdleMinutes}
        disabled={settings?.lifetime !== "idle"}
        aria-describedby="tandem-claude-idle-hint"
        aria-invalid={idleError !== null}
        data-testid="settings-modal-tandem-claude-idle-minutes"
      />
      <span>minutes</span>
    </div>
    <div id="tandem-claude-idle-hint" class="settings-hint tc-indented">
      {settings?.lifetime === "idle"
        ? "Counted from the end of its last turn. It never stops in the middle of one."
        : "Only used when “Stop it when it has been idle” is chosen."}
    </div>
    {#if idleError}
      <div
        role="alert"
        class="tc-error tc-indented"
        data-testid="settings-modal-tandem-claude-idle-error"
      >
        {idleError}
      </div>
    {/if}
  </fieldset>
  {/if}

  {#if saveError}
    <div role="alert" class="tc-error" data-testid="settings-modal-tandem-claude-save-error">
      {saveError}
    </div>
  {/if}
</div>

<style>
  .tc-section {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-2);
  }
  .tc-fieldset {
    border: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-1);
  }
  .tc-legend {
    padding: 0;
    margin-bottom: var(--tandem-space-1);
  }
  .tc-option {
    display: flex;
    align-items: flex-start;
    gap: var(--tandem-space-2);
    font-size: 12px;
    cursor: pointer;
  }
  .tc-option-hint {
    display: block;
    color: var(--tandem-fg-muted);
    font-size: 11px;
  }
  .tc-indented {
    padding-left: var(--tandem-space-5);
    align-items: center;
  }
  .tc-minutes {
    width: 5em;
    font-size: 12px;
    padding: var(--tandem-space-1) var(--tandem-space-2);
    border-radius: var(--tandem-r-2);
    border: 1px solid var(--tandem-border);
    background: var(--tandem-surface);
    color: var(--tandem-fg);
  }
  .tc-error {
    font-size: 11px;
    color: var(--tandem-error-fg-strong);
  }
</style>
