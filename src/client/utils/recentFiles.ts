import { RECENT_FILES_CAP, RECENT_FILES_KEY } from "../../shared/constants.js";

/** Add a path to the recent files list. Deduplicates, caps at RECENT_FILES_CAP, most recent first. */
export function addRecentFile(list: string[], path: string, cap = RECENT_FILES_CAP): string[] {
  const filtered = list.filter((p) => p !== path);
  return [path, ...filtered].slice(0, cap);
}

export function loadRecentFiles(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FILES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch (err) {
    console.warn("[tandem] failed to load recent files:", err);
    return [];
  }
}

export function saveRecentFiles(list: string[]): void {
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(list));
    invalidateRecentFilesCache();
  } catch (err) {
    console.warn("[tandem] failed to save recent files:", err);
  }
}

export function clearRecentFiles(): void {
  try {
    localStorage.removeItem(RECENT_FILES_KEY);
    invalidateRecentFilesCache();
  } catch (err) {
    console.warn("[tandem] failed to clear recent files:", err);
  }
}

// ---------------------------------------------------------------------------
// Cache — avoids repeated localStorage reads when the menu opens repeatedly
// ---------------------------------------------------------------------------

const CACHE_TTL = 30_000;
let _cache: { files: string[]; ts: number } | null = null;

export function loadRecentFilesCached(): string[] {
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_TTL) return _cache.files;
  const files = loadRecentFiles();
  _cache = { files, ts: now };
  return files;
}

export function invalidateRecentFilesCache(): void {
  _cache = null;
}
