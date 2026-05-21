import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyConfig,
  assertPathSafe,
  MSIX_PACKAGE_PATTERN,
  PathRejectedError,
} from "../../../src/server/integrations/apply.js";

const POSIX_ONLY = process.platform !== "win32";

describe("assertPathSafe", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-assert-path-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!POSIX_ONLY)("rejects a symlink at the leaf", () => {
    const realTarget = path.join(tmpDir, "real");
    fs.writeFileSync(realTarget, "{}");
    const symPath = path.join(tmpDir, "sym");
    fs.symlinkSync(realTarget, symPath);

    expect(() => assertPathSafe(symPath, { allowedRoots: [tmpDir] })).toThrow(PathRejectedError);
    try {
      assertPathSafe(symPath, { allowedRoots: [tmpDir] });
    } catch (err) {
      expect((err as PathRejectedError).reason).toBe("symlink");
    }
  });

  it.skipIf(!POSIX_ONLY)("rejects a target whose realpath resolves outside allowed roots", () => {
    // Create a sibling dir outside the allowed root, then a symlink at the
    // root's leaf pointing into it. The leaf is a symlink so it's caught at
    // the symlink check (the outside-home reason is the fallback when the
    // realpath itself is the only signal — exercised by the symlink-ancestor
    // case below).
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-assert-outside-"));
    try {
      // Use a fresh tmpDir as the "allowed root" and point the test path
      // outside of it.
      const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-allowed-"));
      try {
        const outsidePath = path.join(outsideDir, "config.json");
        fs.writeFileSync(outsidePath, "{}");
        expect(() => assertPathSafe(outsidePath, { allowedRoots: [allowed] })).toThrow(
          /outside allowed roots/,
        );
      } finally {
        fs.rmSync(allowed, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("accepts a non-existent path whose closest existing ancestor is inside an allowed root", () => {
    const nested = path.join(tmpDir, "does", "not", "exist", "yet.json");
    expect(() => assertPathSafe(nested, { allowedRoots: [tmpDir] })).not.toThrow();
  });

  it.skipIf(!POSIX_ONLY)("rejects when an intermediate ancestor is a symlink", () => {
    const realIntermediate = path.join(tmpDir, "real-dir");
    fs.mkdirSync(realIntermediate);
    const symIntermediate = path.join(tmpDir, "sym-dir");
    fs.symlinkSync(realIntermediate, symIntermediate);
    // Target a non-existent leaf under the symlinked intermediate. The walk
    // climbs to `sym-dir` (which exists, as a symlink) and trips the
    // symlink check there.
    const leaf = path.join(symIntermediate, "child.json");
    expect(() => assertPathSafe(leaf, { allowedRoots: [tmpDir] })).toThrow(PathRejectedError);
  });
});

describe("MSIX_PACKAGE_PATTERN", () => {
  const cases: Array<{ name: string; matches: boolean }> = [
    { name: "Claude_abc123", matches: true },
    { name: "Claude_8wekyb3d8bbwe", matches: true },
    { name: "Claude_", matches: false },
    { name: "Claude_../etc", matches: false },
    { name: "xClaude_abc", matches: false },
    { name: "Claude_abc/extra", matches: false },
    { name: "Claude_abc\nrogue", matches: false },
    { name: "claude_abc", matches: false },
  ];

  for (const { name, matches } of cases) {
    it(`${matches ? "matches" : "rejects"} ${JSON.stringify(name)}`, () => {
      expect(MSIX_PACKAGE_PATTERN.test(name)).toBe(matches);
    });
  }
});

describe("applyConfig — explicit removals", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-apply-rm-"));
    configPath = path.join(tmpDir, ".claude.json");
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("deletes the key from an existing config when listed in `remove`", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" },
          "tandem-channel": { command: "node", args: ["/path/to/shim.js"] },
        },
      }),
    );
    await applyConfig(configPath, {
      create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
      remove: ["tandem-channel"],
    });
    const after = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(after.mcpServers["tandem-channel"]).toBeUndefined();
    expect(after.mcpServers.tandem).toBeDefined();
  });

  it("does NOT delete tandem-channel when absent from `remove` (no implicit removal)", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          "tandem-channel": { command: "node", args: ["/path/to/shim.js"] },
        },
      }),
    );
    await applyConfig(configPath, {
      create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
      remove: [],
    });
    const after = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(after.mcpServers["tandem-channel"]).toBeDefined();
    expect(after.mcpServers.tandem).toBeDefined();
  });
});

describe("applyConfig — malformed-JSON backup", () => {
  let tmpDir: string;
  let appDataDir: string;
  let configPath: string;
  let prevAppDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-apply-broken-"));
    appDataDir = path.join(tmpDir, "app-data");
    fs.mkdirSync(appDataDir);
    configPath = path.join(tmpDir, ".claude.json");
    prevAppDataDir = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = appDataDir;
  });

  afterEach(async () => {
    if (prevAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = prevAppDataDir;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!POSIX_ONLY)("writes the backup with mode 0o600 inside a 0o700 dir", async () => {
    fs.writeFileSync(configPath, "{ this is not json");
    await applyConfig(configPath, {
      create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
      remove: [],
    });
    const backupDir = path.join(appDataDir, ".broken-backups");
    // Dir is created with 0o700 — defeats sibling-listing on multi-user
    // POSIX (older backups can carry other vendors' API keys).
    const dirStat = fs.statSync(backupDir);
    expect(dirStat.mode & 0o777).toBe(0o700);
    const entries = fs.readdirSync(backupDir);
    expect(entries.length).toBeGreaterThan(0);
    const backupFile = path.join(backupDir, entries[0]);
    // File mode 0o600 + `wx` exclusive open closes the read-bits race
    // (copyFile + chmodSync had a 0o644 window inside which another
    // local user could read the API-key-bearing backup).
    const stat = fs.statSync(backupFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("rejects backup when resolveAppDataDir resolves to a path outside allowed roots", async () => {
    // Point TANDEM_APP_DATA_DIR at a directory completely outside both
    // homedir() and tmpdir(). The backup path's `assertPathSafe` should
    // refuse it before mkdirSync runs.
    //
    // The simplest "outside both" location is `/`. assertPathSafe refuses
    // anything that doesn't resolve under homedir/tmpdir; `/` itself does
    // not satisfy either.
    const sentinel = "/__tandem-outside-roots__";
    process.env.TANDEM_APP_DATA_DIR = sentinel;
    fs.writeFileSync(configPath, "{ this is not json");

    await expect(
      applyConfig(configPath, {
        create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
        remove: [],
      }),
    ).rejects.toBeInstanceOf(PathRejectedError);
  });
});

describe("applyConfig — 5MB size guard", () => {
  let tmpDir: string;
  let configPath: string;
  let savedAppData: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-size-guard-"));
    configPath = path.join(tmpDir, ".claude.json");
    savedAppData = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    if (savedAppData === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = savedAppData;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts a config just under the 5 MiB cap", async () => {
    // 5 MiB - 1 KiB padding so the JSON object header fits without crossing.
    const padding = "x".repeat(5 * 1024 * 1024 - 1024);
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {}, _pad: padding }));
    // Should not throw — boundary case proves the cap isn't off-by-one strict.
    await applyConfig(configPath, {
      create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
      remove: [],
    });
  });

  it("rejects a config above the 5 MiB cap", async () => {
    // 5 MiB + 1 byte of padding.
    const padding = "x".repeat(5 * 1024 * 1024 + 1);
    fs.writeFileSync(configPath, JSON.stringify({ _pad: padding }));
    await expect(
      applyConfig(configPath, {
        create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
        remove: [],
      }),
    ).rejects.toThrow(/refusing to read/);
  });
});

describe("applyConfig — backup-before-overwrite (#644)", () => {
  let tmpDir: string;
  let configPath: string;
  let savedAppData: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-backup-apply-"));
    configPath = path.join(tmpDir, ".claude.json");
    savedAppData = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    if (savedAppData === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = savedAppData;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("does NOT back up on fresh install (no existing config)", async () => {
    const calls: string[] = [];
    await applyConfig(configPath, {
      create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
      remove: [],
      onBackup: (p) => calls.push(p),
    });
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, ".backups"))).toBe(false);
  });

  it("does NOT back up when the new entry matches the existing entry byte-for-byte", async () => {
    // Identity-rewrite case — the apply is a no-op on content terms.
    // No churn.
    const same = { type: "http", url: "http://127.0.0.1:3479/mcp" };
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { tandem: same } }));
    const calls: string[] = [];
    await applyConfig(configPath, {
      create: { tandem: same },
      remove: [],
      onBackup: (p) => calls.push(p),
    });
    expect(calls).toEqual([]);
  });

  it("DOES back up on token rotation (different Bearer values)", async () => {
    // Contract change vs the original PR-744 plan: token rotation now
    // produces a backup because we cannot distinguish "Tandem rotated
    // its own token" from "user hand-crafted an Authorization header
    // that we'd silently destroy". The MAX_BACKUPS=3 cap keeps disk
    // use bounded.
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          tandem: {
            type: "http",
            url: "http://127.0.0.1:3479/mcp",
            headers: { Authorization: "Bearer old-token" },
          },
        },
      }),
    );
    const calls: string[] = [];
    await applyConfig(configPath, {
      create: {
        tandem: {
          type: "http",
          url: "http://127.0.0.1:3479/mcp",
          headers: { Authorization: "Bearer new-token" },
        },
      },
      remove: [],
      onBackup: (p) => calls.push(p),
    });
    expect(calls.length).toBe(1);
  });

  it("backs up when the existing tandem URL is non-default", async () => {
    const customConfig = JSON.stringify({
      mcpServers: {
        tandem: { type: "http", url: "http://127.0.0.1:9999/mcp" },
      },
    });
    fs.writeFileSync(configPath, customConfig);
    const calls: string[] = [];
    await applyConfig(configPath, {
      create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
      remove: [],
      onBackup: (p) => calls.push(p),
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/[\\/]\.backups[\\/]claude-json-/);
    // Backup must contain the ORIGINAL config bytes (not the new one).
    const backupBytes = fs.readFileSync(calls[0], "utf-8");
    expect(backupBytes).toBe(customConfig);
    // Original is the new config.
    const newConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(newConfig.mcpServers.tandem.url).toBe("http://127.0.0.1:3479/mcp");
  });

  it("backs up when the existing tandem entry has stdio-shape keys", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          tandem: { command: "node", args: ["/path/to/shim.js"] },
        },
      }),
    );
    const calls: string[] = [];
    await applyConfig(configPath, {
      create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
      remove: [],
      onBackup: (p) => calls.push(p),
    });
    expect(calls.length).toBe(1);
  });

  it("continues the rewrite when onBackup callback throws (callback is observational)", async () => {
    // Contract: onBackup is informational — wizard push / CLI print /
    // telemetry hop. If it throws, the rewrite MUST still complete so
    // the user doesn't end up with an orphaned backup + un-applied
    // config + no user-visible explanation.
    const customConfig = JSON.stringify({
      mcpServers: { tandem: { type: "http", url: "http://127.0.0.1:9999/mcp" } },
    });
    fs.writeFileSync(configPath, customConfig);
    await applyConfig(configPath, {
      create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
      remove: [],
      onBackup: () => {
        throw new Error("simulated wizard push failure");
      },
    });
    // Rewrite completed despite callback throw.
    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem.url).toBe("http://127.0.0.1:3479/mcp");
    // Backup file is still on disk (callback threw AFTER the write).
    const backupDir = path.join(tmpDir, ".backups");
    expect(fs.existsSync(backupDir)).toBe(true);
    const backups = fs.readdirSync(backupDir);
    expect(backups.length).toBe(1);
  });
});

describe("applyConfig — atomicity contract (#644)", () => {
  // Mock-based test of the load-bearing claim: if backup throws, the
  // original config is untouched. Uses vi.spyOn on the underlying fs
  // open() to fault-inject a write failure into writeBackup. Skipped on
  // Windows because the spy interaction with pwsh-spawn timings is
  // brittle there — POSIX coverage is sufficient.
  let tmpDir: string;
  let configPath: string;
  let savedAppData: string | undefined;
  const POSIX_ONLY = process.platform !== "win32";

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-atomicity-"));
    configPath = path.join(tmpDir, ".claude.json");
    savedAppData = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    if (savedAppData === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = savedAppData;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!POSIX_ONLY)("leaves the original config intact when backup write fails", async () => {
    // Fault injection: pre-create `.backups` as a regular FILE, not a
    // directory. `mkdirSync(dir, { recursive: true })` then fails with
    // EEXIST/ENOTDIR because the path exists and is not a directory.
    // The throw propagates from maybeBackupExistingConfig before
    // atomicWrite runs, so the original config is untouched.
    //
    // Avoids the more natural `chmod 0o500 .backups` approach because
    // maybeBackupExistingConfig deliberately re-chmods a pre-existing
    // 0o500 dir to 0o700 as a hardening step — that would defeat the
    // test setup. A file-at-the-dir-path can't be rescued the same way.
    const backupPath = path.join(tmpDir, ".backups");
    fs.writeFileSync(backupPath, "not a directory");

    const originalBytes = JSON.stringify({
      mcpServers: { tandem: { type: "http", url: "http://127.0.0.1:9999/mcp" } },
    });
    fs.writeFileSync(configPath, originalBytes);

    await expect(
      applyConfig(configPath, {
        create: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } },
        remove: [],
      }),
    ).rejects.toThrow();

    // Original config bytes are byte-for-byte unchanged.
    expect(fs.readFileSync(configPath, "utf-8")).toBe(originalBytes);
  });
});
