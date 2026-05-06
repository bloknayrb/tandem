/// <reference types="vite/client" />
import { isTauriRuntime } from "@client/cowork/cowork-helpers.js";
import type { ResolvedTheme } from "./useTheme.js";

declare global {
  interface Window {
    __TANDEM_INITIAL_THEME__?: "light" | "dark";
  }
}

class TauriThemeStore {
  current = $state<ResolvedTheme | null>(
    isTauriRuntime() ? (window.__TANDEM_INITIAL_THEME__ ?? null) : null,
  );
}

export const tauriTheme = new TauriThemeStore();

let _initialized = false;

/** Resets module state. Call from test teardown for vitest module isolation. */
export function _resetForTests(): void {
  tauriTheme.current = null;
  _initialized = false;
  if (typeof window !== "undefined") window.__TANDEM_INITIAL_THEME__ = undefined;
}

/** Write-through setter: keeps tauriTheme.current and the window bootstrap seed in sync. */
function setTauriTheme(next: ResolvedTheme): void {
  tauriTheme.current = next;
  if (typeof window !== "undefined") window.__TANDEM_INITIAL_THEME__ = next;
}

/** Initialize the Tauri theme bridge. Called once on first import in Tauri. */
export function initTauriTheme(): void {
  if (_initialized || !isTauriRuntime()) return;
  _initialized = true;

  // Resolve invoke once; reuse the cached reference in the polling interval.
  let invokeRef: null | ((cmd: string) => Promise<string>) = null;

  import("@tauri-apps/api/core")
    .then(({ invoke }) => {
      invokeRef = invoke as (cmd: string) => Promise<string>;
      invoke<string>("get_app_theme")
        .then((theme) => {
          setTauriTheme(theme === "dark" ? "dark" : "light");
        })
        .catch((e) => {
          console.warn("[useTauriTheme] get_app_theme failed:", e);
        });
    })
    .catch((e) => {
      console.warn("[useTauriTheme] Tauri API import failed:", e);
    });

  // Subscribe to onThemeChanged events
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      getCurrentWindow()
        .onThemeChanged(({ payload: theme }) => {
          setTauriTheme(theme === "dark" ? "dark" : "light");
        })
        .catch((e) => {
          console.warn("[useTauriTheme] onThemeChanged subscribe failed:", e);
        });
    })
    .catch((e) => {
      console.warn("[useTauriTheme] Tauri window API import failed:", e);
    });

  // 3-second polling fallback while focused — onThemeChanged reliability
  // on Windows app-mode-only flips is undocumented and unverified
  let pollErrorLogged = false;
  const pollInterval = setInterval(() => {
    if (!document.hasFocus() || !invokeRef) return;
    invokeRef("get_app_theme")
      .then((theme) => {
        const resolved: ResolvedTheme = theme === "dark" ? "dark" : "light";
        if (tauriTheme.current !== resolved) {
          setTauriTheme(resolved);
          pollErrorLogged = false;
        }
      })
      .catch((e) => {
        if (!pollErrorLogged) {
          console.warn("[useTauriTheme] theme poll failed (further errors suppressed):", e);
          pollErrorLogged = true;
        }
      });
  }, 3000);

  // Clean up the polling interval. pagehide is more reliable than unload in
  // Chromium-based environments (including Tauri's WebView2). HMR dispose
  // prevents interval accumulation across Vite hot-reload cycles.
  const cleanup = () => clearInterval(pollInterval);
  window.addEventListener("pagehide", cleanup, { once: true });
  import.meta.hot?.dispose(cleanup);
}
