/**
 * The file watcher against a REAL temp directory and the real OS (#1749).
 *
 * `file-watcher.test.ts` mocks `fs.watch` and `fs.promises.stat`, and every
 * path it uses is fake. That is the right place to pin ordering, handle
 * identity and the platform branches — and precisely the wrong place to pin
 * #1749, whose bug IS the OS semantics the mock replaces: on Linux
 * `fs.watch(path)` watches the INODE, so a tmp+rename atomic save leaves the
 * handle on an unlinked file forever, while on Windows the same call is
 * `ReadDirectoryChangesW` on the parent directory filtered by name and the
 * handle survives delete+recreate.
 *
 * Expectations therefore branch on `process.platform`, and the reason is stated
 * at each branch. CI's ubuntu `check` job is the Linux evidence; a local run is
 * the Windows evidence.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWrite } from "../../src/server/file-io/index.js";
import {
  rearmWatch,
  recordSelfWrite,
  suppressNextChange,
  unwatchAll,
  unwatchFile,
  watchedCount,
  watchFile,
} from "../../src/server/file-watcher.js";
import { getBuffer, resetForTesting } from "../../src/server/notifications.js";

const IS_WIN = process.platform === "win32";

/** Comfortably past the 500 ms debounce, with slack for a loaded CI runner. */
const SETTLE_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let file: string;

/** Replace `file` the way every atomic-saving editor does: write a sibling
 *  temp, then rename it over the target. This is the write that kills an
 *  inode-bound watcher. */
function externalAtomicReplace(content: string): void {
  const tmp = path.join(dir, `.ext-tmp-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function lostWatchNotifications(target: string) {
  return getBuffer().filter((n) => n.dedupKey === `watch-lost:${target}`);
}

beforeEach(() => {
  resetForTesting();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-watch-realfs-"));
  file = path.join(dir, "doc.md");
  fs.writeFileSync(file, "v1\n");
});

afterEach(() => {
  unwatchAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("file watcher against the real filesystem", () => {
  it("(1) sees an external atomic replace, TWICE in a row", async () => {
    // The second replace is the one a dead watcher misses: before #1749 the
    // first `rename` was dropped at arrival AND (on Linux) took the inode with
    // it, so every later external edit was invisible — no conflict banner, and
    // the next Tandem save silently overwrote the user's edit.
    const seen: string[] = [];
    const onChanged = vi.fn(async (p: string) => {
      seen.push(fs.readFileSync(p, "utf-8"));
    });
    watchFile(file, onChanged);

    externalAtomicReplace("v2 external\n");
    await sleep(SETTLE_MS);
    expect(seen).toEqual(["v2 external\n"]);

    externalAtomicReplace("v3 external\n");
    await sleep(SETTLE_MS);
    expect(seen).toEqual(["v2 external\n", "v3 external\n"]);
  }, 20000);

  it("(2) does not fire for a Tandem self-write, and still sees the next external edit", async () => {
    const onChanged = vi.fn(async () => {});
    watchFile(file, onChanged);

    // The full triple in the order every write site uses. `recordSelfWrite`
    // MUST precede `rearmWatch`: the re-arm clears the arrival counter, so on
    // POSIX the fingerprint is the only layer left.
    const content = "tandem wrote this\n";
    try {
      suppressNextChange(file);
      await atomicWrite(file, content);
      recordSelfWrite(file, content);
    } finally {
      rearmWatch(file);
    }
    await sleep(SETTLE_MS);
    expect(onChanged).not.toHaveBeenCalled();
    expect(watchedCount()).toBe(1);

    externalAtomicReplace("someone else wrote this\n");
    await sleep(SETTLE_MS);
    expect(onChanged).toHaveBeenCalledTimes(1);
  }, 20000);

  it("(3) survives delete-then-recreate inside the debounce window", async () => {
    // The case the arrival-time-verdict design would have failed on Windows:
    // the first `rename` of a delete-then-write resolves as ENOENT well before
    // the recreate lands, so any existence verdict taken at arrival is a coin
    // flip. Taking it at delivery, after the debounce, gets the right answer on
    // both platforms.
    const seen: string[] = [];
    const onChanged = vi.fn(async (p: string) => {
      seen.push(fs.readFileSync(p, "utf-8"));
    });
    watchFile(file, onChanged);

    fs.unlinkSync(file);
    await sleep(200); // inside the 500 ms debounce
    fs.writeFileSync(file, "recreated\n");
    await sleep(SETTLE_MS);

    expect(seen).toEqual(["recreated\n"]);
    expect(lostWatchNotifications(file)).toHaveLength(0);
    expect(watchedCount()).toBe(1);
  }, 20000);

  it("(4) reports a lost watch on POSIX when the file is deleted and not recreated", async () => {
    const onChanged = vi.fn(async () => {});
    watchFile(file, onChanged);

    fs.unlinkSync(file);
    await sleep(SETTLE_MS);

    if (IS_WIN) {
      // The handle is `ReadDirectoryChangesW` on the parent, so it is alive and
      // a deletion is not a lost watch. No notification, entry retained, and a
      // later recreate + write still delivers.
      expect(lostWatchNotifications(file)).toHaveLength(0);
      expect(watchedCount()).toBe(1);

      fs.writeFileSync(file, "back again\n");
      await sleep(SETTLE_MS);
      expect(onChanged).toHaveBeenCalled();
      return;
    }

    // POSIX: the inode is gone and cannot be re-armed, so exactly one
    // notification and the entry dropped — the drop is what lets a reopen
    // re-watch, since `watchFile` early-returns on an existing entry.
    expect(lostWatchNotifications(file)).toHaveLength(1);
    expect(watchedCount()).toBe(0);
    // A missing file must NOT reach the content path: `reloadFromDisk` would
    // fail its read and produce a false "Failed to reload" toast on a clean
    // doc, or a stuck `external-edit` conflict with saves refused on a dirty one.
    expect(onChanged).not.toHaveBeenCalled();

    // There is deliberately no "already notified" latch, and this half is what
    // proves the ENOENT arm REALLY unwatches: an arm that notifies without
    // unwatching leaves the stale entry, `watchFile` early-returns on it, and
    // this second delete would notify nothing.
    fs.writeFileSync(file, "back again\n");
    watchFile(file, onChanged);
    expect(watchedCount()).toBe(1);
    fs.unlinkSync(file);
    await sleep(SETTLE_MS);
    expect(lostWatchNotifications(file)).toHaveLength(2);
    expect(watchedCount()).toBe(0);
  }, 30000);

  it("reports the observed eventType sequence for the PR body", async () => {
    // Not an assertion about shape — a recording, because the three places in
    // this repo that CLAIMED a shape ("NTFS fires ~2 change events per atomic
    // rename") were all wrong. The only assertion is that SOMETHING arrives for
    // each write; the sequence itself is printed.
    const events: string[] = [];
    const handle = fs.watch(file, (ev) => events.push(ev));
    try {
      fs.writeFileSync(file, "in place\n");
      await sleep(300);
      const inPlace = events.splice(0);

      externalAtomicReplace("atomic\n");
      await sleep(300);
      const atomic = events.splice(0);

      fs.unlinkSync(file);
      await sleep(300);
      const deleted = events.splice(0);

      fs.writeFileSync(file, "recreated\n");
      await sleep(300);
      const recreated = events.splice(0);

      console.error(
        "[#1749 event shapes] platform=%s node=%s in-place=%o atomic-replace=%o delete=%o recreate=%o",
        process.platform,
        process.version,
        inPlace,
        atomic,
        deleted,
        recreated,
      );
      expect(inPlace.length).toBeGreaterThan(0);
      expect(atomic.length).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  }, 20000);

  it("unwatchFile still stops delivery after a re-arm", () => {
    // `rearmWatch` replaces `entry.watcher` IN PLACE, so the new handle stays
    // reachable by `unwatchFile`. A probe handle that were neither stored nor
    // closed would double-deliver for the life of the process.
    watchFile(
      file,
      vi.fn(async () => {}),
    );
    rearmWatch(file);
    expect(watchedCount()).toBe(1);
    unwatchFile(file);
    expect(watchedCount()).toBe(0);
  });
});
