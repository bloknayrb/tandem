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
  } catch (err) {
    console.warn("[Tandem] Theme detection failed, defaulting to light:", err);
    return "light";
  }
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

/**
 * Update <meta name="theme-color"> to match the resolved theme. Called by
 * applyTheme() so the browser chrome (mobile address bar, PWA title bar)
 * stays in sync with the app surface color whenever the theme changes.
 *
 * Colors are hardcoded hex approximations of --tandem-bg so the meta tag
 * is set synchronously before the next paint without a getComputedStyle
 * round-trip. Must match the light/dark/warm --tandem-bg values in index.html:
 *   light: oklch(0.985 0.004 80)  ≈ #fafaf9
 *   dark:  oklch(0.18 0.012 270)  ≈ #1c1c24
 *   warm:  oklch(0.945 0.012 70)  ≈ #f1ead9
 */
function syncThemeColorMeta(resolved: ResolvedTheme): void {
  try {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) {
      meta.content = resolved === "dark" ? "#1c1c24" : resolved === "warm" ? "#f1ead9" : "#fafaf9";
    }
  } catch {
    // Guard against SSR or DOM-less test environments where document may throw.
  }
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
  const resolved = resolveTheme(pref);
  root.setAttribute("data-theme", resolved);
  syncThemeColorMeta(resolved);

  if (pref !== "system") {
    return () => root.removeAttribute("data-theme");
  }

  if (isTauriRuntime()) {
    return () => root.removeAttribute("data-theme");
  }

  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    const next = systemTheme();
    root.setAttribute("data-theme", next);
    syncThemeColorMeta(next);
  };
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
