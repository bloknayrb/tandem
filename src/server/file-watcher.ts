/**
 * File watcher module for detecting on-disk changes to open documents.
 *
 * Uses node:fs.watch with 500ms debounce. Callers can suppress the next
 * change event (e.g., after tandem_save writes the file itself).
 *
 * Suppression uses a counted TTL, not a boolean: a single save can produce
 * multiple `change` events (atomic rename + content swap on some platforms;
 * editors that do touch-then-write), and a boolean flag only catches the
 * first one, letting the rest fire spurious reloads. The counter consumes
 * once per event; the TTL (`SUPPRESS_TTL_MS`) guards against a suppress call
 * with no matching event ever arriving — without it a stale flag would
 * swallow the next legitimate external change forever.
 */

import fs from "node:fs";

/** How long a suppressed count stays live before expiring. */
const SUPPRESS_TTL_MS = 2000;

interface WatchEntry {
  watcher: fs.FSWatcher;
  timer: NodeJS.Timeout | null;
  /**
   * Active suppression window. `count` events will be swallowed (each event
   * decrements); when `count` reaches 0 OR `Date.now() > until`, the
   * suppression is cleared and the next event fires normally.
   */
  suppressed: { count: number; until: number } | null;
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

      // Check suppress at event arrival, not timer expiry. The counter
      // handles the common "atomic save fires 2 events on NTFS" case; the
      // TTL guards against an unmatched suppressNextChange() leaving a
      // stale flag that would otherwise swallow a real external change.
      if (entry.suppressed) {
        if (Date.now() > entry.suppressed.until) {
          // Expired without being consumed — clear it and fall through so
          // this legitimate change event fires.
          entry.suppressed = null;
        } else {
          entry.suppressed.count -= 1;
          if (entry.suppressed.count <= 0) entry.suppressed = null;
          return;
        }
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

  watched.set(filePath, { watcher, timer: null, suppressed: null });
  console.error(`[FileWatcher] Watching ${filePath}`);
}

/**
 * Suppress the next detected change for a file path. Increments the per-path
 * suppress counter and refreshes the TTL — a subsequent suppress call before
 * the first event arrives bumps the count so both events are swallowed.
 *
 * Used when the server itself writes to the file (e.g., tandem_save). Safe
 * to call repeatedly; events-in-flight older than the TTL are ignored.
 */
export function suppressNextChange(filePath: string): void {
  const entry = watched.get(filePath);
  if (!entry) return;
  const until = Date.now() + SUPPRESS_TTL_MS;
  if (entry.suppressed && entry.suppressed.until > Date.now()) {
    entry.suppressed.count += 1;
    entry.suppressed.until = until;
  } else {
    entry.suppressed = { count: 1, until };
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
