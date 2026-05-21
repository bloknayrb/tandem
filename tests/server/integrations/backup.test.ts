import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  backupDir,
  backupFilename,
  isNonDefaultTandem,
  listBackups,
  MAX_BACKUPS,
  pruneOldBackups,
  sweepBackupsOnStartup,
  writeBackup,
} from "../../../src/server/integrations/backup.js";

const POSIX_ONLY = process.platform !== "win32";

describe("isNonDefaultTandem", () => {
  const EXPECTED = "http://127.0.0.1:3479/mcp";

  it("returns false for undefined (fresh install)", () => {
    expect(isNonDefaultTandem(undefined, EXPECTED)).toBe(false);
  });

  it("returns false for the default HTTP-shape entry", () => {
    const entry = { type: "http", url: EXPECTED };
    expect(isNonDefaultTandem(entry, EXPECTED)).toBe(false);
  });

  it("returns false for the default entry with a Bearer header (token rotation)", () => {
    const entry = { type: "http", url: EXPECTED, headers: { Authorization: "Bearer xyz" } };
    expect(isNonDefaultTandem(entry, EXPECTED)).toBe(false);
  });

  it("returns true when URL differs (custom port)", () => {
    const entry = { type: "http", url: "http://127.0.0.1:9999/mcp" };
    expect(isNonDefaultTandem(entry, EXPECTED)).toBe(true);
  });

  it("returns true when URL points at a remote relay", () => {
    const entry = { type: "http", url: "https://remote.example.com/mcp" };
    expect(isNonDefaultTandem(entry, EXPECTED)).toBe(true);
  });

  it("returns true when the entry carries stdio-shape keys (command/args/env)", () => {
    const entry = { command: "node", args: ["/path/to/shim.js"] };
    expect(isNonDefaultTandem(entry, EXPECTED)).toBe(true);
  });

  it("returns true when the entry has a custom field outside the known set", () => {
    const entry = { type: "http", url: EXPECTED, customNote: "added by hand" };
    expect(isNonDefaultTandem(entry, EXPECTED)).toBe(true);
  });
});

describe("backup filename + write + prune", () => {
  let tmpDir: string;
  let dir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-backup-"));
    dir = backupDir(tmpDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("filename uses claude-json- prefix + .json suffix + timestamp + UUID8", () => {
    const name = backupFilename(new Date("2026-06-15T13:45:09"));
    expect(name).toMatch(/^claude-json-20260615-134509-[a-f0-9]{8}\.json$/);
  });

  it("writeBackup creates a file with the expected content", async () => {
    const content = Buffer.from('{"mcpServers":{"tandem":{"url":"custom"}}}', "utf-8");
    const out = await writeBackup(dir, content);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out)).toEqual(content);
  });

  it.skipIf(!POSIX_ONLY)("writeBackup sets POSIX mode 0o600 on the file", async () => {
    const out = await writeBackup(dir, Buffer.from("x"));
    const stat = fs.statSync(out);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("listBackups returns newest-first, ignores non-backup files", async () => {
    // Write 3 backups separated by ~1s to ensure distinct timestamps.
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      paths.push(await writeBackup(dir, Buffer.from(`v${i}`)));
      // Force a unique timestamp by sleeping ≥1s — backupFilename uses
      // second-resolution timestamps, so sub-second writes share a
      // sort prefix and rely on the UUID tiebreaker.
      await new Promise((r) => setTimeout(r, 1100));
    }
    // Drop a stray non-backup file that listBackups must ignore.
    fs.writeFileSync(path.join(dir, "stray.txt"), "ignored");
    const listed = await listBackups(dir);
    expect(listed.length).toBe(3);
    // Newest first — last-written comes first.
    expect(listed[0]).toBe(path.basename(paths[2]));
    expect(listed.includes("stray.txt")).toBe(false);
  }, 10_000);

  it("listBackups returns empty array when dir does not exist", async () => {
    const missing = path.join(tmpDir, "no-such-dir");
    const listed = await listBackups(missing);
    expect(listed).toEqual([]);
  });

  it("pruneOldBackups keeps the MAX_BACKUPS newest and removes the rest", async () => {
    // Write MAX_BACKUPS + 2 backups with distinct timestamps.
    for (let i = 0; i < MAX_BACKUPS + 2; i++) {
      await writeBackup(dir, Buffer.from(`v${i}`));
      await new Promise((r) => setTimeout(r, 1100));
    }
    const removed = await pruneOldBackups(dir);
    expect(removed.length).toBe(2);
    const remaining = await listBackups(dir);
    expect(remaining.length).toBe(MAX_BACKUPS);
  }, 30_000);

  it("writeBackup with `wx` exclusive-create rejects a pre-existing symlink at the predicted path", async () => {
    // Symlink attack: predict the filename and pre-create a symlink.
    // `wx` fails with EEXIST. POSIX-only because symlink creation on
    // Windows requires Developer Mode / admin.
    if (process.platform === "win32") return;
    const fixedName = "claude-json-20260101-000000-deadbeef.json";
    const attackTarget = path.join(tmpDir, "attack-target");
    fs.writeFileSync(attackTarget, "");
    fs.symlinkSync(attackTarget, path.join(dir, fixedName));

    // Manually call the open primitive `writeBackup` uses, with the
    // attacker-predicted name. (We can't pin `backupFilename`'s UUID,
    // so this test exercises the underlying `wx` invariant directly.)
    await expect(fs.promises.open(path.join(dir, fixedName), "wx", 0o600)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });
});

describe("sweepBackupsOnStartup", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-sweep-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("is a no-op when no backups exist", async () => {
    await expect(sweepBackupsOnStartup(tmpDir)).resolves.toBeUndefined();
  });

  it("prunes excess backups left over from a crash-mid-prune", async () => {
    const dir = backupDir(tmpDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Pre-place MAX_BACKUPS + 2 backup files to simulate a previous run
    // that crashed before pruning.
    for (let i = 0; i < MAX_BACKUPS + 2; i++) {
      // Manually format names with distinct lexicographic order — faster
      // than spacing real writes by 1s each.
      const name = `claude-json-2026010${i}-000000-deadbeef.json`;
      fs.writeFileSync(path.join(dir, name), `v${i}`);
    }
    await sweepBackupsOnStartup(tmpDir);
    const remaining = await listBackups(dir);
    expect(remaining.length).toBe(MAX_BACKUPS);
  });
});
