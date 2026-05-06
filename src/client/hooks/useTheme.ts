import { isTauriRuntime } from "@client/cowork/cowork-helpers";
import type { ThemePreference } from "./useTandemSettings";

export type ResolvedTheme = "light" | "dark";

export function systemTheme(): ResolvedTheme {
  try {
    if (typeof window === "undefined") return "light";
    if (isTauriRuntime()) {
      // Read the Tauri-resolved theme (seeded by the Rust get_app_theme command
      // via window.__TANDEM_INITIAL_THEME__ or the useTauriTheme bridge).
      // Reads AppsUseLightTheme (app mode), not taskbar mode. Fixes #535.
      const tauri = (window as any).__TANDEM_INITIAL_THEME__;
      if (tauri === "dark" || tauri === "light") return tauri;
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
 *
 * Exported so the DOM side-effect contract is directly testable without
 * spinning up a Svelte render environment.
 */
export function applyTheme(pref: ThemePreference): () => void {
  const root = document.documentElement;
  root.setAttribute("data-theme", resolveTheme(pref));

  if (pref !== "system") {
    return () => root.removeAttribute("data-theme");
  }

  // In Tauri, OS theme changes are handled reactively via useTauriTheme.svelte.ts.
  // Skip the matchMedia subscription to prevent a race condition where matchMedia
  // (which reads taskbar mode) overwrites the Tauri-resolved app-mode value.
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

// React hook removed — utilities migrated to useTheme.svelte.ts
