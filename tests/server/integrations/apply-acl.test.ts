/**
 * Regression coverage for #807. The inline malformed-`~/.claude.json`
 * backup block inside `applyConfig` (see `apply.ts:537-573`) MUST harden
 * the `.broken-backups/` dir with an explicit DACL on Windows BEFORE
 * writing the backup file. Otherwise the dir lives at the OS default
 * (broad inheritance) for the full copyFile window and any sibling
 * process can list its contents — older backups can carry other
 * vendors' API keys.
 *
 * This file covers two invariants:
 *   1. Behavioural: when `setRestrictiveAcl` throws on Windows, the
 *      backup aborts with a named error and no orphan file is written.
 *   2. Source-level (TOCTOU regression-grep): `apply.ts` must never call
 *      `setRestrictiveAcl(backupPath)` — only the parent dir is
 *      hardened. A per-file ACL call would reintroduce the window
 *      between copyFile and the ACL set.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock target — `vi.mock` is hoisted above imports, so the
// stub must be hoisted alongside it.
const aclStub = vi.hoisted(() => ({
  setRestrictiveAcl: vi.fn(async (_path: string) => {
    /* default: no-op, like the POSIX branch of the real impl */
  }),
}));

vi.mock("../../../src/server/integrations/acl-win.js", () => ({
  setRestrictiveAcl: aclStub.setRestrictiveAcl,
  // The real module also exports assertNoBroadAce; preserve the shape
  // even though apply.ts doesn't import it.
  assertNoBroadAce: vi.fn(async () => {}),
}));

const { applyConfig } = await import("../../../src/server/integrations/apply.js");

describe("applyConfig — broken-backups ACL hardening on Windows (#807)", () => {
  let tmpDir: string;
  let appDataDir: string;
  let configPath: string;
  let prevAppDataDir: string | undefined;
  let prevPlatform: PropertyDescriptor | undefined;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-807-acl-"));
    appDataDir = path.join(tmpDir, "app-data");
    fs.mkdirSync(appDataDir);
    configPath = path.join(tmpDir, ".claude.json");
    prevAppDataDir = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = appDataDir;

    // Fake `process.platform === "win32"` so the Windows-only ACL
    // branch executes on POSIX CI hosts. Restore in afterEach. The real
    // `setRestrictiveAcl` is mocked above, so no icacls spawn happens.
    prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    aclStub.setRestrictiveAcl.mockReset();
  });

  afterEach(async () => {
    if (prevAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = prevAppDataDir;

    if (prevPlatform) Object.defineProperty(process, "platform", prevPlatform);

    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("aborts the backup with a named error when setRestrictiveAcl throws — no orphan file on disk", async () => {
    // Mock the ACL helper to throw. The hardened apply path must
    //   (a) translate the bare ACL throw into a named, actionable error
    //       so the outer catch can surface it,
    //   (b) leave NO backup file under `.broken-backups/` (the dir is
    //       still half-hardened — refusing to write the secret-bearing
    //       payload into it is the whole point), and
    //   (c) refuse to overwrite the original malformed config.
    aclStub.setRestrictiveAcl.mockRejectedValueOnce(new Error("icacls: access denied"));

    const malformed = "{ this is not json";
    fs.writeFileSync(configPath, malformed);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        applyConfig(configPath, {
          create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
          remove: [],
        }),
      ).rejects.toThrow(/failed to apply restrictive ACL to broken-backups dir/);

      // The error message must name the failure surface so a human can
      // act on it (silent ACL swallow is exactly what #805 fixed in
      // storage.ts; the same invariant applies to apply.ts). The outer
      // catch in applyConfig logs the chained `cause` via
      // `err instanceof Error ? err.message : err` — the substring
      // "ACL" appears in both the named throw and the chained message.
      const messages = errSpy.mock.calls.map((c) => c.map(String).join(" "));
      expect(messages.some((m) => m.includes("backup failed") && m.includes("ACL"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }

    // No orphan file in .broken-backups/ — the abort fired BEFORE
    // copyFile, so the dir is either empty or absent.
    const brokenDir = path.join(appDataDir, ".broken-backups");
    if (fs.existsSync(brokenDir)) {
      const entries = fs.readdirSync(brokenDir);
      expect(entries).toEqual([]);
    }

    // Original malformed bytes are preserved on disk — backup-failure
    // contract says we refuse to overwrite without a backup.
    expect(fs.readFileSync(configPath, "utf-8")).toBe(malformed);
  });

  it("calls setRestrictiveAcl on the DIR path (not the file path) — TOCTOU invariant", async () => {
    // Happy path with the mock as a passthrough. `setRestrictiveAcl`
    // gets called several times during a full applyConfig run (atomic
    // write tmpfile, dest after cross-device copy, …). We only care
    // about the call on the broken-backups dir — assert it happens,
    // and assert it NEVER happens on a path that looks like a backup
    // *file* (UUID-suffixed). A refactor that moves the call onto
    // `backupPath` would break this test (paired with the source-grep
    // below).
    aclStub.setRestrictiveAcl.mockResolvedValue(undefined);

    const malformed = "{ this is not json";
    fs.writeFileSync(configPath, malformed);

    await applyConfig(configPath, {
      create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
      remove: [],
    });

    const brokenDir = path.join(appDataDir, ".broken-backups");
    const callPaths = aclStub.setRestrictiveAcl.mock.calls.map((c) => String(c[0]));
    // Dir-level hardening fired exactly once with the dir path.
    expect(callPaths.filter((p) => p === brokenDir)).toEqual([brokenDir]);
    // Per-file ACL never fired on any backup file (UUID-suffixed name).
    const backupFileRe = /\.broken-\d+-[0-9a-f-]+$/;
    expect(callPaths.filter((p) => backupFileRe.test(p))).toEqual([]);
  });
});

describe("apply.ts source — TOCTOU regression guard (#807)", () => {
  it("never calls setRestrictiveAcl on a backup FILE path (only on the dir)", async () => {
    // Source-level grep mirrors the storage.ts regression guard at
    // tests/server/integrations/storage.test.ts:361. Reintroducing a
    // per-file ACL call would re-open the TOCTOU window between copyFile
    // and the ACL set.
    const source = await fs.promises.readFile(
      path.resolve(import.meta.dirname, "../../../src/server/integrations/apply.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/setRestrictiveAcl\(backup(File)?Path\)/);
    // Sanity: the dir-level hardening call IS present in apply.ts.
    expect(source).toMatch(/setRestrictiveAcl\(brokenBackupDir\)/);
  });
});
