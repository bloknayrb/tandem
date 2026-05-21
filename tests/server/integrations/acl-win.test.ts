import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertNoBroadAce, setRestrictiveAcl } from "../../../src/server/integrations/acl-win.js";

const WIN_ONLY = process.platform === "win32";

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
    // assertNoBroadAce throws if any of the BROAD_SIDS appear. If
    // setRestrictiveAcl did its job, this succeeds silently.
    await expect(assertNoBroadAce(filePath)).resolves.toBeUndefined();
  });

  it("setRestrictiveAcl is idempotent across repeat calls", async () => {
    const filePath = path.join(tmpDir, "secret.json");
    fs.writeFileSync(filePath, '{"token":"sentinel"}');
    await setRestrictiveAcl(filePath);
    await setRestrictiveAcl(filePath);
    await expect(assertNoBroadAce(filePath)).resolves.toBeUndefined();
  });

  it("assertNoBroadAce throws when Everyone has Read access", async () => {
    const filePath = path.join(tmpDir, "leaky.json");
    fs.writeFileSync(filePath, '{"token":"sentinel"}');
    // Grant Everyone (SID S-1-1-0) read access via icacls. Use the SID
    // form so the test works on non-English Windows.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("icacls", [filePath, "/grant", "*S-1-1-0:R"]);
    await expect(assertNoBroadAce(filePath)).rejects.toThrow(/broad-principal/);
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
        String.raw`(?:exec|spawn)\s*\(\s*["'\x60][^"'\x60]*(?:icacls|powershell)`,
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
