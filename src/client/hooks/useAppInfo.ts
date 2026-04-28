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
 * Fetch `/api/info` and return the parsed `AppInfoData`. Throws on network
 * error, non-ok HTTP status, or if the provided signal is aborted. The caller
 * is responsible for constructing an appropriate AbortSignal.
 */
export async function fetchAppInfo(signal: AbortSignal): Promise<AppInfoData> {
  const resp = await fetch(`${API_BASE}/info`, { signal });
  if (!resp.ok) {
    throw new Error(`/api/info responded ${resp.status} ${resp.statusText}`);
  }
  return resp.json() as Promise<AppInfoData>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseAppInfoResult {
  info: AppInfoData | null;
  loading: boolean;
  error: string | null;
}

/**
 * Fetches app metadata from GET /api/info each time `open` transitions to
 * true. The result is cached at module scope so repeated popover opens after
 * the first are instant. Error state shows nothing in the UI — the footer
 * simply doesn't render, so no degradation on transient network issues.
 *
 * @param open - Whether the calling panel is currently open. Effect fires
 *               each time this flips from false → true.
 */
export function useAppInfo(open: boolean): UseAppInfoResult {
  // Initialise with the cached value so there's no loading flash on
  // subsequent opens.
  const [info, setInfo] = useState<AppInfoData | null>(cachedInfo);
  const [loading, setLoading] = useState<boolean>(open && cachedInfo === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // If we already have a cached result, skip the network call.
    if (cachedInfo !== null) {
      setInfo(cachedInfo);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    // Combine caller-controlled abort with a 3 s hard timeout.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);

    setLoading(true);
    setError(null);

    fetchAppInfo(signal)
      .then((data) => {
        if (cancelled) return;
        cachedInfo = data;
        setInfo(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open]);

  return { info, loading, error };
}
