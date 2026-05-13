import { API_INFO } from "../../shared/api-paths";
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
  const resp = await fetch(`${API_BASE}${API_INFO}`, { signal });
  if (!resp.ok) {
    throw new Error(`${API_INFO} responded ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as AppInfoData;
  cachedInfo = data;
  return data;
}
