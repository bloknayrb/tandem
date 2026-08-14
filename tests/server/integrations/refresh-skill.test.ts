/**
 * Direct unit tests for `refreshExistingSkillIfStale()` in
 * `src/server/integrations/apply.ts` (#477 PR 4b review fixes).
 *
 * Covers three branches:
 *   - On-disk file missing → no-op (setup is the authoritative installer).
 *   - On-disk version < bundled → bundled overwrites it.
 *   - On-disk version >= bundled → no-op; existing content preserved.
 * Plus failure recording via `getSkillRefreshError()`.
 */

import fs from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetSkillRefreshErrorForTests,
  getSkillRefreshError,
  installSkill,
  refreshExistingSkillIfStale,
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

describe("refreshExistingSkillIfStale — first-run (no on-disk file)", () => {
  it("does not install a standalone skill when SKILL.md does not exist", async () => {
    expect(fs.existsSync(skillPath)).toBe(false);
    await refreshExistingSkillIfStale({ homeOverride });
    expect(fs.existsSync(skillPath)).toBe(false);
    expect(getSkillRefreshError()).toBeNull();
  });
});

describe("refreshExistingSkillIfStale — stale on-disk", () => {
  it("overwrites when on-disk version < bundled", async () => {
    await mkdir(path.dirname(skillPath), { recursive: true });
    // Write a v1 stub. The bundled version is v2 (or higher).
    await writeFile(
      skillPath,
      "---\nname: tandem\nversion: 1\ndescription: stale\n---\n\nstale body\n",
      "utf8",
    );
    await refreshExistingSkillIfStale({ homeOverride });
    const written = await readFile(skillPath, "utf8");
    expect(readSkillVersion(written)).toBeGreaterThanOrEqual(2);
    expect(written).not.toContain("stale body");
    expect(getSkillRefreshError()).toBeNull();
  });
});

describe("refreshExistingSkillIfStale — newer-or-equal on-disk", () => {
  it("preserves customized content at the current bundled version", async () => {
    await installSkill({ homeOverride });
    const bundled = await readFile(skillPath, "utf8");
    const customized = `${bundled}\n<!-- user customization -->\n`;
    await writeFile(skillPath, customized, "utf8");

    await refreshExistingSkillIfStale({ homeOverride });

    expect(await readFile(skillPath, "utf8")).toBe(customized);
    expect(getSkillRefreshError()).toBeNull();
  });

  it("preserves on-disk content when version is newer than bundled", async () => {
    await mkdir(path.dirname(skillPath), { recursive: true });
    // Write a v999 stub — guaranteed >= bundled.
    const userCustomized =
      "---\nname: tandem\nversion: 999\ndescription: user-edit\n---\n\nuser custom body\n";
    await writeFile(skillPath, userCustomized, "utf8");
    await refreshExistingSkillIfStale({ homeOverride });
    const after = await readFile(skillPath, "utf8");
    expect(after).toBe(userCustomized);
    expect(getSkillRefreshError()).toBeNull();
  });
});

describe("refreshExistingSkillIfStale — failure recording", () => {
  it("records a path rejection without following a symlinked skill directory", async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "refresh-skill-outside-"));
    try {
      const realSkillPath = path.join(outside, "skills", "tandem", "SKILL.md");
      await mkdir(path.dirname(realSkillPath), { recursive: true });
      const stale = "---\nname: tandem\nversion: 1\n---\n\nstale body\n";
      await writeFile(realSkillPath, stale, "utf8");
      await symlink(
        outside,
        path.join(homeOverride, ".claude"),
        process.platform === "win32" ? "junction" : "dir",
      );

      await refreshExistingSkillIfStale({ homeOverride });

      expect(getSkillRefreshError()).toMatchObject({ code: "path-rejected" });
      expect(await readFile(realSkillPath, "utf8")).toBe(stale);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it("records a read failure without trying to replace an unreadable skill", async () => {
    // A directory at SKILL.md is a deterministic read failure on every
    // supported platform, unlike chmod-based tests (the Windows owner can
    // still read mode 000 and CI may run as root on POSIX).
    await mkdir(skillPath, { recursive: true });

    await refreshExistingSkillIfStale({ homeOverride });

    expect(getSkillRefreshError()?.code).toBe("read-failed");
    expect((await fs.promises.stat(skillPath)).isDirectory()).toBe(true);
  });

  it("records a write failure and preserves the stale skill", async () => {
    await mkdir(path.dirname(skillPath), { recursive: true });
    const stale = "---\nname: tandem\nversion: 1\n---\n\nstale body\n";
    await writeFile(skillPath, stale, "utf8");

    await refreshExistingSkillIfStale({
      homeOverride,
      _writeSkillForTests: async () => {
        throw new Error("simulated disk failure");
      },
    });

    expect(getSkillRefreshError()).toEqual({
      code: "write-failed",
      message: "simulated disk failure",
    });
    expect(await readFile(skillPath, "utf8")).toBe(stale);
  });

  it("does not recreate a skill removed after the stale read but before commit", async () => {
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "---\nname: tandem\nversion: 1\n---\n", "utf8");

    await refreshExistingSkillIfStale({
      homeOverride,
      _beforeSkillCommitForTests: async () => {
        await fs.promises.unlink(skillPath);
      },
    });

    expect(fs.existsSync(skillPath)).toBe(false);
    expect(getSkillRefreshError()).toMatchObject({ code: "write-failed" });
  });

  it("aborts a hung write at the refresh deadline without a late replacement", async () => {
    await mkdir(path.dirname(skillPath), { recursive: true });
    const stale = "---\nname: tandem\nversion: 1\n---\n\nstale body\n";
    await writeFile(skillPath, stale, "utf8");
    let writerObservedAbort = false;

    await refreshExistingSkillIfStale({
      homeOverride,
      // The deadline clock starts at function entry, but `readFile` and
      // `mkdir` both run before the writer is reached. At 20ms this test
      // failed intermittently under a full-suite run: the abort landed in
      // that prefix, `throwIfAborted` threw, the writer was never invoked,
      // and `writerObservedAbort` stayed false while the `timed-out` code
      // below still passed. The budget has to clear two filesystem ops on a
      // loaded machine. Widening it costs nothing and loses no coverage --
      // the fake writer below never resolves, so the deadline still fires
      // inside it, which is the branch under test.
      timeoutMs: 500,
      _writeSkillForTests: async (_content, _dest, signal) => {
        if (!signal) throw new Error("refresh did not pass an AbortSignal to the writer");
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            writerObservedAbort = true;
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    });

    expect(writerObservedAbort).toBe(true);
    expect(getSkillRefreshError()).toMatchObject({ code: "timed-out" });
    expect(await readFile(skillPath, "utf8")).toBe(stale);

    // A Promise.race-only implementation can return at the deadline while its
    // writer continues and renames later. Give that late branch time to fire.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await readFile(skillPath, "utf8")).toBe(stale);
  });

  it("clears lastSkillRefreshError after a successful refresh", async () => {
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "---\nname: tandem\nversion: 1\n---\n", "utf8");
    await refreshExistingSkillIfStale({
      homeOverride,
      _writeSkillForTests: async () => {
        throw new Error("simulated disk failure");
      },
    });
    expect(getSkillRefreshError()?.code).toBe("write-failed");

    await refreshExistingSkillIfStale({ homeOverride });
    expect(getSkillRefreshError()).toBeNull();
  });
});
