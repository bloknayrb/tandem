import { onDestroy, onMount } from "svelte";
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, ZOOM_STORAGE_KEY } from "../../shared/constants.js";

/**
 * Svelte 5 port of `useWebViewZoom`.
 *
 * Persists and restores WebView zoom level in Tauri desktop builds.
 * Complete no-op in non-Tauri environments.
 */
export function createWebViewZoom(): void {
  let teardown: (() => void) | null = null;

  onMount(() => {
    let tornDown = false;
    let cleanup: (() => void) | undefined;

    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => {
        if (tornDown) return;

        const webview = getCurrentWebview();

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
          // localStorage unavailable
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

        const ZOOM_STEP = 0.1;
        const handleZoomTrack = (e: KeyboardEvent) => {
          const mod = e.metaKey || e.ctrlKey;
          if (!mod) return;
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

    teardown = () => {
      tornDown = true;
      cleanup?.();
    };
  });

  onDestroy(() => {
    teardown?.();
  });
}
