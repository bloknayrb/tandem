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

const WIN_ONLY = process.platform === "win32";
const execFileAsync = promisify(execFile);

describe.skipIf(!WIN_ONLY)("acl-win — Windows DACL hardening", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-acl-"));
  });

  afterEach(async () => {
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
