/**
 * #1299 — the doc-backup ACL bug, exercised END TO END with real `icacls`.
 *
 * Deliberately a separate file from `doc-backup.test.ts`, which mocks
 * `acl-win.js` at module scope and therefore cannot observe any of this. The
 * unit suite proves the toast; `acl-win.test.ts` proves the icacls primitive.
 * Neither proves the thing that actually matters to the reporter: that a
 * machine ALREADY poisoned by the old non-inheritable grant recovers by
 * running the fixed build, with nothing to delete by hand.
 *
 * That gap was real. The inheritable grant alone did not repair such a
 * machine: an empty DACL denies `readdir` (`EPERM … scandir`) just as it
 * denies `open`, so `listSnapshots` threw before the ACL was ever applied.
 * The repair only works because root hardening now precedes every READ of the
 * tree, not just the write.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { docHash } from "../../../src/server/annotations/doc-hash.js";
import {
  _resetDocBackupGateForTests,
  docBackupsRoot,
  snapshotBeforeFirstWrite,
  sweepDocBackups,
} from "../../../src/server/file-io/doc-backup.js";
import {
  assertPre1299PoisonTook,
  currentUserSid,
  normalizePre1299Poison,
  restoreAccessForCleanup,
} from "../../helpers/win-acl-fixture.js";

vi.mock("../../../src/server/notifications.js", () => ({ pushNotification: vi.fn() }));

const WIN_ONLY = process.platform === "win32";
const execFileAsync = promisify(execFile);
const systemBin = (name: string) =>
  path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);

describe.skipIf(!WIN_ONLY)("doc-backup — recovery from a pre-#1299 poisoned install", () => {
  let tmpDir: string;
  let appDataDir: string;
  let docPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-docbackup-acl-"));
    appDataDir = path.join(tmpDir, "app-data");
    docPath = path.join(tmpDir, "welcome.md");
    fs.writeFileSync(docPath, "# original bytes\n");
    _resetDocBackupGateForTests();
  });

  afterEach(async () => {
    // The subdir may still be un-listable if an assertion failed mid-test, and
    // an empty DACL defeats rm. Re-grant inheritably before cleaning up.
    const root = docBackupsRoot(appDataDir);
    if (fs.existsSync(root)) {
      await restoreAccessForCleanup(root, await currentUserSid());
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("snapshots successfully on an install whose subdir the old grant already bricked", async () => {
    const root = docBackupsRoot(appDataDir);
    const subdir = path.join(root, docHash(docPath));
    fs.mkdirSync(subdir, { recursive: true });

    // Reproduce the pre-fix state verbatim: the OLD non-inheritable grant on
    // the root, applied while the per-path subdir already exists.
    const sid = await currentUserSid();
    await execFileAsync(systemBin("icacls.exe"), [root, "/inheritance:r", "/grant:r", `*${sid}:F`]);
    // ...then pin the resulting root DACL, because `/inheritance:r` removes
    // inherited ACEs on Windows 11 but merely converts them on GitHub's
    // Server 2025 image, where the converted `(OI)(CI)` entries propagate back
    // down and un-poison the subdir (#1529).
    await normalizePre1299Poison(root, sid);

    // Positive control that the poison took — without this the test would
    // pass just as well against a healthy tree and prove nothing. It throws
    // rather than skipping: a fixture that cannot poison proves nothing either.
    await assertPre1299PoisonTook(root, subdir);
    expect(() => fs.readdirSync(subdir)).toThrow(/EPERM/);

    const outcome = await snapshotBeforeFirstWrite(docPath, { appDataDir, documentId: "d1" });

    expect(outcome).toBe("written");
    const written = fs.readdirSync(subdir).filter((n) => n.startsWith("welcome-"));
    expect(written).toHaveLength(1);
    expect(fs.readFileSync(path.join(subdir, written[0]), "utf8")).toBe("# original bytes\n");
  });

  /**
   * #1433 — the same recovery, reached from the BOOT SWEEP instead of a save.
   *
   * This is the case the v0.21.0 fix missed: the repair hung off
   * `snapshotBeforeFirstWrite`, so a run that never overwrote a document never
   * reached it. On an upgrade that is guaranteed — Tandem auto-opens
   * `CHANGELOG.md` read-only — so the sweep hit the poisoned folder on every
   * boot, logged `EPERM … scandir`, and moved on with no route to recovery.
   *
   * Only the real `icacls` can prove the inheritable re-grant actually
   * propagates into an existing empty-DACL child; the vitest suite mocks the
   * ACL helper and can only prove the plumbing around it.
   */
  it("sweeps an expired snapshot out of a subdir the old grant already bricked", async () => {
    const root = docBackupsRoot(appDataDir);
    const subdir = path.join(root, docHash(docPath));
    fs.mkdirSync(subdir, { recursive: true });

    // Ordering is forced: the snapshot and its backdated mtime must exist
    // BEFORE the empty DACL lands. Afterwards neither the write nor the
    // `utimes` is permitted, so the poison cannot be applied first.
    const expired = path.join(subdir, "old-20250101-000000-aabbccdd.md");
    fs.writeFileSync(expired, "ancient\n");
    fs.writeFileSync(path.join(subdir, "source.txt"), `${docPath}\n`);
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(expired, longAgo, longAgo);

    // The pre-fix state verbatim: the OLD non-inheritable grant on the root,
    // applied while the per-path subdir already exists.
    const sid = await currentUserSid();
    await execFileAsync(systemBin("icacls.exe"), [root, "/inheritance:r", "/grant:r", `*${sid}:F`]);

    // Positive control — without it this passes against a healthy tree.
    expect(() => fs.readdirSync(subdir)).toThrow(/EPERM/);

    const result = await sweepDocBackups(appDataDir);

    expect(result).toEqual({ cleaned: 1, failed: 0 });
    // Emptied of live snapshots, so the sweep removed source.txt and the dir.
    expect(fs.existsSync(subdir)).toBe(false);
  });
});
