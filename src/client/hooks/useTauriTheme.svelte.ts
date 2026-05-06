import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";
import type { ResolvedTheme } from "./useTheme.js";

class TauriThemeStore {
  current = $state<ResolvedTheme | null>(
    isTauriRuntime() ? (((window as any).__TANDEM_INITIAL_THEME__ as ResolvedTheme) ?? null) : null,
  );
}

export const tauriTheme = new TauriThemeStore();

/** Resets store to null. Call from test teardown for vitest module isolation. */
export function _resetForTests(): void {
  tauriTheme.current = null;
}

let _initialized = false;

/** Initialize the Tauri theme bridge. Called once on first import in Tauri. */
export function initTauriTheme(): void {
  if (_initialized || !isTauriRuntime()) return;
  _initialized = true;

  // Invoke get_app_theme command to sync current OS state
  import("@tauri-apps/api/core").then(({ invoke }) => {
    invoke<string>("get_app_theme")
      .then((theme) => {
        tauriTheme.current = theme === "dark" ? "dark" : "light";
      })
      .catch((e) => {
        console.warn("[useTauriTheme] get_app_theme failed:", e);
      });
  });

  // Subscribe to onThemeChanged events
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    getCurrentWindow()
      .onThemeChanged(({ payload: theme }) => {
        tauriTheme.current = theme === "dark" ? "dark" : "light";
      })
      .catch((e) => {
        console.warn("[useTauriTheme] onThemeChanged subscribe failed:", e);
      });
  });

  // 3-second polling fallback while focused — onThemeChanged reliability
  // on Windows app-mode-only flips is undocumented and unverified
  const pollInterval = setInterval(() => {
    if (!document.hasFocus()) return;
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string>("get_app_theme")
        .then((theme) => {
          const resolved: ResolvedTheme = theme === "dark" ? "dark" : "light";
          if (tauriTheme.current !== resolved) {
            tauriTheme.current = resolved;
          }
        })
        .catch(() => {
          // Non-fatal; onThemeChanged is the primary path
        });
    });
  }, 3000);

  // Clean up polling when window unloads
  window.addEventListener("unload", () => clearInterval(pollInterval), { once: true });
}
