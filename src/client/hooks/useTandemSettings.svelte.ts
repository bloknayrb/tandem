import { AUTHORSHIP_TOGGLE_KEY, TANDEM_SETTINGS_KEY } from "../../shared/constants.js";
import type { TandemSettings } from "./useTandemSettings.js";
import { loadSettings, mergeAndClampSettings } from "./useTandemSettings.js";

// Re-export types and helpers for consumers that import from this module
export type {
  Density,
  EditorFont,
  LayoutMode,
  LeftSlotKind,
  PanelOrder,
  PrimaryTab,
  TandemSettings,
  TextSize,
  ThemePreference,
} from "./useTandemSettings.js";
export { loadSettings, mergeAndClampSettings, TEXT_SIZE_PX } from "./useTandemSettings.js";

export interface TandemSettingsState {
  readonly settings: TandemSettings;
  updateSettings: (partial: Partial<TandemSettings>) => void;
}

/**
 * Svelte 5 port of `useTandemSettings`.
 *
 * Manages persistent application settings with localStorage backing.
 * All numeric values are clamped on write via `mergeAndClampSettings`.
 */
export function createTandemSettings(): TandemSettingsState {
  let settings = $state<TandemSettings>(loadSettings());

  const updateSettings = (partial: Partial<TandemSettings>) => {
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
