import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetDocBackupGateForTests,
  describeSnapshotFailure,
  docBackupsRoot,
  MAX_DOC_BACKUPS,
  sanitizeBackupStem,
  snapshotBeforeFirstWrite,
  snapshotFilename,
  sweepDocBackups,
} from "../../../src/server/file-io/doc-backup.js";

// Notifications buffer + SSE fan-out are irrelevant here; capture calls instead.
vi.mock("../../../src/server/notifications.js", () => ({
  pushNotification: vi.fn(),
}));
// The Windows ACL helper spawns icacls/whoami — not something unit tests should do.
vi.mock("../../../src/server/integrations/acl-win.js", () => ({
  setRestrictiveAcl: vi.fn().mockResolvedValue(undefined),
}));

import { setRestrictiveAcl } from "../../../src/server/integrations/acl-win.js";
import { pushNotification } from "../../../src/server/notifications.js";

const pushNotificationMock = vi.mocked(pushNotification);
const setRestrictiveAclMock = vi.mocked(setRestrictiveAcl);

describe("doc-backup", () => {
  let root: string;
  let appDataDir: string;
  let docPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tandem-doc-backup-"));
    appDataDir = join(root, "app-data");
    mkdirSync(appDataDir, { recursive: true });
    docPath = join(root, "docs", "thesis.md");
    mkdirSync(join(root, "docs"), { recursive: true });
    _resetDocBackupGateForTests();
    pushNotificationMock.mockClear();
    // The ACL mock is module-scope and this config sets neither `clearMocks`
    // nor `restoreMocks`, so its call history would otherwise accumulate across
    // tests. Invisible until a test fakes win32 (on linux the helper returns
    // before calling), which the #1299 sweep tests below do — and their whole
    // point is a call COUNT. Reset, then restore the resolved value that
    // `vi.restoreAllMocks()` strips.
    setRestrictiveAclMock.mockReset();
    setRestrictiveAclMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** All snapshot files (non-source.txt) across every per-path subdir. */
  function allSnapshots(): Array<{ subdir: string; name: string; content: string }> {
    const backupRoot = docBackupsRoot(appDataDir);
    const out: Array<{ subdir: string; name: string; content: string }> = [];
    let subdirs: string[];
    try {
      subdirs = readdirSync(backupRoot);
    } catch {
      return out;
    }
    for (const sub of subdirs) {
      for (const name of readdirSync(join(backupRoot, sub))) {
        if (name === "source.txt") continue;
        out.push({ subdir: sub, name, content: readFileSync(join(backupRoot, sub, name), "utf8") });
      }
    }
    return out;
  }

  describe("snapshotBeforeFirstWrite", () => {
    it("snapshots the pre-existing on-disk bytes on first write", async () => {
      writeFileSync(docPath, "original content\n");

      const outcome = await snapshotBeforeFirstWrite(docPath, { appDataDir });

      expect(outcome).toBe("written");
      const snaps = allSnapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0].content).toBe("original content\n");
      expect(snaps[0].name).toMatch(/^thesis-\d{8}-\d{6}-[0-9a-f]{8}\.md$/);
      const sourceTxt = readFileSync(
        join(docBackupsRoot(appDataDir), snaps[0].subdir, "source.txt"),
        "utf8",
      );
      expect(sourceTxt).toBe(`${docPath}\n`);
    });

    it("skips the second save of the same path in the same run", async () => {
      writeFileSync(docPath, "original content\n");
      await snapshotBeforeFirstWrite(docPath, { appDataDir });
      writeFileSync(docPath, "tandem output\n");

      const outcome = await snapshotBeforeFirstWrite(docPath, { appDataDir });

      expect(outcome).toBe("skipped-already-this-run");
      expect(allSnapshots()).toHaveLength(1);
    });

    it("skips silently when the file does not exist yet, and gates the path", async () => {
      expect(await snapshotBeforeFirstWrite(docPath, { appDataDir })).toBe("skipped-no-source");
      // A later save in the same run only ever overwrites Tandem's own output.
      writeFileSync(docPath, "tandem output\n");
      expect(await snapshotBeforeFirstWrite(docPath, { appDataDir })).toBe(
        "skipped-already-this-run",
      );
      expect(allSnapshots()).toHaveLength(0);
    });

    it("skips when on-disk bytes equal the newest snapshot (restart, no external edit)", async () => {
      writeFileSync(docPath, "original content\n");
      await snapshotBeforeFirstWrite(docPath, { appDataDir });
      _resetDocBackupGateForTests(); // simulate a new server run

      const outcome = await snapshotBeforeFirstWrite(docPath, { appDataDir });

      expect(outcome).toBe("skipped-identical");
      expect(allSnapshots()).toHaveLength(1);
    });

    it("writes a new snapshot across runs when content changed, pruning beyond the cap", async () => {
      for (let i = 0; i < MAX_DOC_BACKUPS + 2; i++) {
        writeFileSync(docPath, `version ${i}\n`);
        _resetDocBackupGateForTests();
        // Distinct mtime-second timestamps aren't guaranteed fast in a loop,
        // but the uuid8 suffix keeps names unique; sort ties are fine.
        expect(await snapshotBeforeFirstWrite(docPath, { appDataDir })).toBe("written");
      }

      const snaps = allSnapshots();
      expect(snaps).toHaveLength(MAX_DOC_BACKUPS);
      // The newest content always survives the prune.
      expect(snaps.map((s) => s.content)).toContain(`version ${MAX_DOC_BACKUPS + 1}\n`);
    });

    it("skips and notifies once when the total-size cap is exceeded", async () => {
      // Cap of 15: the first 10-byte snapshot fits, the second would push the
      // tree to 20 — exercising the exceeded-AFTER-some-writes branch, not
      // just "cap smaller than any single file".
      writeFileSync(docPath, "0123456789");
      const otherPath = join(root, "docs", "other.md");
      writeFileSync(otherPath, "0123456789");

      const first = await snapshotBeforeFirstWrite(docPath, { appDataDir, maxTotalBytes: 15 });
      const second = await snapshotBeforeFirstWrite(otherPath, { appDataDir, maxTotalBytes: 15 });
      const third = await snapshotBeforeFirstWrite(otherPath, { appDataDir, maxTotalBytes: 15 });

      expect(first).toBe("written");
      expect(second).toBe("skipped-size-cap");
      expect(third).toBe("skipped-already-this-run");
      expect(allSnapshots()).toHaveLength(1);
      expect(pushNotificationMock).toHaveBeenCalledTimes(1);
      expect(pushNotificationMock.mock.calls[0][0]).toMatchObject({
        dedupKey: "doc-backup:size-cap",
        severity: "warning",
      });
    });

    it("returns failed (never throws), notifies once, and retries on the next save", async () => {
      writeFileSync(docPath, "original content\n");
      // A FILE at the doc-backups root makes every mkdir of a subdir fail.
      writeFileSync(docBackupsRoot(appDataDir), "not a directory");

      const first = await snapshotBeforeFirstWrite(docPath, { appDataDir, documentId: "doc-1" });
      expect(first).toBe("failed");
      expect(pushNotificationMock).toHaveBeenCalledTimes(1);
      const notification = pushNotificationMock.mock.calls[0][0];
      expect(notification).toMatchObject({ documentId: "doc-1", severity: "warning" });

      // #1299: the toast is a user-facing surface, so it names the document by
      // BASENAME and carries nothing else from the error. Node fs errors
      // serialize as `EPERM: operation not permitted, open '<abs path>'` —
      // pasting that in put a stack-trace-shaped string and the user's home
      // directory on screen. The errno survives as structured data instead.
      expect(notification.message).toContain("thesis.md");
      expect(notification.message).not.toMatch(/\bE[A-Z]{2,}\b/);
      expect(notification.message).not.toContain(appDataDir);
      expect(notification.message).not.toContain(root);
      expect(notification.errorCode).toMatch(/^E[A-Z]+$/);

      // A second failure on the same path retries but does NOT re-notify —
      // the 60s autosave loop would otherwise toast every minute.
      const stillFailing = await snapshotBeforeFirstWrite(docPath, { appDataDir });
      expect(stillFailing).toBe("failed");
      expect(pushNotificationMock).toHaveBeenCalledTimes(1);

      // Clear the obstruction — the gate was NOT set, so the next save retries.
      rmSync(docBackupsRoot(appDataDir));
      const second = await snapshotBeforeFirstWrite(docPath, { appDataDir });
      expect(second).toBe("written");
      expect(allSnapshots()).toHaveLength(1);
    });

    it("snapshots an existing victim file on a Save-As collision path", async () => {
      // Same entry point the save-as call site uses: target exists with
      // content Tandem never produced.
      const victim = join(root, "docs", "existing-notes.md");
      writeFileSync(victim, "the victim's irreplaceable notes\n");

      const outcome = await snapshotBeforeFirstWrite(victim, { appDataDir });

      expect(outcome).toBe("written");
      expect(allSnapshots()[0].content).toBe("the victim's irreplaceable notes\n");
    });
  });

  describe("describeSnapshotFailure", () => {
    it.each([
      { code: "EPERM", match: /permission/i, why: "the #1299 report's own errno" },
      { code: "EACCES", match: /permission/i, why: "POSIX twin of EPERM" },
      { code: "ENOSPC", match: /disk space/i, why: "actionable: free space" },
      { code: "EROFS", match: /read-only/i, why: "actionable: wrong volume" },
      { code: "EBUSY", match: /locked by another program/i, why: "actionable: close it" },
    ])("maps $code to an actionable clause ($why)", ({ code, match }) => {
      expect(describeSnapshotFailure(Object.assign(new Error("boom"), { code }))).toMatch(match);
    });

    it("contributes no clause for an unmapped or non-errno failure", () => {
      // A guessed cause is worse than none — the errno still rides on the
      // notification's `errorCode` and the full error is on stderr.
      expect(describeSnapshotFailure(new Error("something odd"))).toBe("");
      expect(describeSnapshotFailure(undefined)).toBe("");
    });

    it("never returns the raw error message", () => {
      const err = Object.assign(
        new Error("EPERM: operation not permitted, open 'C:\\Users\\Akapl\\AppData\\Local\\x.md'"),
        { code: "EPERM" },
      );
      const described = describeSnapshotFailure(err);
      expect(described).not.toContain("EPERM");
      expect(described).not.toContain("C:\\Users");
    });
  });

  describe("sanitizeBackupStem", () => {
    it.each([
      { input: "thesis", expected: "thesis", why: "clean names pass through" },
      { input: "CON", expected: "doc-CON", why: "Windows reserved device stem" },
      { input: "con.tar", expected: "doc-con.tar", why: "reserved stem before FIRST dot" },
      { input: "notes ", expected: "notes", why: "Windows strips trailing spaces" },
      { input: "notes..", expected: "notes", why: "Windows strips trailing dots" },
      { input: "a/b\\c", expected: "a_b_c", why: "separators can't escape the subdir" },
      { input: 'we<>:"|?*ird', expected: "we_______ird", why: "Windows-illegal chars" },
      { input: "x".repeat(80), expected: "x".repeat(40), why: "length cap" },
      { input: "", expected: "doc", why: "empty falls back to a generic stem" },
      { input: "...", expected: "doc", why: "dot-only collapses to empty then falls back" },
      { input: "tab\tname", expected: "tab_name", why: "C0 control characters" },
    ])("sanitizes $input ($why)", ({ input, expected }) => {
      expect(sanitizeBackupStem(input)).toBe(expected);
    });
  });

  describe("snapshotFilename", () => {
    it("embeds the sanitized stem, a sortable timestamp, and the extension", () => {
      // Bare basename — a `C:\...` literal would parse as a single basename on
      // POSIX CI and a path on Windows, making the assertion platform-split.
      const name = snapshotFilename("CON.md", new Date(2026, 5, 9, 14, 15, 0));
      expect(name).toMatch(/^doc-CON-20260609-141500-[0-9a-f]{8}\.md$/);
    });
  });

  describe("sweepDocBackups", () => {
    it("removes expired snapshots and empty subdirs, keeps fresh ones and strays", async () => {
      writeFileSync(docPath, "original content\n");
      await snapshotBeforeFirstWrite(docPath, { appDataDir });

      const freshSub = allSnapshots()[0].subdir;
      const backupRoot = docBackupsRoot(appDataDir);

      // Second subdir holding only an expired snapshot + source.txt.
      const expiredSub = join(backupRoot, "deadbeef");
      mkdirSync(expiredSub, { recursive: true });
      const expired = join(expiredSub, "old-20250101-000000-aabbccdd.md");
      writeFileSync(expired, "ancient\n");
      writeFileSync(join(expiredSub, "source.txt"), "/gone/old.md\n");
      const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      await fs.utimes(expired, old, old);

      // Third subdir holding only a stray non-snapshot file — never touched.
      const straySub = join(backupRoot, "cafebabe");
      mkdirSync(straySub, { recursive: true });
      writeFileSync(join(straySub, "unrelated.bin"), "leave me alone");

      const result = await sweepDocBackups(appDataDir);

      expect(result).toMatchObject({ cleaned: 1, failed: 0 });
      // "deadbeef" (expired) is gone; the fresh subdir and the stray survive.
      expect(readdirSync(backupRoot).sort()).toEqual(["cafebabe", freshSub].sort());
      expect(readdirSync(straySub)).toEqual(["unrelated.bin"]);
    });

    it("is silent and safe when the backup root does not exist", async () => {
      await expect(sweepDocBackups(appDataDir)).resolves.toEqual({ cleaned: 0, failed: 0 });
    });
  });

  /**
   * #1433 — the boot sweep must ATTEMPT the #1299 ACL repair, not log and give up.
   *
   * The repair itself shipped in v0.21.0 but hangs off `snapshotBeforeFirstWrite`
   * only, so an install that runs without saving a document never reaches it —
   * which on an UPGRADE is guaranteed, because Tandem auto-opens `CHANGELOG.md`
   * read-only precisely so autosave cannot round-trip it.
   *
   * `setRestrictiveAcl` is mocked at module scope, so nothing here spawns icacls;
   * the real-icacls proof lives in `doc-backup-acl-repair.test.ts` (Windows-only).
   * EPERM is INJECTED rather than produced with `chmod 0o000`: CI and the dev
   * container run as uid 0, where an unreadable directory is still readable and
   * the test would silently prove nothing.
   */
  describe("sweepDocBackups — #1299 ACL self-repair", () => {
    let prevPlatform: PropertyDescriptor | undefined;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    /** EPERM is what Windows reports for a #1299 empty-DACL directory. */
    const permError = (code: "EPERM" | "EACCES") =>
      Object.assign(new Error(`${code}: operation not permitted, scandir`), { code });

    /** Run the module's Windows-only branches on a POSIX host. Restored in afterEach. */
    function fakeWindows(): void {
      prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    }

    /**
     * Fail `readdir` for exactly one directory, delegating everything else to the
     * real implementation.
     *
     * Path-predicate, NOT call-order (`mockRejectedValueOnce`): `sweepDocBackups`
     * reads the ROOT before any subdir, so an order-based mock aims at the wrong
     * branch — and with no base implementation its second call returns
     * `undefined`, which flows into the `for (const sub of subdirs)` loop
     * OUTSIDE the try/catch and makes the sweep reject, violating its own
     * never-throws contract.
     *
     * `real` is captured BEFORE spying, and the options argument is forwarded:
     * `readdir` is called both with `{ withFileTypes: true }` and bare, and
     * dropping the options returns strings whose `.isDirectory()` is undefined.
     * (Delegation pattern: the `unlink` test in `tests/server/reaper.test.ts`.)
     */
    function poisonReaddir(
      targets: string | string[],
      opts: { persistent?: boolean; code?: "EPERM" | "EACCES" } = {},
    ): () => number {
      const set = new Set(Array.isArray(targets) ? targets : [targets]);
      const alreadyFailed = new Set<string>();
      const real = fs.readdir.bind(fs);
      let hits = 0;
      vi.spyOn(fs, "readdir").mockImplementation((async (p: string, o: unknown) => {
        const key = String(p);
        if (set.has(key) && (opts.persistent || !alreadyFailed.has(key))) {
          alreadyFailed.add(key);
          hits++;
          throw permError(opts.code ?? "EPERM");
        }
        return real(p as never, o as never);
      }) as unknown as typeof fs.readdir);
      return () => hits;
    }

    /** A per-path subdir holding one expired snapshot + its `source.txt`. */
    function makeExpiredSubdir(name: string): string {
      const sub = join(docBackupsRoot(appDataDir), name);
      mkdirSync(sub, { recursive: true });
      const snapshot = join(sub, "old-20250101-000000-aabbccdd.md");
      writeFileSync(snapshot, "ancient\n");
      writeFileSync(join(sub, "source.txt"), "/gone/old.md\n");
      const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      utimesSync(snapshot, longAgo, longAgo);
      return sub;
    }

    beforeEach(() => {
      // Keep the suite output readable; the repair path logs by design.
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      if (prevPlatform) Object.defineProperty(process, "platform", prevPlatform);
      prevPlatform = undefined;
      // Releases the `readdir` and `console.error` spies. Also strips the ACL
      // mock's resolved value, which the outer `beforeEach` re-applies.
      vi.restoreAllMocks();
    });

    it("A: an ACL failure stays invisible to snapshotBeforeFirstWrite (best-effort contract)", async () => {
      fakeWindows();
      setRestrictiveAclMock.mockRejectedValue(new Error("icacls: access is denied"));
      writeFileSync(docPath, "original content\n");

      // The snapshot must succeed and stay silent: an ACL failure is hygiene,
      // not a reason to fail the backup or toast the user. If the repair's
      // promise is ever memoised WITHOUT the try/catch inside the memoised
      // wrapper, this rejection reaches `snapshotBeforeFirstWrite`'s outer
      // catch — which returns "failed", toasts, and leaves the gate unset so
      // every 60s autosave retries and re-fails. (It does NOT escape to
      // `unhandledRejection`: every `aclPromise ??=` is followed by `await
      // aclPromise` in the same synchronous run, so a handler is always
      // attached, and `index.ts` puts a `.catch()` on the sweep besides.)
      await expect(snapshotBeforeFirstWrite(docPath, { appDataDir })).resolves.toBe("written");
      expect(pushNotificationMock).not.toHaveBeenCalled();
      expect(allSnapshots()).toHaveLength(1);

      // The per-run gate must be SET despite the ACL failure: this counted as a
      // success, so the next save must not redo it.
      await expect(snapshotBeforeFirstWrite(docPath, { appDataDir })).resolves.toBe(
        "skipped-already-this-run",
      );

      // Assert the CONTENT, not merely that console.error ran: the snapshot
      // logs its own success through console.error, so a bare
      // `toHaveBeenCalled()` here passes even if the ACL failure is swallowed
      // silently.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Restrictive ACL on backup root failed"),
        expect.anything(),
      );
    });

    it("A2: an ACL repair that itself fails leaves the sweep best-effort, and says so", async () => {
      fakeWindows();
      setRestrictiveAclMock.mockRejectedValue(new Error("icacls: access is denied"));
      const poisoned = makeExpiredSubdir("deadbeef");
      poisonReaddir(poisoned, { persistent: true });

      // Both halves fail — the folder is unreadable AND the repair cannot fix
      // it. This is the combination the reporter's install may actually be in,
      // and the sweep must still complete rather than throw.
      await expect(sweepDocBackups(appDataDir)).resolves.toEqual({ cleaned: 0, failed: 0 });

      // ...and must NOT claim a repair happened.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("could not be repaired"));
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("after repairing folder permissions"),
      );
      expect(existsSync(poisoned)).toBe(true);
    });

    it("B1: repairs a poisoned per-path SUBDIR and re-reads it", async () => {
      fakeWindows();
      const poisoned = makeExpiredSubdir("deadbeef");
      const hits = poisonReaddir(poisoned);

      const result = await sweepDocBackups(appDataDir);

      expect(setRestrictiveAclMock).toHaveBeenCalledWith(docBackupsRoot(appDataDir), {
        inheritable: true,
      });
      expect(hits()).toBe(1);
      // `cleaned: 1` is what proves the RETRY rather than merely the repair
      // call: an implementation that re-applies the ACL and then `continue`s
      // yields `cleaned: 0` with the ACL mock called just the same.
      expect(result).toEqual({ cleaned: 1, failed: 0 });
      // Emptied of live snapshots, so the sweep also removed the subdir.
      expect(existsSync(poisoned)).toBe(false);
    });

    it("B2: repairs a poisoned backup ROOT and re-reads it", async () => {
      fakeWindows();
      const backupRoot = docBackupsRoot(appDataDir);
      const poisoned = makeExpiredSubdir("deadbeef");
      const hits = poisonReaddir(backupRoot);

      const result = await sweepDocBackups(appDataDir);

      expect(setRestrictiveAclMock).toHaveBeenCalledWith(backupRoot, { inheritable: true });
      expect(hits()).toBe(1);
      expect(result).toEqual({ cleaned: 1, failed: 0 });
      expect(existsSync(poisoned)).toBe(false);
    });

    it("B3: a ROOT still unreadable after the repair resolves rather than throwing", async () => {
      fakeWindows();
      makeExpiredSubdir("deadbeef");
      poisonReaddir(docBackupsRoot(appDataDir), { persistent: true });

      // `sweepDocBackups` is fired un-awaited, so an unwrapped retry would
      // reject past its "never throws" contract into the caller's `.catch()`.
      await expect(sweepDocBackups(appDataDir)).resolves.toEqual({ cleaned: 0, failed: 0 });
      expect(setRestrictiveAclMock).toHaveBeenCalledTimes(1);
    });

    it("C: a SUBDIR still unreadable after the repair is skipped, siblings still swept", async () => {
      fakeWindows();
      const poisoned = makeExpiredSubdir("deadbeef");
      const healthy = makeExpiredSubdir("cafebabe");
      poisonReaddir(poisoned, { persistent: true });

      await expect(sweepDocBackups(appDataDir)).resolves.toEqual({ cleaned: 1, failed: 0 });
      expect(existsSync(healthy)).toBe(false);
      expect(existsSync(poisoned)).toBe(true);

      // The log must name what happened. Without this the whole three-branch
      // `logUnreadable` can be replaced by the noisy pre-fix line — the half of
      // #1433 about the per-boot stack trace — with every test still green.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("still unreadable after repairing folder permissions"),
      );
    });

    it("C2: a second poisoned subdir reports the ONE repair, not a repair of its own", async () => {
      fakeWindows();
      writeFileSync(docPath, "original content\n");
      // The snapshot applies the ACL first, so the sweep's own call finds the
      // memo already settled.
      await snapshotBeforeFirstWrite(docPath, { appDataDir });
      const poisoned = makeExpiredSubdir("deadbeef");
      poisonReaddir(poisoned, { persistent: true });

      await expect(sweepDocBackups(appDataDir)).resolves.toEqual({ cleaned: 0, failed: 0 });

      expect(setRestrictiveAclMock).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("already repaired once this run"),
      );
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("still unreadable after repairing folder permissions"),
      );
    });

    it("D: spawns the ACL repair at most once per run", async () => {
      fakeWindows();
      const first = makeExpiredSubdir("deadbeef");
      const second = makeExpiredSubdir("cafebabe");
      poisonReaddir([first, second]);
      writeFileSync(docPath, "original content\n");

      await sweepDocBackups(appDataDir);

      // One application covers BOTH poisoned subdirs: the grant lands on the
      // root and Windows propagates it down. (Zero on unfixed code.)
      expect(setRestrictiveAclMock).toHaveBeenCalledTimes(1);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(false);

      // ...and the snapshot path awaits that same settled application instead
      // of spawning icacls again. This half is what pins the latch.
      await expect(snapshotBeforeFirstWrite(docPath, { appDataDir })).resolves.toBe("written");
      expect(setRestrictiveAclMock).toHaveBeenCalledTimes(1);
    });

    it("E: attempts no ACL repair on non-Windows", async () => {
      // Deliberately NOT fakeWindows(): there is no DACL to re-apply on POSIX,
      // `icacls` does not exist there, and EACCES is the POSIX spelling.
      const poisoned = makeExpiredSubdir("deadbeef");
      poisonReaddir(poisoned, { persistent: true, code: "EACCES" });

      await expect(sweepDocBackups(appDataDir)).resolves.toEqual({ cleaned: 0, failed: 0 });
      expect(setRestrictiveAclMock).not.toHaveBeenCalled();
      expect(existsSync(poisoned)).toBe(true);
    });

    it("F: a missing backup root is still a silent early return — no repair, no mkdir", async () => {
      fakeWindows();
      const backupRoot = docBackupsRoot(appDataDir);
      expect(existsSync(backupRoot)).toBe(false);

      await expect(sweepDocBackups(appDataDir)).resolves.toEqual({ cleaned: 0, failed: 0 });

      expect(setRestrictiveAclMock).not.toHaveBeenCalled();
      // Hardening unconditionally at the top of the sweep — the tempting
      // simplification — would mkdir the root on every boot of every install,
      // including ones that never back anything up.
      expect(existsSync(backupRoot)).toBe(false);
    });
  });
});
