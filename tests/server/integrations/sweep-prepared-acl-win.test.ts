/**
 * #2358 PR 2b — the boot sweep prepares its files before its authoritative read
 * so that the Windows ACL step sits outside the read-to-rename window. Each
 * prepared file is created exclusively, restricted BY PATH while its handle is
 * still open, and later filled THROUGH that handle (never reopened by path).
 *
 * This is the proof, on real `icacls` and `Get-Acl`, of the two things that
 * design rests on and a Linux run cannot see: that the ACL step succeeds on a
 * file Node holds open, and that writing through the handle (and, for the
 * backup, the `.part` -> `.json` rename) leaves the restrictive DACL exactly as
 * it was set. Run by the `windows-acl-proof` CI job.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNoBroadAce, setRestrictiveAcl } from "../../../src/server/integrations/acl-win.js";
import { prepareAtomicTmp } from "../../../src/server/integrations/apply.js";
import {
  commitReservedBackup,
  reserveBackup,
  SWEEP_BACKUP_PREFIX,
  writeAllThrough,
} from "../../../src/server/integrations/backup.js";

// #2390: opt out of tests/setup/acl-win-mock.ts — this file proves the real
// primitive on prepared files (hoisted above the imports by vitest).
vi.unmock(import("../../../src/server/integrations/acl-win.js"));

const WIN_ONLY = process.platform === "win32";
const execFileAsync = promisify(execFile);

// File-level, so a lost `vi.unmock` also fails the ubuntu `check` leg.
it("uses the real acl-win module", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/server/integrations/acl-win.js")
  >("../../../src/server/integrations/acl-win.js");
  expect(setRestrictiveAcl).toBe(actual.setRestrictiveAcl);
});

/** The file's DACL as SDDL, read the way `assertNoBroadAce` reads it. */
async function sddl(file: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Import-Module Microsoft.PowerShell.Security; (Get-Acl -LiteralPath $env:TANDEM_SDDL_PATH).Sddl",
    ],
    { env: { ...process.env, TANDEM_SDDL_PATH: file } },
  );
  return stdout.trim();
}

describe.skipIf(!WIN_ONLY)("sweep prepared files — Windows ACL proof (#2358 PR 2b)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-prepared-acl-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("a reserved backup keeps its restrictive DACL through the fill and the rename", async () => {
    const reserved = await reserveBackup(tmpDir, SWEEP_BACKUP_PREFIX);
    await assertNoBroadAce(reserved.partPath);
    const before = await sddl(reserved.partPath);

    const bytes = Buffer.from('{"token":"sentinel"}\n');
    const final = await commitReservedBackup(reserved, bytes);

    expect(await sddl(final)).toBe(before);
    await expect(assertNoBroadAce(final)).resolves.toBeUndefined();
    expect(fs.readFileSync(final).equals(bytes)).toBe(true);
  });

  it("a prepared temp keeps its restrictive DACL through a write via its handle", async () => {
    const prepared = await prepareAtomicTmp(path.join(tmpDir, ".claude.json"));
    await assertNoBroadAce(prepared.path);
    const before = await sddl(prepared.path);

    const bytes = Buffer.from('{"mcpServers":{"tandem":{"env":{"TANDEM_AUTH_TOKEN":"x"}}}}\n');
    await writeAllThrough(prepared.handle, bytes);
    await prepared.handle.sync();
    await prepared.handle.close();

    expect(await sddl(prepared.path)).toBe(before);
    await expect(assertNoBroadAce(prepared.path)).resolves.toBeUndefined();
    expect(fs.readFileSync(prepared.path).equals(bytes)).toBe(true);
  });
});
