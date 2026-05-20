import { AUTHORSHIP_TOGGLE_KEY, TANDEM_SETTINGS_KEY } from "../../shared/constants.js";
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
  TEXT_SIZE_PX,
  VALID_MODEL_PROVIDERS,
} from "./useTandemSettings.js";

export interface TandemSettingsState {
  readonly settings: TandemSettings;
  updateSettings: (partial: Partial<TandemSettings>) => void;
}

// Module-level singleton — see createTandemSettings doc-comment.
let _instance: TandemSettingsState | null = null;

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

  let settings = $state<TandemSettings>(loadSettings());

  const updateSettings = (partial: Partial<TandemSettings>) => {
    if (settings._readOnly) return;
    const next = mergeAndClampSettings(settings, partial);
    try {
      localStorage.setItem(TANDEM_SETTINGS_KEY, JSON.stringify(next));
      // Mirror authorship toggle to dedicated key for ProseMirror plugin init
      localStorage.setItem(AUTHORSHIP_TOGGLE_KEY, String(next.showAuthorship));
    } catch {
      // localStorage unavailable (incognito/storage-disabled)
    }
    settings = next;
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
}

// HMR safety: a hot-replace of this module would reset `_instance` to
// null while existing consumers (App.svelte) still hold the OLD
// reference. SettingsModelsTab remounting after the hook HMR would
// call createTandemSettings() and get a NEW _instance — reintroducing
// the two-instance bug, dev-only. We DON'T register
// `import.meta.hot.accept`, which causes Vite to trigger a full page
// reload by default for any update to this module — the correct
// mitigation. (Vite 6 removed the explicit `decline()` API.)
