<script lang="ts">
import {
  buildOverrides,
  chordFromEvent,
  effectiveChord,
  findConflict,
  formatChord,
  REGISTRY_TO_SHORTCUT_ID,
  REMAPPABLE_LABELS,
  REMAPPABLE_SHORTCUT_IDS,
  type RemappableShortcutId,
} from "../actions/keybindings.js";
import { ACTION_GROUPS, getActionsMap } from "../actions/registry.svelte.js";
import { STATIC_SHORTCUT_ROWS } from "../actions/static-shortcuts.js";
import type { TandemSettings } from "../hooks/useTandemSettings.svelte.js";

interface Props {
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
  notify?: (severity: "info" | "warning" | "error", message: string) => void;
}

// Destructure directly off $props() so each stays a live getter (capturing
// into a local then re-destructuring freezes the getters — see SettingsModal
// gotcha). `notify` is optional with a noop default because the popover
// surface has no toast channel; conflict feedback is shown inline regardless.
let { settings, onUpdate, notify = () => {} }: Props = $props();

let recordingId = $state<RemappableShortcutId | null>(null);
let conflictError = $state<{ id: RemappableShortcutId; message: string } | null>(null);

const readOnly = $derived(settings._readOnly === true);
const overrides = $derived(buildOverrides(settings.customShortcuts));

// Recording listener lives in an $effect gated on `recordingId` (NOT an
// imperative add/remove) so it auto-cleans on recordingId change AND on
// unmount. The modal remounts the tab body via {#key activeTab.id}; an
// imperatively-leaked capture-phase listener would swallow keystrokes
// app-wide after a tab switch.
$effect(() => {
  if (recordingId === null) return;
  const id = recordingId;
  const onKey = (e: KeyboardEvent) => {
    // preventDefault so combos like Ctrl+W / Ctrl+N are recordable rather than
    // triggering their (still-active) default action; stopPropagation so the
    // App-level keydown handler doesn't also fire mid-recording.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      recordingId = null;
      conflictError = null;
      return;
    }
    const chord = chordFromEvent(e);
    if (!chord) return; // pure modifier / un-bindable — keep waiting
    const conflict = findConflict(chord, overrides, id);
    if (conflict) {
      conflictError = { id, message: `Already used by ${conflict}` };
      return; // stay recording so the user can try another combo
    }
    recordingId = null;
    conflictError = null;
    onUpdate({ customShortcuts: { ...settings.customShortcuts, [id]: chord } });
    notify("info", `${REMAPPABLE_LABELS[id]} set to ${formatChord(chord)}`);
  };
  window.addEventListener("keydown", onKey, { capture: true });
  return () => window.removeEventListener("keydown", onKey, { capture: true });
});

function startRecording(id: RemappableShortcutId) {
  if (readOnly) return;
  conflictError = null;
  recordingId = id;
}

function resetOne(id: RemappableShortcutId) {
  if (readOnly) return;
  // Destructure-omit, never `delete` in place — reassignment is the
  // reactivity hinge in useTandemSettings.
  const { [id]: _omit, ...rest } = settings.customShortcuts;
  onUpdate({ customShortcuts: rest });
  if (recordingId === id) recordingId = null;
  if (conflictError?.id === id) conflictError = null;
}

function resetAll() {
  if (readOnly) return;
  onUpdate({ customShortcuts: {} });
  recordingId = null;
  conflictError = null;
}

const anyOverridden = $derived(REMAPPABLE_SHORTCUT_IDS.some((id) => overrides.has(id)));

// Read-only catalog of fixed (non-remappable) registry shortcuts, grouped.
// These mirror the prior Shortcuts list but exclude the remappable ids, which
// are now shown in the editable section above.
const fixedRegistrySections = $derived.by(() => {
  const actionsMap = getActionsMap();
  const byGroup = new Map<string, Array<{ keys: string; description: string }>>();
  for (const action of actionsMap.values()) {
    if (!action.shortcut) continue;
    if (REGISTRY_TO_SHORTCUT_ID[action.id]) continue; // remappable — shown above
    const rows = byGroup.get(action.group) ?? [];
    rows.push({ keys: action.shortcut, description: action.label });
    byGroup.set(action.group, rows);
  }
  return ACTION_GROUPS.map((g) => ({
    title: g.charAt(0).toUpperCase() + g.slice(1),
    rows: byGroup.get(g) ?? [],
  })).filter((s) => s.rows.length > 0);
});

const kbdStyle =
  "justify-self: start; padding: 1px 6px; font-family: var(--tandem-font-mono); font-size: 11px; color: var(--tandem-fg); background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border-strong); border-bottom-width: 2px; border-radius: var(--tandem-r-2);";
</script>

<div style="display: flex; flex-direction: column; gap: var(--tandem-space-4);">
  <section>
    <div
      style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;"
    >
      <div class="settings-section-label">Customizable</div>
      <button
        type="button"
        data-testid="shortcuts-reset-all"
        disabled={readOnly || !anyOverridden}
        onclick={resetAll}
        style="font-size: 11px; padding: 2px 8px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: {readOnly ||
        !anyOverridden
          ? 'not-allowed'
          : 'pointer'}; opacity: {readOnly || !anyOverridden ? 0.5 : 1};"
      >
        Reset all
      </button>
    </div>

    {#if readOnly}
      <div
        data-testid="store-readonly-banner"
        style="font-size: 11px; color: var(--tandem-warning-fg); margin-bottom: 8px;"
      >
        Settings are read-only (a newer client wrote them). Shortcut changes are disabled.
      </div>
    {/if}

    <div style="display: flex; flex-direction: column; gap: 4px;">
      {#each REMAPPABLE_SHORTCUT_IDS as id (id)}
        {@const isRecording = recordingId === id}
        {@const isOverridden = overrides.has(id)}
        {@const combo = formatChord(effectiveChord(id, overrides))}
        <div
          data-testid={`shortcut-row-${id}`}
          style="display: grid; grid-template-columns: 1fr max-content auto; gap: 10px; align-items: center; padding: 3px 0;"
        >
          <span style="font-size: 13px; color: var(--tandem-fg-muted);">
            {REMAPPABLE_LABELS[id]}
          </span>
          {#if isRecording}
            <span
              data-testid={`shortcut-recording-${id}`}
              style="justify-self: start; font-size: 11px; color: var(--tandem-accent-fg-strong); font-style: italic;"
            >
              Press keys… (Esc to cancel)
            </span>
          {:else}
            <kbd style={kbdStyle}>{combo}</kbd>
          {/if}
          <div style="display: flex; gap: 6px; justify-self: end;">
            <button
              type="button"
              data-testid={`shortcut-edit-${id}`}
              disabled={readOnly}
              onclick={() => startRecording(id)}
              style="font-size: 11px; padding: 2px 8px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: {isRecording
                ? 'var(--tandem-accent-bg)'
                : 'var(--tandem-surface)'}; color: var(--tandem-fg); cursor: {readOnly
                ? 'not-allowed'
                : 'pointer'}; opacity: {readOnly ? 0.5 : 1};"
            >
              {isRecording ? "Recording…" : "Change"}
            </button>
            {#if isOverridden}
              <button
                type="button"
                data-testid={`shortcut-reset-${id}`}
                disabled={readOnly}
                onclick={() => resetOne(id)}
                style="font-size: 11px; padding: 2px 8px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: {readOnly
                  ? 'not-allowed'
                  : 'pointer'}; opacity: {readOnly ? 0.5 : 1};"
              >
                Reset
              </button>
            {/if}
          </div>
          {#if conflictError && conflictError.id === id}
            <div
              data-testid={`shortcut-conflict-${id}`}
              style="grid-column: 1 / -1; font-size: 11px; color: var(--tandem-error-fg);"
            >
              {conflictError.message}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </section>

  {#each fixedRegistrySections as section (section.title)}
    <section>
      <div class="settings-section-label">{section.title} (fixed)</div>
      <div
        style="display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 14px; align-items: center;"
      >
        {#each section.rows as row (row.keys + row.description)}
          <kbd style={kbdStyle}>{row.keys}</kbd>
          <span style="font-size: 13px; color: var(--tandem-fg-muted);">{row.description}</span>
        {/each}
      </div>
    </section>
  {/each}

  <section>
    <div class="settings-section-label">Other (fixed)</div>
    <div
      style="display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 14px; align-items: center;"
    >
      {#each STATIC_SHORTCUT_ROWS as row (row.keys + row.description)}
        <kbd style={kbdStyle}>{row.keys}</kbd>
        <span style="font-size: 13px; color: var(--tandem-fg-muted);">{row.description}</span>
      {/each}
    </div>
  </section>
</div>
