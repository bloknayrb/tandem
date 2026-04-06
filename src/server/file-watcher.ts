/**
 * File watcher module for detecting on-disk changes to open documents.
 *
 * Uses node:fs.watch with 500ms debounce. Callers can suppress the next
 * change event (e.g., after tandem_save writes the file itself).
 */

import fs from "node:fs";

interface WatchEntry {
  watcher: fs.FSWatcher;
  timer: NodeJS.Timeout | null;
  suppressed: boolean;
}

const watched = new Map<string, WatchEntry>();

/**
 * Start watching a file for changes. Calls `onChanged` (debounced 500ms)
 * when the file is modified externally.
 * No-op if the file is already being watched.
 */
export function watchFile(filePath: string, onChanged: (filePath: string) => Promise<void>): void {
  if (watched.has(filePath)) return;

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(filePath, (eventType) => {
      if (eventType !== "change") return;

      const entry = watched.get(filePath);
      if (!entry) return;

      // Check suppress at event arrival, not timer expiry
      if (entry.suppressed) {
        entry.suppressed = false;
        return;
      }

      // Debounce: clear any pending timer and set a new 500ms delay
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
      entry.timer = setTimeout(() => {
        entry.timer = null;
        onChanged(filePath).catch((err) => {
          console.error(`[FileWatcher] onChanged callback failed for ${filePath}:`, err);
        });
      }, 500);
    });
  } catch (err) {
    console.error(`[FileWatcher] Failed to watch ${filePath}:`, err);
    return;
  }

  watcher.on("error", (err) => {
    console.error(`[FileWatcher] Watcher error for ${filePath}:`, err);
    unwatchFile(filePath);
  });

  watched.set(filePath, { watcher, timer: null, suppressed: false });
  console.error(`[FileWatcher] Watching ${filePath}`);
}

/**
 * Suppress the next detected change for a file path.
 * Used when the server itself writes to the file (e.g., tandem_save).
 */
export function suppressNextChange(filePath: string): void {
  const entry = watched.get(filePath);
  if (entry) {
    entry.suppressed = true;
  }
}

/**
 * Stop watching a specific file. No-op if not watched.
 */
export function unwatchFile(filePath: string): void {
  const entry = watched.get(filePath);
  if (!entry) return;

  if (entry.timer !== null) {
    clearTimeout(entry.timer);
  }
  try {
    entry.watcher.close();
  } catch (err) {
    console.error(`[FileWatcher] watcher.close() failed for ${filePath}:`, err);
  }
  watched.delete(filePath);
  console.error(`[FileWatcher] Unwatched ${filePath}`);
}

/**
 * Stop watching all files. Called during shutdown.
 */
export function unwatchAll(): void {
  for (const filePath of [...watched.keys()]) {
    unwatchFile(filePath);
  }
}

/** Expose watched map size for testing. */
export function watchedCount(): number {
  return watched.size;
}
