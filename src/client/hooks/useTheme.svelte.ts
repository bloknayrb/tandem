import type { ThemePreference } from "./useTandemSettings.js";
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
 * Accepts a getter for `pref` so callers with `$state` values propagate
 * reactively.
 */
export function createTheme(getPref: () => ThemePreference): void {
  $effect(() => {
    const pref = getPref();
    return applyTheme(pref);
  });
}
