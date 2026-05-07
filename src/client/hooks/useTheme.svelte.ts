import type { ThemePreference } from "./useTandemSettings.js";
import { initTauriTheme, tauriTheme } from "./useTauriTheme.svelte.js";
import { applyTheme } from "./useTheme.js";

// Re-export helpers for consumers
export type { ResolvedTheme } from "./useTheme.js";
export { applyTheme, resolveTheme, systemTheme } from "./useTheme.js";

/**
 * Svelte 5 port of `useTheme`.
 *
 * Apply the resolved theme to <html data-theme="…"> and, when the user's
 * preference is "system", re-apply on OS-level changes.
 *
 * In Tauri, initializes the theme bridge (get_app_theme command + onThemeChanged
 * subscription) so that OS app-mode changes (AppsUseLightTheme) are tracked
 * reactively. In browser mode, the matchMedia subscription inside applyTheme
 * handles OS changes instead.
 *
 * Accepts a getter for `pref` so callers with `$state` values propagate
 * reactively.
 */
export function createTheme(getPref: () => ThemePreference): void {
  // Initialize the Tauri theme bridge once — no-op in browser mode
  initTauriTheme();

  $effect(() => {
    const pref = getPref();
    void tauriTheme.current;
    return applyTheme(pref);
  });
}
