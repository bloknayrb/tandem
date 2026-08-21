import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetCurrentUserSidForTests,
  assertNoBroadAce,
  setRestrictiveAcl,
} from "../../../src/server/integrations/acl-win.js";
import {
  assertPre1299PoisonTook,
  currentUserSid,
  normalizePre1299Poison,
  restoreAccessForCleanup,
} from "../../helpers/win-acl-fixture.js";

const WIN_ONLY = process.platform === "win32";
const execFileAsync = promisify(execFile);

describe.skipIf(!WIN_ONLY)("acl-win — Windows DACL hardening", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-acl-"));
  });

  afterEach(async () => {
    // A poisoned subdir may survive a mid-test failure, and an empty DACL
    // defeats `rm`. Re-grant inheritably before cleaning up.
    if (fs.existsSync(tmpDir)) {
      await restoreAccessForCleanup(tmpDir, await currentUserSid());
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("setRestrictiveAcl applies a DACL with no broad-principal ACE", async () => {
    const filePath = path.join(tmpDir, "secret.json");
    fs.writeFileSync(filePath, '{"token":"sentinel"}');
    await setRestrictiveAcl(filePath);
    // setRestrictiveAcl self-verifies via assertNoBroadAce — a second
    // call here is belt-and-suspenders that the verify works
    // independently of the set path.
    await expect(assertNoBroadAce(filePath)).resolves.toBeUndefined();
  });

  it("setRestrictiveAcl is idempotent across repeat calls", async () => {
    const filePath = path.join(tmpDir, "secret.json");
    fs.writeFileSync(filePath, '{"token":"sentinel"}');
    await setRestrictiveAcl(filePath);
    await setRestrictiveAcl(filePath);
    await expect(assertNoBroadAce(filePath)).resolves.toBeUndefined();
  });

  it("cancels ACL subprocess work when the caller aborts", async () => {
    const filePath = path.join(tmpDir, "cancelled.json");
    fs.writeFileSync(filePath, '{"token":"sentinel"}');
    const controller = new AbortController();
    controller.abort(new DOMException("refresh deadline", "TimeoutError"));

    await expect(setRestrictiveAcl(filePath, { signal: controller.signal })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  // Table-driven coverage for every broad-principal SID — a future drop of
  // any entry from BROAD_SDDL_FRAGMENTS would silently weaken the gate.
  const BROAD_CASES: Array<{ name: string; sid: string }> = [
    { name: "Everyone", sid: "S-1-1-0" },
    { name: "Authenticated Users", sid: "S-1-5-11" },
    { name: "BUILTIN\\Users", sid: "S-1-5-32-545" },
  ];
  for (const { name, sid } of BROAD_CASES) {
    it(`assertNoBroadAce throws when ${name} (${sid}) has Read access`, async () => {
      const filePath = path.join(tmpDir, `leaky-${sid}.json`);
      fs.writeFileSync(filePath, '{"token":"sentinel"}');
      // Use the *SID form so the grant lands locale-independently.
      await execFileAsync("icacls", [filePath, "/grant", `*${sid}:R`]);
      await expect(assertNoBroadAce(filePath)).rejects.toThrow(/broad-principal/);
    });
  }

  // #1299: doc-backup ACLs a ROOT directory whose per-path subdirs already
  // exist. This walks the full lifecycle the bug produced — poison, observe
  // EPERM, repair — with real icacls, because the doc-backup unit suite mocks
  // this module and therefore cannot see any of it. The repair phase is also
  // what makes the tree deletable again in afterEach.
  //
  // The title says "a child with an empty DACL", not "the non-inheritable
  // grant empties the child", because the fixture no longer relies on the
  // latter: `normalizePre1299Poison` pins the root's DACL afterwards, since
  // `/inheritance:r` alone does not reach that state on every Windows build
  // (#1529). What is asserted below is the half that matters to the reporter
  // and is true everywhere — an inheritable grant repairs such a child.
  it("an inheritable grant on the root repairs a child left with an empty DACL", async () => {
    const root = path.join(tmpDir, "doc-backups");
    const child = path.join(root, "abc123hash");
    const snapshot = path.join(child, "welcome-20260805-160342-45f01c92.md");
    fs.mkdirSync(child, { recursive: true });
    // Baseline: a plain inherited-ACE child is writable.
    fs.writeFileSync(snapshot, "original bytes");
    fs.rmSync(snapshot);

    // Poison: the default grant applies to `root` alone, so breaking
    // inheritance leaves `child` with an EMPTY DACL — deny-all, owner included.
    await setRestrictiveAcl(root);
    await normalizePre1299Poison(root, await currentUserSid());
    await assertPre1299PoisonTook(root, child);
    // Positive control on the operation the repair below has to restore.
    expect(() => fs.writeFileSync(snapshot, "original bytes", { flag: "wx" })).toThrow(/EPERM/);

    // Repair: an inheritable grant propagates down to the existing child.
    await setRestrictiveAcl(root, { inheritable: true });
    expect(() => fs.writeFileSync(snapshot, "original bytes", { flag: "wx" })).not.toThrow();
    expect(fs.readFileSync(snapshot, "utf8")).toBe("original bytes");
    // Hardening is not traded away for the fix.
    await expect(assertNoBroadAce(root)).resolves.toBeUndefined();
  });

  it("setRestrictiveAcl throws when icacls cannot act on the path", async () => {
    // Non-existent path → icacls exits non-zero. setRestrictiveAcl must
    // wrap the error with the path in the message for forensics.
    _resetCurrentUserSidForTests();
    const filePath = path.join(tmpDir, "does-not-exist.json");
    await expect(setRestrictiveAcl(filePath)).rejects.toThrow(
      new RegExp(`setRestrictiveAcl: icacls failed on .*does-not-exist`),
    );
  });
});

describe("acl-win — source contract", () => {
  it("never invokes icacls or PowerShell via a shell", async () => {
    // Path traversal: read the acl-win.ts source and grep for shell-style
    // invocations. The contract is the argv-array form only — string-command
    // shell invocations would re-introduce command-injection surface for
    // user-controlled paths flowing from homedir().
    const source = await fs.promises.readFile(
      path.join(__dirname, "../../../src/server/integrations/acl-win.ts"),
      "utf-8",
    );
    // String-command invocations would look like e.g. `exec("icacls ...")` or
    // `spawn("icacls ...")`. Build the pattern from a non-literal so the
    // regex itself doesn't trip security scanners.
    const shellExec = new RegExp(
      String.raw`(?:^|[^A-Za-z_])` + // word boundary that doesn't include `F` (rules out `execFile`)
        String.raw`(?:exec|spawn)(?:Sync)?\s*\(\s*["'\x60][^"'\x60]*(?:icacls|powershell|whoami)`,
      "im",
    );
    expect(source).not.toMatch(shellExec);
    expect(source).not.toMatch(/shell\s*:\s*true/);
  });
});

describe.skipIf(WIN_ONLY)("acl-win — POSIX no-op", () => {
  it("setRestrictiveAcl resolves without effect on non-Windows", async () => {
    await expect(setRestrictiveAcl("/dev/null")).resolves.toBeUndefined();
  });

  it("assertNoBroadAce resolves without effect on non-Windows", async () => {
    await expect(assertNoBroadAce("/dev/null")).resolves.toBeUndefined();
  });
});
