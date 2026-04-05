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
  } catch {
    return [];
  }
}

export function saveRecentFiles(list: string[]): void {
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(list));
  } catch {
    // localStorage unavailable (incognito, storage-disabled)
  }
}

export function clearRecentFiles(): void {
  try {
    localStorage.removeItem(RECENT_FILES_KEY);
  } catch {
    // localStorage unavailable (incognito, storage-disabled)
  }
}
