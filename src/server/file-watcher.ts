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
 *
 * ## `rename` events and the POSIX re-arm (#1749)
 *
 * `fs.watch(path)` on Linux (inotify) watches the INODE, so any tmp+rename
 * atomic save — vim, VS Code, `sed -i`, git, and Tandem's own `atomicWrite` —
 * replaces the inode and leaves the handle watching an unlinked file forever.
 * The watcher then looks healthy and is deaf. `rename` used to be dropped at
 * arrival, which made an external atomic save invisible on EVERY platform.
 *
 * The split is deliberate:
 *
 *  - **Arrival** records `sawRename`, consumes the suppression counter and
 *    schedules the debounce. It takes NO verdict on whether the file exists:
 *    the first `rename` of a delete-then-write can resolve as ENOENT 33-190 ms
 *    before the recreate lands, so any `stat` here is a coin flip.
 *  - **Delivery** (the debounce timer) `stat`s the path — `fs.promises.stat`,
 *    ASYNC, because the ordering guarantees below depend on a call that can be
 *    parked — and only then decides. On POSIX a present file that saw a
 *    `rename` is re-armed in place; a missing one is given one attach attempt
 *    (the file may have landed between the stat and the arm) and, failing that,
 *    is reported lost and unwatched.
 *  - **Windows needs no re-arm at all.** `fs.watch` on a file is
 *    `ReadDirectoryChangesW` on the PARENT directory filtered by name, so the
 *    original handle survives delete+recreate and keeps delivering (measured on
 *    Node 24: an external tmp+rename delivers `rename, rename` and no `change`;
 *    an in-place write `change, change`; a recreate `rename, change`). So
 *    `rearmWatch` is a no-op there and the delivery path's win32 arms only
 *    clear `sawRename`. A deletion on Windows is not a lost watch.
 *  - **macOS is given the Linux treatment deliberately and unverified.**
 *    libuv's Darwin backend is FSEvents, a path-keyed directory stream, so the
 *    handle very likely survives an atomic replace the way Windows' does and
 *    the re-arm is churn with no benefit — but also no harm, since the new
 *    handle is opened before the old one is closed. The kqueue fallback build
 *    is the one case where it is genuinely needed. Nobody has run it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateNotificationId } from "../shared/utils.js";
import { pushNotification } from "./notifications.js";

/** How long a suppressed count stays live before expiring. */
const SUPPRESS_TTL_MS = 2000;

/**
 * Read `process.platform` PER CALL, never once at module scope.
 *
 * The mocked suite stubs the platform with
 * `Object.defineProperty(process, "platform", …)` AFTER importing this module,
 * so a captured module-level constant would make every platform-gated
 * assertion silently test the host instead of the stub — and pass vacuously on
 * whichever OS happens to run it.
 */
function isWin32(): boolean {
  return process.platform === "win32";
}

interface WatchEntry {
  watcher: fs.FSWatcher;
  /**
   * The `fs.watch` listener for this path, hoisted out of `watchFile` so a
   * re-arm can hand the SAME callback to the new handle. The callback re-reads
   * `watched.get(filePath)` on every event, so `suppressed`, `selfWrite` and a
   * pending `timer` all survive a re-arm untouched.
   */
  cb: fs.WatchListener<string>;
  /**
   * True once a `rename` has arrived for this path and the delivery that will
   * act on it has not run yet. On POSIX a `rename` means the inode may have
   * been replaced, so delivery re-arms; cleared on every delivery arm and by
   * `rearmWatch`.
   */
  sawRename: boolean;
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
 * Open an `fs.watch` handle for `filePath` and give it its `error` listener.
 * Used for the INITIAL arm and for every re-arm — a handle minted anywhere
 * else is a latent crash: `close()` emits `close`, never `error`, and does not
 * remove listeners, so a zero-listener `error` on an `FSWatcher` is an
 * `uncaughtException` → `index.ts` `handleFatalError` → `process.exit(1)`.
 *
 * Throws synchronously exactly as `fs.watch` does (ENOENT on a missing path,
 * EMFILE/ENOSPC when inotify's `max_user_watches` is exhausted). Every caller
 * wraps it in a TOTAL catch — an errno-narrowed one rethrows the commonest
 * Linux watcher failure into a context that cannot handle it.
 *
 * **The `error` handler identity-checks rather than detaching.** A handle this
 * module has already replaced can still emit; acting on that would `unwatchFile`
 * a live, freshly re-armed entry — #1749's own symptom with none of its signal.
 * This is also why `rearmWatch` and the delivery path STORE the new handle
 * before closing the old one: with `next` already in the map, a `close()`-adjacent
 * error on `old` fails the identity check and is discarded.
 */
function attachWatcher(filePath: string, cb: fs.WatchListener<string>): fs.FSWatcher {
  const handle = fs.watch(filePath, cb);
  handle.on("error", (err) => {
    if (watched.get(filePath)?.watcher !== handle) return;
    console.error("[FileWatcher] Watcher error for %s:", filePath, err);
    unwatchFile(filePath);
  });
  return handle;
}

/**
 * The watch for `filePath` is gone and cannot be restored in place: log, tell
 * the user ONCE, and drop the entry so a reopen can watch again (`watchFile`
 * early-returns on an existing entry).
 *
 * There is deliberately no "already notified" latch. The last act here is
 * `unwatchFile`, which deletes the map entry, so no later delivery for this
 * path can reach a notify site at all — the only route back is `watchFile`
 * minting a fresh entry, and a second lost watch after a reopen genuinely is a
 * second event worth reporting. `dedupKey` coalesces it client-side.
 */
function notifyWatchLost(filePath: string, err: unknown): void {
  console.error("[FileWatcher] Lost watch on %s (re-arm failed):", filePath, err);
  pushNotification({
    id: generateNotificationId(),
    type: "general-error",
    severity: "warning",
    message: `Tandem lost its watch on ${path.basename(filePath)}; external edits will not be detected until the file is reopened.`,
    dedupKey: `watch-lost:${filePath}`,
    timestamp: Date.now(),
  });
  unwatchFile(filePath);
}

/**
 * Replace `entry`'s handle with a fresh one for `filePath`, opening the new
 * handle BEFORE closing the old.
 *
 * Order is the whole design: a write landing between a `close()` and a later
 * `fs.watch` is seen by nobody, while an overlap can only double-deliver,
 * which the debounce coalesces. Storing before closing is what keeps `next`
 * reachable by `unwatchFile` — a handle that is neither stored nor closed
 * double-delivers for the life of the process — and what makes a
 * `close()`-adjacent error on `old` fail `attachWatcher`'s identity check.
 *
 * Returns false when the attach threw; the caller has already been notified
 * and the entry unwatched. Never throws: the two call sites are a `setTimeout`
 * body (whose rejection is an `unhandledRejection` → `process.exit(1)`) and a
 * `finally` inside `document-service`'s save (whose throw would return
 * `{status:"error"}` with the bytes already on disk).
 *
 * The `close()` guard is defence for a premise nobody has demonstrated —
 * Node 24 on win32 would not throw from double-close, close-after-unlink or
 * triple-close — but the precedent is `unwatchFile`'s own try/catch, and the
 * alternative to guarding is one of those two escapes.
 */
function swapHandle(filePath: string, entry: WatchEntry): boolean {
  let next: fs.FSWatcher;
  try {
    next = attachWatcher(filePath, entry.cb);
  } catch (err) {
    notifyWatchLost(filePath, err);
    return false;
  }
  const old = entry.watcher;
  entry.watcher = next;
  try {
    old.close();
  } catch (err) {
    console.error("[FileWatcher] watcher.close() failed for %s:", filePath, err);
  }
  return true;
}

/**
 * Start watching a file for changes. Calls `onChanged` (debounced 500ms)
 * when the file is modified externally.
 * No-op if the file is already being watched.
 */
export function watchFile(filePath: string, onChanged: (filePath: string) => Promise<void>): void {
  if (watched.has(filePath)) return;

  const cb: fs.WatchListener<string> = (eventType) => {
    const entry = watched.get(filePath);
    if (!entry) return;

    // Recorded BEFORE the suppression check. Belt-and-braces rather than
    // load-bearing: every site that arms a suppression is followed by
    // `rearmWatch` in a `finally`, which clears `sawRename` on every path. The
    // order is what stays correct if a future arming site lacks that pair.
    if (eventType === "rename") entry.sawRename = true;

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

      // The handle this delivery was scheduled against. Two deliveries are in
      // flight for one entry whenever a `stat` outlives the 500 ms debounce
      // (the line above nulls `timer`, so a new event schedules a fresh timer
      // while this continuation is pending), and a re-arm mutates
      // `entry.watcher` IN PLACE — it never replaces the entry. So the entry
      // re-check below cannot see a second kind of staleness, and the two
      // guards answer two different questions: the entry check asks "was the
      // entry replaced or removed", `armedAt` asks "did a newer delivery
      // already resolve this path".
      const armedAt = entry.watcher;

      let present: boolean;
      try {
        // ASYNC, explicitly. `existsSync`/`statSync` is a legal reading of
        // "stat the path" and makes every ordering guarantee below
        // unbuildable, because a synchronous call cannot be parked.
        await fs.promises.stat(filePath);
        present = true;
      } catch {
        present = false;
      }

      // Re-check identity after the await, on BOTH branches and before the
      // missing branch's notify as well as before any attach. `unwatchFile`
      // (tab close, rename) can delete the map entry mid-body; the
      // continuation would then attach a handle onto an orphaned closure
      // `entry` — reachable by nothing, alive for the process, and firing `cb`
      // on every later write next to whatever `watchFile` mints on reopen.
      // Everything from here to the content path is synchronous, so this one
      // check covers every branch.
      if (watched.get(filePath) !== entry) return;

      if (present) {
        if (!isWin32() && entry.sawRename) {
          if (!swapHandle(filePath, entry)) return;
        }
        entry.sawRename = false;
      } else if (isWin32()) {
        // The handle survived by construction; a recreate delivers
        // `rename, change` and the next delivery reads the new bytes. A
        // deletion here is not a lost watch, so: no notification, no unwatch,
        // and today's delete+recreate behaviour is preserved.
        entry.sawRename = false;
        console.error("[FileWatcher] %s is missing; handle retained (win32)", filePath);
        return;
      } else {
        // A re-arm since this delivery began means a LATER delivery already
        // found the file present, so this ENOENT verdict is stale — discard it
        // silently rather than firing a false "lost its watch" toast and
        // `unwatchFile`ing a live handle.
        //
        // The mirror ordering is the stated residual: a stale PRESENT verdict
        // re-arming while a later genuine ENOENT delivery has already captured
        // `armedAt` discards the real one. `swapHandle`'s total catch narrows
        // it — on a deleted file the stale-present attach throws and takes this
        // arm itself — so what is left is "deleted AGAIN after a successful
        // re-arm", which inotify re-delivers and the kqueue fallback may not.
        if (entry.watcher !== armedAt) return;
        // The file may have landed between the stat and this attach. If it
        // did, that successful handle IS the re-arm — never attach a second,
        // unstored probe handle, which `unwatchFile` could not reach.
        if (!swapHandle(filePath, entry)) return;
        entry.sawRename = false;
      }

      // Delivery-time content backstop: a write Tandem just made can leak a
      // `change` event past the arrival-time counter (NTFS fires ~2 events
      // per atomic rename; callers arm count=1). If the bytes on disk are
      // exactly what we wrote, skip the redundant reload + toast. Falls
      // through to reload on any mismatch — never swallows a real edit.
      //
      // `isSelfWriteEcho` is the body's other `await` and needs no identity
      // re-check of its own: it re-fetches `watched.get(filePath)` itself and
      // nothing after it touches `entry`. An edit that changes that needs a
      // third check.
      if (await isSelfWriteEcho(filePath)) return;
      onChanged(filePath).catch((err) => {
        console.error("[FileWatcher] onChanged callback failed for %s:", filePath, err);
      });
    }, 500);
  };

  let watcher: fs.FSWatcher;
  try {
    watcher = attachWatcher(filePath, cb);
  } catch (err) {
    console.error("[FileWatcher] Failed to watch %s:", filePath, err);
    return;
  }

  watched.set(filePath, {
    watcher,
    cb,
    sawRename: false,
    timer: null,
    suppressed: null,
    selfWrite: null,
  });
  console.error("[FileWatcher] Watching %s", filePath);
}

/**
 * Re-arm the watch for `filePath` after a Tandem self-write, POSIX only.
 *
 * On Linux Tandem's own `atomicWrite` is a tmp+rename, so it replaces the
 * inode and every self-write would otherwise kill its own watcher. On Windows
 * the handle survives by construction, so this is a no-op there and the
 * platform is read per call (see `isWin32`).
 *
 * **It clears the pending suppression.** When the self-write's own `rename` was
 * not delivered to the old handle before it closed — on Linux the ordinary
 * case, since the event is dropped with the inode — the counter would otherwise
 * survive for the full `SUPPRESS_TTL_MS` and swallow the NEXT event, which on
 * POSIX is an external atomic save arriving as `rename`: no debounce, no
 * delivery, no re-arm, handle on a dead inode, entry still in the map, nothing
 * ever notifying. That is #1749 reintroduced by its own fix.
 *
 * Clearing is safe ONLY because layer 2 is already armed when the new handle
 * goes up, so **`recordSelfWrite` MUST precede `rearmWatch`** — an invariant,
 * not a habit. On macOS FSEvents (latency-batched) the just-completed write can
 * surface on the NEW handle, and on Linux the write's SECOND `rename` reaches
 * the old handle and schedules a debounce timer on the same entry, which
 * survives this call (it clears `suppressed`/`sawRename`, not `timer`). The
 * fingerprint is the only thing between either and a reload.
 *
 * Two costs, both newly exposed: on POSIX every self-write echo now reaches the
 * timer, so `isSelfWriteEcho` reads the file once per save (the whole ZIP for a
 * `.docx`); and the fingerprint is TTL-bounded at 2 s while the debounce is
 * refreshable, so a sustained event stream can push delivery past `fp.until`
 * and reload the document's own bytes.
 *
 * No-op when the path is not watched. Never throws.
 */
export function rearmWatch(filePath: string): void {
  if (isWin32()) return;
  const entry = watched.get(filePath);
  if (!entry) return;
  if (!swapHandle(filePath, entry)) return;
  entry.suppressed = null;
  entry.sawRename = false;
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
