import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";
import type { ThemePreference } from "./useTandemSettings.js";
import { initTauriTheme, tauriTheme } from "./useTauriTheme.svelte.js";
import type { ResolvedTheme } from "./useTheme.js";

export type { ResolvedTheme } from "./useTheme.js";

/**
 * Returns the current resolved system theme.
 *
 * In Tauri, reads `tauriTheme.current` (updated live via onThemeChanged +
 * polling) so that OS app-mode flips reach the DOM without restart. Falls back
 * to the startup seed (`__TANDEM_INITIAL_THEME__`) if the bridge hasn't
 * initialized yet. In browser mode, falls back to matchMedia.
 */
export function systemTheme(): ResolvedTheme {
  try {
    if (typeof window === "undefined") return "light";
    if (isTauriRuntime()) {
      // tauriTheme.current reflects live AppsUseLightTheme updates. Falls back
      // to the startup seed set by the Rust eval before Svelte mounts (#535).
      const live = tauriTheme.current;
      if (live === "dark" || live === "light") return live;
      const seed = window.__TANDEM_INITIAL_THEME__;
      if (seed === "dark" || seed === "light") return seed;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

/**
 * Apply the resolved theme to <html data-theme="…"> and, when the user's
 * preference is "system", subscribe to OS-level changes. Returns a cleanup
 * that removes the attribute and (for "system" in browser mode) the matchMedia
 * listener.
 *
 * In Tauri, OS theme changes are handled by useTauriTheme.svelte.ts which
 * triggers a reactive re-run of this function. The matchMedia subscription
 * is skipped to prevent a race where matchMedia overwrites the Tauri value.
 */
export function applyTheme(pref: ThemePreference): () => void {
  const root = document.documentElement;
  root.setAttribute("data-theme", resolveTheme(pref));

  if (pref !== "system") {
    return () => root.removeAttribute("data-theme");
  }

  if (isTauriRuntime()) {
    return () => root.removeAttribute("data-theme");
  }

  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => root.setAttribute("data-theme", systemTheme());
  mq.addEventListener("change", onChange);
  return () => {
    mq.removeEventListener("change", onChange);
    root.removeAttribute("data-theme");
  };
}

/**
 * Svelte 5 port of `useTheme`.
 *
 * Initializes the Tauri theme bridge (get_app_theme + onThemeChanged) so that
 * OS app-mode changes are tracked reactively. In browser mode, the matchMedia
 * subscription inside applyTheme handles OS changes instead.
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
