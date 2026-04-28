import { useEffect, useState } from "react";
import type { AppInfoData } from "../types";
import { API_BASE } from "../utils/fileUpload";

// ---------------------------------------------------------------------------
// Module-level cache — avoids repeated fetches across popover open/close cycles
// within a single session. Reset is only needed in tests.
// ---------------------------------------------------------------------------
let cachedInfo: AppInfoData | null = null;

/** Reset the module-level cache. Exported for use in tests only. */
export function _resetAppInfoCache(): void {
  cachedInfo = null;
}

// ---------------------------------------------------------------------------
// Pure fetch helper — extracted so it can be tested in a Node environment
// without a React renderer.
// ---------------------------------------------------------------------------

/**
 * Fetch `/api/info` and return the parsed `AppInfoData`. The result is cached
 * at module scope so repeated calls within a session skip the network. Throws
 * on network error, non-ok HTTP status, or if the provided signal is aborted.
 * The caller is responsible for constructing an appropriate AbortSignal.
 */
export async function fetchAppInfo(signal: AbortSignal): Promise<AppInfoData> {
  if (cachedInfo !== null) return cachedInfo;
  const resp = await fetch(`${API_BASE}/info`, { signal });
  if (!resp.ok) {
    throw new Error(`/api/info responded ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as AppInfoData;
  cachedInfo = data;
  return data;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseAppInfoResult {
  info: AppInfoData | null;
  loading: boolean;
}

/**
 * Fetches app metadata from GET /api/info each time `open` transitions to
 * true. The result is cached at module scope so repeated popover opens after
 * the first are instant. Errors are silently discarded — the footer simply
 * doesn't render on failure (graceful degradation, no visible error state).
 *
 * @param open - Whether the calling panel is currently open. Effect fires
 *               each time this flips from false → true.
 */
export function useAppInfo(open: boolean): UseAppInfoResult {
  // Initialise with the cached value so there's no loading flash on
  // subsequent opens.
  const [info, setInfo] = useState<AppInfoData | null>(cachedInfo);
  const [loading, setLoading] = useState<boolean>(open && cachedInfo === null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const controller = new AbortController();
    // Manual timeout — AbortSignal.any is not available on macOS 13 / Safari 16
    // (WKWebView used by Tauri on older macOS).
    const timeout = setTimeout(() => controller.abort(), 3000);

    setLoading(true);

    fetchAppInfo(controller.signal)
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
      })
      .catch((err: unknown) => {
        // AbortError is expected on cleanup or timeout — stay silent.
        if (err instanceof Error && err.name !== "AbortError") {
          console.warn("[useAppInfo] failed to load /api/info:", err);
        }
        // Otherwise silently swallowed — UI hides the footer, no degradation.
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [open]);

  return { info, loading };
}
