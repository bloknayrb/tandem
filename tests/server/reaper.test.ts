import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { tempSiblingPath } from "../../src/server/file-io/index.js";
import { ATOMIC_TEMP_RE, reapOrphanedTemps } from "../../src/server/file-io/reaper";

const REAP_AGE_MS = 60 * 60 * 1000; // mirrors the constant in reaper.ts
const NOW = 1_700_000_000_000; // fixed reference instant for deterministic age math
const HEX12 = "0123456789ab"; // a valid 12-lowercase-hex suffix

const tmpDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-reaper-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** Write a `.tandem-tmp-<ts>-<hex>` temp file and return its full path. */
async function writeTemp(dir: string, ts: number, hex: string = HEX12): Promise<string> {
  const name = `.tandem-tmp-${ts}-${hex}`;
  const full = path.join(dir, name);
  await fs.writeFile(full, "stale write contents");
  return full;
}

/** Write an arbitrary file (used for the "must-not-touch" cases). */
async function writeFile(dir: string, name: string): Promise<string> {
  const full = path.join(dir, name);
  await fs.writeFile(full, "{}");
  return full;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("reapOrphanedTemps", () => {
  it("sweeps an old temp file (timestamp 2h ago)", async () => {
    const dir = await makeDir();
    const old = await writeTemp(dir, NOW - 2 * 60 * 60 * 1000);
    const res = await reapOrphanedTemps([dir], NOW);
    expect(res).toEqual({ cleaned: 1, failed: 0 });
    expect(await exists(old)).toBe(false);
  });

  it("preserves a recent temp file (30s ago)", async () => {
    const dir = await makeDir();
    const recent = await writeTemp(dir, NOW - 30 * 1000);
    const res = await reapOrphanedTemps([dir], NOW);
    expect(res).toEqual({ cleaned: 0, failed: 0 });
    expect(await exists(recent)).toBe(true);
  });

  it("preserves a temp file exactly REAP_AGE_MS old and sweeps one a ms older (exclusive boundary)", async () => {
    const dir = await makeDir();
    const exact = await writeTemp(dir, NOW - REAP_AGE_MS, "aaaaaaaaaaaa");
    const justOver = await writeTemp(dir, NOW - REAP_AGE_MS - 1, "bbbbbbbbbbbb");
    const res = await reapOrphanedTemps([dir], NOW);
    expect(res).toEqual({ cleaned: 1, failed: 0 });
    expect(await exists(exact)).toBe(true); // boundary is EXCLUSIVE — preserved
    expect(await exists(justOver)).toBe(false);
  });

  it("never touches store.lock", async () => {
    const dir = await makeDir();
    const lock = await writeFile(dir, "store.lock");
    const res = await reapOrphanedTemps([dir], NOW);
    expect(res).toEqual({ cleaned: 0, failed: 0 });
    expect(await exists(lock)).toBe(true);
  });

  it("never touches a real <hash>.json envelope", async () => {
    const dir = await makeDir();
    const json = await writeFile(dir, `${"a".repeat(64)}.json`);
    const res = await reapOrphanedTemps([dir], NOW);
    expect(res).toEqual({ cleaned: 0, failed: 0 });
    expect(await exists(json)).toBe(true);
  });

  it("never touches a quarantined <hash>.json.corrupt.<ts> file", async () => {
    const dir = await makeDir();
    const corrupt = await writeFile(
      dir,
      `${"a".repeat(64)}.json.corrupt.${NOW - 10 * 60 * 60 * 1000}`,
    );
    const res = await reapOrphanedTemps([dir], NOW);
    expect(res).toEqual({ cleaned: 0, failed: 0 });
    expect(await exists(corrupt)).toBe(true);
  });

  it("never touches a parked <hash>.json.future file", async () => {
    const dir = await makeDir();
    const future = await writeFile(dir, `${"a".repeat(64)}.json.future`);
    const res = await reapOrphanedTemps([dir], NOW);
    expect(res).toEqual({ cleaned: 0, failed: 0 });
    expect(await exists(future)).toBe(true);
  });

  it("skips a temp with a malformed (non-hex) suffix", async () => {
    const dir = await makeDir();
    const bad = await writeFile(dir, `.tandem-tmp-${NOW - 5 * 60 * 60 * 1000}-zzzzzzzzzzzz`);
    const res = await reapOrphanedTemps([dir], NOW);
    expect(res).toEqual({ cleaned: 0, failed: 0 });
    expect(await exists(bad)).toBe(true);
  });

  it("skips a temp with a wrong-length hex suffix", async () => {
    const dir = await makeDir();
    const tooShort = await writeFile(dir, `.tandem-tmp-${NOW - 5 * 60 * 60 * 1000}-0123456789a`); // 11 hex
    const tooLong = await writeFile(dir, `.tandem-tmp-${NOW - 5 * 60 * 60 * 1000}-0123456789abc`); // 13 hex
    const res = await reapOrphanedTemps([dir], NOW);
    expect(res).toEqual({ cleaned: 0, failed: 0 });
    expect(await exists(tooShort)).toBe(true);
    expect(await exists(tooLong)).toBe(true);
  });

  it("skips a name with trailing extra chars after a valid 12-hex suffix ($ anchor)", async () => {
    const dir = await makeDir();
    const trailing = await writeFile(dir, `.tandem-tmp-${NOW - 5 * 60 * 60 * 1000}-${HEX12}.bak`);
    const res = await reapOrphanedTemps([dir], NOW);
    expect(res).toEqual({ cleaned: 0, failed: 0 });
    expect(await exists(trailing)).toBe(true);
  });

  it("returns {0,0} and does not throw when a directory is missing (ENOENT)", async () => {
    const missing = path.join(os.tmpdir(), `tandem-reaper-missing-${Date.now()}-nope`);
    const res = await reapOrphanedTemps([missing], NOW);
    expect(res).toEqual({ cleaned: 0, failed: 0 });
  });

  it("does not throw on a non-ENOENT readdir failure (e.g. EACCES)", async () => {
    const dir = await makeDir();
    const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(eacces as never);
    const res = await reapOrphanedTemps([dir], NOW);
    expect(res).toEqual({ cleaned: 0, failed: 0 });
  });

  it("aggregates counts across multiple directories", async () => {
    const dirA = await makeDir();
    const dirB = await makeDir();
    await writeTemp(dirA, NOW - 3 * 60 * 60 * 1000, "aaaaaaaaaaaa");
    await writeTemp(dirA, NOW - 4 * 60 * 60 * 1000, "bbbbbbbbbbbb");
    await writeTemp(dirB, NOW - 5 * 60 * 60 * 1000, "cccccccccccc");
    const res = await reapOrphanedTemps([dirA, dirB], NOW);
    expect(res).toEqual({ cleaned: 3, failed: 0 });
  });

  it("isolates a per-file unlink failure (first fails, second succeeds)", async () => {
    const dir = await makeDir();
    await writeTemp(dir, NOW - 3 * 60 * 60 * 1000, "aaaaaaaaaaaa");
    await writeTemp(dir, NOW - 4 * 60 * 60 * 1000, "bbbbbbbbbbbb");
    const real = fs.unlink.bind(fs);
    const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "unlink")
      .mockRejectedValueOnce(eacces as never)
      .mockImplementation(((p: Parameters<typeof fs.unlink>[0]) => real(p)) as typeof fs.unlink);
    const res = await reapOrphanedTemps([dir], NOW);
    expect(res).toEqual({ cleaned: 1, failed: 1 });
  });

  describe("future-dated filename timestamp (clock skew) → mtime fallback", () => {
    it("sweeps when mtime is backdated >1h", async () => {
      const dir = await makeDir();
      const future = await writeTemp(dir, NOW + 60 * 60 * 1000, "dddddddddddd"); // ts is in the future
      // Backdate the real mtime to 2h before NOW.
      const oldMtimeSec = (NOW - 2 * 60 * 60 * 1000) / 1000;
      await fs.utimes(future, oldMtimeSec, oldMtimeSec);
      const res = await reapOrphanedTemps([dir], NOW);
      expect(res).toEqual({ cleaned: 1, failed: 0 });
      expect(await exists(future)).toBe(false);
    });

    it("preserves when mtime is also in the future", async () => {
      const dir = await makeDir();
      const future = await writeTemp(dir, NOW + 60 * 60 * 1000, "eeeeeeeeeeee");
      // Set mtime well past NOW too.
      const futureMtimeSec = (NOW + 2 * 60 * 60 * 1000) / 1000;
      await fs.utimes(future, futureMtimeSec, futureMtimeSec);
      const res = await reapOrphanedTemps([dir], NOW);
      expect(res).toEqual({ cleaned: 0, failed: 0 });
      expect(await exists(future)).toBe(true);
    });
  });

  describe("non-file entries (entry.isFile() guard)", () => {
    it("never removes a DIRECTORY whose name matches the temp pattern", async () => {
      const dir = await makeDir();
      // A directory named exactly like a long-orphaned temp. If the isFile()
      // guard regressed, the name + age would make it eligible and the unlink
      // would EISDIR/EPERM-fail (counted as `failed`); the guard must skip it
      // before any unlink is attempted, so the result is a clean {0,0}.
      const tempShapedDir = path.join(dir, `.tandem-tmp-${NOW - 5 * 60 * 60 * 1000}-${HEX12}`);
      await fs.mkdir(tempShapedDir);
      const res = await reapOrphanedTemps([dir], NOW);
      expect(res).toEqual({ cleaned: 0, failed: 0 });
      expect(await exists(tempShapedDir)).toBe(true);
    });

    it("never removes a SYMLINK whose name matches the temp pattern (link or target)", async () => {
      const dir = await makeDir();
      const target = await writeFile(dir, "real-target.txt");
      const linkPath = path.join(dir, `.tandem-tmp-${NOW - 5 * 60 * 60 * 1000}-cccccccccccc`);
      try {
        await fs.symlink(target, linkPath);
      } catch {
        // Windows without Developer Mode / admin rights can't create symlinks;
        // skip rather than fail — the directory case above already covers the
        // isFile() guard for the common cross-platform path.
        return;
      }
      const res = await reapOrphanedTemps([dir], NOW);
      expect(res).toEqual({ cleaned: 0, failed: 0 });
      expect(await exists(linkPath)).toBe(true); // the link itself is untouched
      expect(await exists(target)).toBe(true); // and so is what it points at
    });
  });

  describe("generator/regex coupling", () => {
    it("ATOMIC_TEMP_RE matches the exact name shape tempSiblingPath produces", () => {
      // The destructive boundary depends on tempSiblingPath (writer) and
      // ATOMIC_TEMP_RE (reaper) agreeing on the name shape. If a future change
      // to tempSiblingPath (separator, an added PID, a longer suffix) drifts
      // from the regex, real orphans would silently stop being reaped with no
      // behavioral test failing. Pin the contract directly across many random
      // suffixes so any drift fails at build time.
      for (let i = 0; i < 50; i++) {
        const name = path.basename(tempSiblingPath(path.join("foo", "bar.json")));
        expect(ATOMIC_TEMP_RE.test(name)).toBe(true);
      }
    });
  });
});
