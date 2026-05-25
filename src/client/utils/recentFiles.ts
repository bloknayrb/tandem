import { RECENT_FILES_CAP, RECENT_FILES_KEY } from "../../shared/constants.js";

export interface RecentFileEntry {
  path: string;
  /**
   * ms epoch when the path first entered the recents list. `0` means unknown —
   * either migrated from the legacy `string[]` storage shape or a malformed
   * entry coerced on load. The launcher UI omits the "when" label for `0`.
   */
  openedAt: number;
}

/**
 * Add a path to the recent files list. Dedupes by path (newest first), caps at
 * RECENT_FILES_CAP.
 *
 * An already-present path KEEPS its original `openedAt` (the existing entry
 * object is reused, just moved to the front). This matters because the
 * recents-sync effect in `App.svelte` re-adds every open tab on each tab
 * change — re-stamping `openedAt` there would peg all open files to "just now"
 * and spam `saveRecentFiles`. Only a genuinely new path is stamped.
 */
export function addRecentFile(
  list: RecentFileEntry[],
  path: string,
  openedAt: number = Date.now(),
  cap = RECENT_FILES_CAP,
): RecentFileEntry[] {
  const existing = list.find((e) => e.path === path);
  const entry: RecentFileEntry = existing ?? { path, openedAt };
  const filtered = list.filter((e) => e.path !== path);
  return [entry, ...filtered].slice(0, cap);
}

/** Project just the paths (newest first) — for call sites that render path strings. */
export function recentFilePaths(list: RecentFileEntry[]): string[] {
  return list.map((e) => e.path);
}

export function loadRecentFiles(): RecentFileEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_FILES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x): RecentFileEntry | null => {
        // Legacy shape: a bare path string → migrate with unknown timestamp.
        if (typeof x === "string") return { path: x, openedAt: 0 };
        // Current shape: { path, openedAt }. Tolerate a missing/non-numeric
        // openedAt (coerce to 0); drop anything without a string path.
        if (
          x !== null &&
          typeof x === "object" &&
          typeof (x as RecentFileEntry).path === "string"
        ) {
          const e = x as Partial<RecentFileEntry> & { path: string };
          return { path: e.path, openedAt: typeof e.openedAt === "number" ? e.openedAt : 0 };
        }
        return null;
      })
      .filter((e): e is RecentFileEntry => e !== null);
  } catch (err) {
    console.warn("[tandem] failed to load recent files:", err);
    return [];
  }
}

export function saveRecentFiles(list: RecentFileEntry[]): void {
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
let _cache: { files: RecentFileEntry[]; ts: number } | null = null;

export function loadRecentFilesCached(): RecentFileEntry[] {
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_TTL) return _cache.files;
  const files = loadRecentFiles();
  _cache = { files, ts: now };
  return files;
}

export function invalidateRecentFilesCache(): void {
  _cache = null;
}
