/**
 * File watcher module for detecting on-disk changes to open documents.
 *
 * Uses node:fs.watch with 500ms debounce. A Tandem write is recognized as its
 * own (not an external edit) by TWO layers, because a single save can produce
 * multiple `change` events (atomic rename + content swap on some platforms;
 * editors that do touch-then-write):
 *
 *  1. Arrival-time suppress COUNTER (`suppressNextChange`). Consumed once per
 *     event the instant it arrives, before the debounce. A counted TTL, not a
 *     boolean: a boolean only catches the first of N events; the TTL
 *     (`SUPPRESS_TTL_MS`) guards against a suppress call with no matching event
 *     ever arriving (a stale flag would otherwise swallow the next legitimate
 *     external change forever).
 *  2. Delivery-time content FINGERPRINT (`recordSelfWrite` + `isSelfWriteEcho`).
 *     The counter can under-count — NTFS fires ~2 events per atomic rename but
 *     callers arm count=1, so one event leaks past it (issue #1142 follow-up).
 *     The fingerprint is the backstop: in the debounce timer, before reloading,
 *     we compare the bytes on disk to a hash of what Tandem just wrote and skip
 *     the redundant reload only on an EXACT content match. A content hash (not
 *     size+mtime) is mandatory — mtime is unreliable on FAT/exFAT/SMB and for
 *     mtime-preserving writers, and a false skip = silently dropping a real
 *     external edit. The fingerprint is TTL-bounded too (an echo of the write
 *     just made, not a long-lived "is this our content" oracle).
 *
 * Suppressing the leaked echo is a correctness fix, not just toast suppression:
 * each redundant `reloadFromDisk` re-runs `refreshAllRanges` + textSnapshot
 * relocation, an extra exposure to the known no-textSnapshot mis-anchoring path.
 */

import crypto from "node:crypto";
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
  /**
   * Content fingerprint of the most recent Tandem self-write (delivery-time
   * backstop, see module header). `size`+`hash` of the exact bytes written;
   * `until` bounds the echo window. Set by `recordSelfWrite`, consumed by
   * `isSelfWriteEcho` in the debounce timer. `null` ⇒ no recent self-write ⇒
   * the next event reloads (the guard does no disk read at all).
   */
  selfWrite: { size: number; hash: string; until: number } | null;
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
      entry.timer = setTimeout(async () => {
        entry.timer = null;
        // Delivery-time content backstop: a write Tandem just made can leak a
        // `change` event past the arrival-time counter (NTFS fires ~2 events
        // per atomic rename; callers arm count=1). If the bytes on disk are
        // exactly what we wrote, skip the redundant reload + toast. Falls
        // through to reload on any mismatch — never swallows a real edit.
        if (await isSelfWriteEcho(filePath)) return;
        onChanged(filePath).catch((err) => {
          console.error("[FileWatcher] onChanged callback failed for %s:", filePath, err);
        });
      }, 500);
    });
  } catch (err) {
    console.error("[FileWatcher] Failed to watch %s:", filePath, err);
    return;
  }

  watcher.on("error", (err) => {
    console.error("[FileWatcher] Watcher error for %s:", filePath, err);
    unwatchFile(filePath);
  });

  watched.set(filePath, { watcher, timer: null, suppressed: null, selfWrite: null });
  console.error("[FileWatcher] Watching %s", filePath);
}

/**
 * Suppress the next detected change for a file path (arrival-time layer 1; see
 * module header). Increments the per-path suppress counter and refreshes the
 * TTL — a subsequent suppress call before the first event arrives bumps the
 * count so both events are swallowed.
 *
 * Used when the server itself writes to the file (e.g., tandem_save). Pair it
 * with `recordSelfWrite` AFTER the write for the content backstop (layer 2) —
 * the counter alone under-counts the NTFS atomic-rename double-event. Safe to
 * call repeatedly; events-in-flight older than the TTL are ignored.
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
 * Record the content fingerprint of a write Tandem just performed (delivery-time
 * layer 2; see module header), so the debounce-timer guard can recognize the
 * write's own `change`-event echo and skip a redundant reload.
 *
 * Pass the EXACT bytes/string handed to `atomicWrite`/`atomicWriteBuffer`.
 * Hashing the in-memory content (rather than re-stat'ing disk) is synchronous,
 * so the fingerprint is set before the event loop can deliver the leaked echo,
 * and it can't race an external write landing between our rename and a stat.
 *
 * TTL-bounded (`SUPPRESS_TTL_MS`) like the counter: the fingerprint is a
 * short-lived "echo of the write I just did", NOT a long-lived "is this our
 * content" oracle. After it expires any matching bytes reload normally, so a
 * later external revert-to-identical-bytes can't be silently skipped.
 *
 * No-op if the path isn't watched. Never throws — on hash failure it clears the
 * fingerprint (a `null` fingerprint just means "the next event reloads", the
 * safe default).
 */
export function recordSelfWrite(filePath: string, content: Buffer | string): void {
  const entry = watched.get(filePath);
  if (!entry) return;
  try {
    entry.selfWrite = {
      size: Buffer.byteLength(content),
      hash: crypto.createHash("sha256").update(content).digest("hex"),
      until: Date.now() + SUPPRESS_TTL_MS,
    };
  } catch (err) {
    entry.selfWrite = null;
    console.error("[FileWatcher] recordSelfWrite failed for %s:", filePath, err);
  }
}

/**
 * Delivery-time backstop run inside the debounce timer (after the arrival-time
 * counter). Returns true — skip the reload + notification — ONLY when the file
 * on disk is byte-for-byte the content Tandem just wrote AND the fingerprint is
 * still within its echo window. An absent/expired fingerprint, a size or hash
 * mismatch, or a read error all fall through to a reload: this can never
 * swallow a genuine external edit (different bytes ⇒ different hash), only a
 * redundant reload of our own bytes. No disk read when no fingerprint is set.
 */
async function isSelfWriteEcho(filePath: string): Promise<boolean> {
  const entry = watched.get(filePath);
  if (!entry?.selfWrite) return false;
  const fp = entry.selfWrite;
  if (Date.now() > fp.until) {
    entry.selfWrite = null; // echo window elapsed — reload from here on
    return false;
  }
  try {
    const bytes = await fs.promises.readFile(filePath);
    if (bytes.length !== fp.size) return false; // size differs ⇒ real change
    if (crypto.createHash("sha256").update(bytes).digest("hex") === fp.hash) {
      console.error("[FileWatcher] self-write echo suppressed for %s", filePath);
      return true;
    }
    // Size matched but content differs — a real edit a size-only check would
    // have mistaken for our echo (the data-loss-adjacent near-miss the content
    // hash exists to catch). Surface it and reload.
    console.error("[FileWatcher] external change (size match, content differ) for %s", filePath);
    return false;
  } catch (err) {
    // Can't read the file — fail toward reloading, never toward a silent skip.
    console.error("[FileWatcher] self-write echo check failed for %s, reloading:", filePath, err);
    return false;
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
    console.error("[FileWatcher] watcher.close() failed for %s:", filePath, err);
  }
  watched.delete(filePath);
  console.error("[FileWatcher] Unwatched %s", filePath);
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
