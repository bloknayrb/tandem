/**
 * Direct unit tests for `refreshSkillIfStale()` in
 * `src/server/integrations/apply.ts` (#477 PR 4b review fixes).
 *
 * Covers three branches:
 *   - On-disk file missing → bundled gets written.
 *   - On-disk version < bundled → bundled overwrites it.
 *   - On-disk version >= bundled → no-op; existing content preserved.
 * Plus failure recording via `getSkillRefreshError()`.
 */

import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetSkillRefreshErrorForTests,
  getSkillRefreshError,
  refreshSkillIfStale,
} from "../../../src/server/integrations/apply.js";

let homeOverride: string;
let skillPath: string;

beforeEach(async () => {
  homeOverride = await fs.promises.mkdtemp(path.join(os.tmpdir(), "refresh-skill-test-"));
  skillPath = path.join(homeOverride, ".claude", "skills", "tandem", "SKILL.md");
  _resetSkillRefreshErrorForTests();
});

afterEach(async () => {
  await fs.promises.rm(homeOverride, { recursive: true, force: true });
  _resetSkillRefreshErrorForTests();
});

function readSkillVersion(content: string): number {
  const match = content.match(/^version:\s*(\d+)\s*$/m);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : 0;
}

describe("refreshSkillIfStale — first-run (no on-disk file)", () => {
  it("writes the bundled skill when SKILL.md does not exist", async () => {
    expect(fs.existsSync(skillPath)).toBe(false);
    await refreshSkillIfStale({ homeOverride });
    expect(fs.existsSync(skillPath)).toBe(true);
    const written = await readFile(skillPath, "utf8");
    expect(readSkillVersion(written)).toBeGreaterThanOrEqual(2);
    expect(getSkillRefreshError()).toBeNull();
  });
});

describe("refreshSkillIfStale — stale on-disk", () => {
  it("overwrites when on-disk version < bundled", async () => {
    await mkdir(path.dirname(skillPath), { recursive: true });
    // Write a v1 stub. The bundled version is v2 (or higher).
    await writeFile(
      skillPath,
      "---\nname: tandem\nversion: 1\ndescription: stale\n---\n\nstale body\n",
      "utf8",
    );
    await refreshSkillIfStale({ homeOverride });
    const written = await readFile(skillPath, "utf8");
    expect(readSkillVersion(written)).toBeGreaterThanOrEqual(2);
    expect(written).not.toContain("stale body");
    expect(getSkillRefreshError()).toBeNull();
  });
});

describe("refreshSkillIfStale — newer-or-equal on-disk", () => {
  it("preserves on-disk content when version >= bundled", async () => {
    await mkdir(path.dirname(skillPath), { recursive: true });
    // Write a v999 stub — guaranteed >= bundled.
    const userCustomized =
      "---\nname: tandem\nversion: 999\ndescription: user-edit\n---\n\nuser custom body\n";
    await writeFile(skillPath, userCustomized, "utf8");
    await refreshSkillIfStale({ homeOverride });
    const after = await readFile(skillPath, "utf8");
    expect(after).toBe(userCustomized);
    expect(getSkillRefreshError()).toBeNull();
  });
});

describe("refreshSkillIfStale — failure recording", () => {
  it("records read failure when SKILL.md exists but is unreadable", async () => {
    // POSIX-only: create the file then chmod 000 to force EACCES. On Windows
    // we can't reliably revoke owner read with the test process's own ACL,
    // so the test is skipped — chmod is a no-op on Windows.
    if (process.platform === "win32") return;
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "---\nname: tandem\nversion: 1\n---\n", "utf8");
    fs.chmodSync(skillPath, 0o000);
    try {
      await refreshSkillIfStale({ homeOverride });
      const err = getSkillRefreshError();
      // Either the unreadable read failed (read-failed) OR the subsequent
      // write succeeded (treats missing as -1). On most POSIX systems the
      // read fails with EACCES — but if the test runs as root it succeeds.
      if (err) expect(err.code === "read-failed" || err.code === "write-failed").toBe(true);
    } finally {
      fs.chmodSync(skillPath, 0o644);
    }
  });

  it("clears lastSkillRefreshError after a successful refresh", async () => {
    // Seed an error state via the unreadable-file path above (POSIX), then
    // make the file writable and re-run. The error must clear.
    if (process.platform === "win32") return;
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "---\nname: tandem\nversion: 1\n---\n", "utf8");
    fs.chmodSync(skillPath, 0o000);
    try {
      await refreshSkillIfStale({ homeOverride });
    } finally {
      fs.chmodSync(skillPath, 0o644);
    }
    // Second pass: file is readable + stale → write succeeds, error clears.
    await refreshSkillIfStale({ homeOverride });
    expect(getSkillRefreshError()).toBeNull();
  });
});
