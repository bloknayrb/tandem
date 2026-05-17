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
  RailTab,
  SidecarRetryStrategy,
  TandemSettings,
  TextSize,
  ThemePreference,
} from "./useTandemSettings.js";
export {
  loadSettings,
  mergeAndClampSettings,
  TEXT_SIZE_PX,
  THEME_LABEL,
  THEME_NEXT,
} from "./useTandemSettings.js";

export interface TandemSettingsState {
  readonly settings: TandemSettings;
  updateSettings: (partial: Partial<TandemSettings>) => void;
}

/**
 * Svelte 5 port of `useTandemSettings`.
 *
 * Manages persistent application settings with localStorage backing.
 * All numeric values are clamped on write via `mergeAndClampSettings`.
 *
 * **Read-only short-circuit:** when `loadSettings()` returns settings
 * tagged `_readOnly: true` (the on-disk schema is newer than this
 * client), `updateSettings` becomes a no-op. This is the load-bearing
 * defence against a downgraded client clobbering a newer client's
 * Models registry / future fields on first save (#659 Wave 2 PR 8a).
 */
export function createTandemSettings(): TandemSettingsState {
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

  return {
    get settings() {
      return settings;
    },
    updateSettings,
  };
}
