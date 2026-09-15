import {
  AUTHORSHIP_TOGGLE_KEY,
  DECORATION_VISIBILITY_KEY,
  TANDEM_SETTINGS_KEY,
} from "../../shared/constants.js";
import type { TandemSettings } from "./useTandemSettings.js";
import { loadSettings, mergeAndClampSettings } from "./useTandemSettings.js";

// Re-export types and helpers for consumers that import from this module
export type {
  Density,
  EditorFont,
  ModelProvider,
  ModelRegistryEntry,
  PanelOrder,
  PrimaryTab,
  SidecarRetryStrategy,
  TandemSettings,
  TextSize,
  ThemePreference,
} from "./useTandemSettings.js";
export {
  loadSettings,
  mergeAndClampSettings,
  resolveFont,
  TEXT_SIZE_PX,
  VALID_MODEL_PROVIDERS,
} from "./useTandemSettings.js";

export interface TandemSettingsState {
  readonly settings: TandemSettings;
  /**
   * Applies `partial` and returns whether it was WRITTEN. `false` means the
   * read-only short-circuit refused it — the settings blob on disk was written
   * by a newer Tandem (#659). Before #1722/#1792 this returned `void`, so none
   * of the eleven call sites could tell a refusal from a success and every
   * settings-backed control outside the modal was a silent no-op.
   */
  updateSettings: (partial: Partial<TandemSettings>) => boolean;
}

// Module-level singleton — see createTandemSettings doc-comment.
let _instance: TandemSettingsState | null = null;

/**
 * Registered once by `App.svelte`; invoked whenever `updateSettings` refuses a
 * write. Central rather than per-call-site: one wiring line makes the refusal
 * legible at all eleven call sites at once, and `useNotifications`' dedup
 * collapses repeated clicks into a single count badge.
 *
 * A module-level setter rather than an import because `createNotifications` is
 * not a singleton.
 */
let onWriteRefused: (() => void) | null = null;

/** Register (or clear, with `null`) the settings-write-refused handler. */
export function setSettingsWriteRefusedHandler(fn: (() => void) | null): void {
  onWriteRefused = fn;
}

/**
 * Mirror the *effective* decoration visibility (master mute folded in) to the
 * dedicated localStorage keys the ProseMirror plugins read at init, before any
 * Svelte effect runs. Seeded on initial load AND rewritten on every update so a
 * user who has decorations muted/off never sees a flash of marks on cold load.
 */
function mirrorDecorationKeys(s: TandemSettings): void {
  const muted = s.decorationsMuted;
  try {
    localStorage.setItem(AUTHORSHIP_TOGGLE_KEY, String(!muted && s.showAuthorship));
    localStorage.setItem(
      DECORATION_VISIBILITY_KEY,
      JSON.stringify({
        comment: !muted && s.showComments,
        highlight: !muted && s.showHighlights,
        note: !muted && s.showNotes,
      }),
    );
  } catch {
    // localStorage unavailable (incognito/storage-disabled)
  }
}

/**
 * Svelte 5 port of `useTandemSettings`.
 *
 * Manages persistent application settings with localStorage backing.
 * All numeric values are clamped on write via `mergeAndClampSettings`.
 *
 * **Singleton:** every call returns the same `TandemSettingsState`
 * instance. Required for correctness — without it, multiple consumers
 * (App.svelte, SettingsModelsTab.svelte) would each hold an independent
 * `$state` snapshot and clobber each other's localStorage writes (last
 * writer wins, silently losing the previous instance's mutations since
 * its own snapshot was loaded).
 *
 * **Read-only short-circuit:** when `loadSettings()` returns settings
 * tagged `_readOnly: true` (the on-disk schema is newer than this
 * client), `updateSettings` becomes a no-op. This is the load-bearing
 * defence against a downgraded client clobbering a newer client's
 * Models registry / future fields on first save (#659 Wave 2 PR 8a).
 */
export function createTandemSettings(): TandemSettingsState {
  if (_instance) return _instance;

  const loaded = loadSettings();
  let settings = $state<TandemSettings>(loaded);

  // Seed the plugin-init keys from loaded settings so the annotation/authorship
  // plugins read the correct visibility on cold load (before the first update).
  // References `loaded` (not the $state) — this is a deliberate one-time seed.
  mirrorDecorationKeys(loaded);

  const updateSettings = (partial: Partial<TandemSettings>): boolean => {
    if (settings._readOnly) {
      onWriteRefused?.();
      return false;
    }
    const next = mergeAndClampSettings(settings, partial);
    try {
      localStorage.setItem(TANDEM_SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // localStorage unavailable (incognito/storage-disabled)
    }
    // Mirror the effective decoration keys for ProseMirror plugin init.
    mirrorDecorationKeys(next);
    settings = next;
    return true;
  };

  _instance = {
    get settings() {
      return settings;
    },
    updateSettings,
  };
  return _instance;
}

/**
 * Test-only reset hook. Drops the module-level singleton so the next
 * `createTandemSettings()` call rebuilds from a fresh `loadSettings()`.
 * Tests that exercise the factory MUST call this in `beforeEach` after
 * stubbing localStorage, otherwise cross-test pollution silently masks
 * the singleton with stale state.
 */
export function _resetTandemSettingsSingletonForTests(): void {
  _instance = null;
  // The refused handler is module state too. Without this reset a handler
  // registered by an earlier test survives into the next one, and the
  // "handler does not fire" assertion is decided by test ordering.
  onWriteRefused = null;
}

// HMR safety: a hot-replace of this module would reset `_instance` to
// null while existing consumers (App.svelte) still hold the OLD
// reference. SettingsModelsTab remounting after the hook HMR would
// call createTandemSettings() and get a NEW _instance — reintroducing
// the two-instance bug, dev-only. We DON'T register
// `import.meta.hot.accept`, which causes Vite to trigger a full page
// reload by default for any update to this module — the correct
// mitigation. (Vite 6 removed the explicit `decline()` API.)
