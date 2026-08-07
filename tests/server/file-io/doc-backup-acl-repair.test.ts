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
} from "../../../src/server/file-io/doc-backup.js";

vi.mock("../../../src/server/notifications.js", () => ({ pushNotification: vi.fn() }));

const WIN_ONLY = process.platform === "win32";
const execFileAsync = promisify(execFile);
const systemBin = (name: string) =>
  path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);

/** Current user's SID — the principal the production ACL grants to. */
async function currentUserSid(): Promise<string> {
  const { stdout } = await execFileAsync(systemBin("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  return stdout.split(",")[1].replace(/"/g, "").trim();
}

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
      const sid = await currentUserSid();
      await execFileAsync(systemBin("icacls.exe"), [root, "/grant", `*${sid}:(OI)(CI)F`]).catch(
        () => {},
      );
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

    // Positive control that the poison took — without this the test would
    // pass just as well against a healthy tree and prove nothing.
    expect(() => fs.readdirSync(subdir)).toThrow(/EPERM/);

    const outcome = await snapshotBeforeFirstWrite(docPath, { appDataDir, documentId: "d1" });

    expect(outcome).toBe("written");
    const written = fs.readdirSync(subdir).filter((n) => n.startsWith("welcome-"));
    expect(written).toHaveLength(1);
    expect(fs.readFileSync(path.join(subdir, written[0]), "utf8")).toBe("# original bytes\n");
  });
});
