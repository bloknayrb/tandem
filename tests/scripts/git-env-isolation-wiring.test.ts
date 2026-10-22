import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every `git init` a test spawns must strip the hook's `GIT_*` environment
 * (`isolatedGitEnv`, tests/helpers/git-env.ts). Pushing from a linked worktree
 * runs the suite with `GIT_DIR` pointing at the real repository, and an
 * inheriting `git init` flips the main checkout to `core.bare = true` (#1957,
 * then again in check-links-checker.test.ts).
 */
const TESTS = path.resolve(import.meta.dirname, "..");
const GIT_INIT = /\b(?:spawnSync|execFileSync|spawn|execFile)\(\s*"git",\s*\[\s*"init"/g;

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(full).isDirectory()) return testFiles(full);
    return /\.(ts|mts|js|mjs)$/.test(name) ? [full] : [];
  });
}

describe("git init spawns in tests are isolated from the hook's GIT_DIR", () => {
  it("every one passes env: isolatedGitEnv()", () => {
    const offenders: string[] = [];
    let found = 0;
    for (const file of testFiles(TESTS)) {
      if (file === import.meta.filename) continue;
      const src = readFileSync(file, "utf-8");
      for (const m of src.matchAll(GIT_INIT)) {
        found++;
        const call = src.slice(m.index, src.indexOf(");", m.index));
        if (!call.includes("isolatedGitEnv()")) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${path.relative(TESTS, file)}:${line}`);
        }
      }
    }
    // Guard against a vacuous pass if the regex stops matching anything.
    expect(found).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
