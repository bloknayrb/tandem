/**
 * #2358 PR 3a — the run files' fail-closed steps on real Windows ACLs (R1.6).
 * Real `icacls` (the lock) and `Get-Acl` (the re-reads), no mock. Run by the
 * `windows-acl-proof` job, which refuses a skip; `check` is Linux
 * only and passes the POSIX twins in run-files.test.ts, which prove nothing
 * about Windows. Covers: the SDDL owner check passes for the current user's
 * own directory; the lock-and-re-read leaves no broad ACE; a file and a
 * dangling link at a run file's name are refused before the create.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNoBroadAce,
  assertOwnedByCurrentUser,
  setRestrictiveAcl,
} from "../../../src/server/integrations/acl-win.js";
import {
  ensureLauncherDir,
  realRunFileAcl,
  writeRunFile,
} from "../../../src/server/launcher/run-files.js";

// #2390: opt out of tests/setup/acl-win-mock.ts (hoisted above the imports).
vi.unmock(import("../../../src/server/integrations/acl-win.js"));

const WIN_ONLY = process.platform === "win32";

it("uses the real acl-win module", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/server/integrations/acl-win.js")
  >("../../../src/server/integrations/acl-win.js");
  expect(setRestrictiveAcl).toBe(actual.setRestrictiveAcl);
});

describe.skipIf(!WIN_ONLY)("run files — Windows ACL proof (#2358 PR 3a)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-files-win-")));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it("the current user's own launcher/ passes the owner check and is locked with no broad ACE", async () => {
    const dir = path.join(root, "launcher");
    expect(await ensureLauncherDir(dir, { create: true, acl: realRunFileAcl })).toBe(true);
    await expect(assertOwnedByCurrentUser(dir)).resolves.toBeUndefined();
    await expect(assertNoBroadAce(dir)).resolves.toBeUndefined();
    const file = await writeRunFile(dir, "mcp", { a: 1 }, realRunFileAcl);
    await expect(assertNoBroadAce(file)).resolves.toBeUndefined();
  }, 120_000);

  it("a file or a dangling link at the run file's name is refused", async () => {
    const dir = path.join(root, "launcher");
    await ensureLauncherDir(dir, { create: true, acl: realRunFileAcl });
    const present = "1".repeat(32);
    fs.writeFileSync(path.join(dir, `tandem-run-mcp-${present}.json`), "x");
    await expect(writeRunFile(dir, "mcp", {}, realRunFileAcl, present)).rejects.toMatchObject({
      step: "mcp-name-present",
    });
    const dangling = "2".repeat(32);
    fs.symlinkSync(
      path.join(root, "nowhere.json"),
      path.join(dir, `tandem-run-settings-${dangling}.json`),
    );
    await expect(writeRunFile(dir, "settings", {}, realRunFileAcl, dangling)).rejects.toMatchObject(
      {
        step: "settings-name-present",
      },
    );
    expect(fs.existsSync(path.join(root, "nowhere.json"))).toBe(false);
  }, 120_000);

  it("a launcher/ that is a junction is refused", async () => {
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    const dir = path.join(root, "launcher");
    fs.symlinkSync(real, dir, "junction");
    await expect(
      ensureLauncherDir(dir, { create: true, acl: realRunFileAcl }),
    ).rejects.toMatchObject({
      step: "launcher-dir-is-a-link",
    });
  }, 120_000);
});
