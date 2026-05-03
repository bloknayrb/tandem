import type { AppInfoData } from "../types.js";
import { _resetAppInfoCache, fetchAppInfo } from "./useAppInfo.js";

// Re-export for tests
export { _resetAppInfoCache };

export interface AppInfoState {
  readonly info: AppInfoData | null;
  readonly loading: boolean;
}

/**
 * Svelte 5 port of `useAppInfo`.
 *
 * Fetches app metadata from GET /api/info each time `open` transitions to
 * true. The result is cached at module scope (shared with the React version)
 * so repeated popover opens after the first are instant.
 *
 * Accepts a getter for `open` so callers with `$state` values propagate
 * reactively.
 */
export function createAppInfo(getOpen: () => boolean): AppInfoState {
  // Import module-level cache directly from the React version
  // to share the same cache across both versions.
  let info = $state<AppInfoData | null>(null);
  let loading = $state(false);

  $effect(() => {
    if (!getOpen()) return;

    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    loading = true;

    fetchAppInfo(controller.signal)
      .then((data) => {
        if (cancelled) return;
        info = data;
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name !== "AbortError") {
          console.warn("[useAppInfo] failed to load /api/info:", err);
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!cancelled) loading = false;
      });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  });

  return {
    get info() {
      return info;
    },
    get loading() {
      return loading;
    },
  };
}
