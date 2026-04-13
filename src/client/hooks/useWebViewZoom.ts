import { useEffect } from "react";
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, ZOOM_STORAGE_KEY } from "../../shared/constants";

/**
 * Persists and restores WebView zoom level in Tauri desktop builds.
 *
 * - On mount: reads zoom from localStorage, clamps it, and applies via Tauri's
 *   `webview.setZoom()`.
 * - Ctrl+0 / Cmd+0: resets zoom to 1.0 and persists.
 * - Native Ctrl+Plus/Minus zoom is handled by `zoomHotkeysEnabled` in
 *   tauri.conf.json — this hook does NOT duplicate those handlers. It does
 *   intercept those keys (after they fire natively) to track the current zoom
 *   level for persistence, since Tauri has no `getZoom()` API.
 * - Complete no-op in non-Tauri environments (dynamic import fails gracefully).
 */
export function useWebViewZoom(): void {
  useEffect(() => {
    let tornDown = false;
    let cleanup: (() => void) | undefined;

    // Dynamic import — silently fails outside Tauri, making the hook a no-op
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => {
        if (tornDown) return; // Component already unmounted

        const webview = getCurrentWebview();

        // Restore persisted zoom level
        let currentZoom = ZOOM_DEFAULT;
        try {
          const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
          if (raw !== null) {
            const parsed = Number(raw);
            if (Number.isFinite(parsed)) {
              currentZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, parsed));
            } else {
              console.warn(`[tandem] ignoring invalid stored zoom: ${raw}`);
            }
          }
        } catch {
          // localStorage unavailable (incognito, storage-disabled)
        }

        if (currentZoom !== ZOOM_DEFAULT) {
          webview.setZoom(currentZoom).catch((err: unknown) => {
            console.warn("[tandem] failed to restore zoom level:", err);
          });
        }

        function persist(zoom: number): void {
          try {
            localStorage.setItem(ZOOM_STORAGE_KEY, String(zoom));
          } catch {
            // localStorage unavailable
          }
        }

        // Ctrl+0 / Cmd+0 reset — capture phase fires before Tiptap swallows it
        const handleReset = (e: KeyboardEvent) => {
          const mod = e.metaKey || e.ctrlKey;
          if (!mod || e.key !== "0") return;

          e.preventDefault();
          e.stopPropagation();

          currentZoom = ZOOM_DEFAULT;
          webview.setZoom(ZOOM_DEFAULT).catch((err: unknown) => {
            console.warn("[tandem] failed to reset zoom:", err);
          });
          persist(ZOOM_DEFAULT);
        };

        // Track zoom changes from native Ctrl+Plus/Minus for persistence.
        // Tauri's zoomHotkeysEnabled handles the actual zoom; we just update
        // our tracked level. The native zoom step is ~10% per keypress.
        const ZOOM_STEP = 0.1;
        const handleZoomTrack = (e: KeyboardEvent) => {
          const mod = e.metaKey || e.ctrlKey;
          if (!mod) return;

          // "=" is the unshifted key for "+" on US/intl keyboards
          const isZoomIn = e.key === "+" || e.key === "=";
          const isZoomOut = e.key === "-" || e.key === "_";
          if (!isZoomIn && !isZoomOut) return;

          const next = isZoomIn ? currentZoom + ZOOM_STEP : currentZoom - ZOOM_STEP;
          currentZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(next * 100) / 100));
          persist(currentZoom);
        };

        window.addEventListener("keydown", handleReset, { capture: true });
        window.addEventListener("keydown", handleZoomTrack, { capture: true });

        cleanup = () => {
          window.removeEventListener("keydown", handleReset, { capture: true });
          window.removeEventListener("keydown", handleZoomTrack, { capture: true });
        };
      })
      .catch(() => {
        // Not running in Tauri — hook is a no-op
      });

    return () => {
      tornDown = true;
      cleanup?.();
    };
  }, []);
}
