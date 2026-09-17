import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * `npx biome check .` is the whole-repo form, run by CI's `check` job and by
 * `.husky/pre-push`. Biome 2.x aborts the entire run — exit 1, zero files
 * checked, "Found a nested root configuration" — the moment it descends into a
 * directory holding another `biome.json`. Every `git worktree` of this repo
 * carries the repo's own tracked `biome.json`, so an in-repo worktree is
 * exactly that directory.
 *
 * The first fix enumerated the two worktree roots this repo's tooling uses
 * (`!.claude`, `!.worktrees`) in `files.includes`. An enumeration is only ever
 * as complete as its last edit: a worktree planted anywhere else aborted every
 * `git push` with an error that never names the worktree as the cause.
 *
 * `vcs.useIgnoreFile` replaces the enumeration with the generic rule — biome
 * skips whatever `.gitignore` already skips, and both worktree roots are
 * gitignored. Measured here (biome 2.4.8) rather than argued: a nested
 * `biome.json` under a gitignored directory aborts the run without the setting
 * and is skipped with it, and enabling it changed the repo's own checked-file
 * count by zero (1370 both ways).
 *
 * These specs pin the setting, pin the `.gitignore` lines it now leans on, and
 * execute the real binary both ways so the guarantee cannot pass vacuously.
 */

const REPO_ROOT = path.resolve(__dirname, "../..");
const BIOME_CONFIG = path.join(REPO_ROOT, "biome.json");

/**
 * The `@biomejs/biome` bin entry is a plain node script that dispatches to the
 * platform binary, so running it under `process.execPath` works on every OS
 * without a shell — which `.bin/biome.cmd` would need on Windows.
 */
const BIOME_BIN = path.join(REPO_ROOT, "node_modules", "@biomejs", "biome", "bin", "biome");

type BiomeConfig = {
  vcs?: { enabled?: boolean; clientKind?: string; useIgnoreFile?: boolean };
  files?: { includes?: string[] };
};

function readConfig(): BiomeConfig {
  return JSON.parse(readFileSync(BIOME_CONFIG, "utf-8")) as BiomeConfig;
}

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `process.env` minus every `GIT_*` variable, for anything spawned into a
 * miniature repo (#1957).
 *
 * `git push` from a LINKED worktree exports `GIT_DIR=<repo>/.git/worktrees/<name>`
 * to the pre-push hook, and the hook runs this suite. A `git init` that inherits
 * it ignores `cwd`, re-initializes the REAL repository instead, and — with
 * `GIT_DIR` set and no work tree — writes `core.bare = true` into the config
 * every worktree shares. The main checkout then fails every git command with
 * "this operation must be run in a work tree". Reproduced in throwaway repos:
 * a pre-push hook running `git init` in a temp dir flips the main checkout's
 * `core.bare` when pushed from a worktree, and not when pushed from main (whose
 * hook environment carries no `GIT_DIR`).
 */
function isolatedGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

/**
 * A miniature repo: a real git repo (biome resolves the VCS root from `.git`),
 * the config under test, one file biome will actually check, and a gitignored
 * directory holding a nested `biome.json` — the worktree shape, minus the
 * worktree.
 */
function plantRepo(config: BiomeConfig): string {
  const dir = mkdtempSync(path.join(tmpdir(), "biome-scope-"));
  tempRoots.push(dir);

  // The trailing newline is not cosmetic: root `*.json` is inside `includes`,
  // so biome checks its own config file and a missing final newline is a
  // formatting diagnostic that would fail the run for the wrong reason.
  const serialised = `${JSON.stringify(config, null, 2)}\n`;

  execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "pipe", env: isolatedGitEnv() });
  writeFileSync(path.join(dir, "biome.json"), serialised);
  writeFileSync(path.join(dir, ".gitignore"), "nested-worktree/\n");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), 'export const a = "kept";\n');

  const nested = path.join(dir, "nested-worktree");
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(nested, "biome.json"), serialised);

  return dir;
}

function runBiome(cwd: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [BIOME_BIN, "check", "."], {
      cwd,
      env: isolatedGitEnv(),
      encoding: "utf-8",
      stdio: "pipe",
    });
    return { status: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("miniature repo isolation from the hook's git environment (#1957)", () => {
  it("never re-initializes the repository an inherited GIT_DIR points at", () => {
    // A decoy stands in for the real repo: this spec must not be the thing
    // that flips the checkout it runs in.
    const decoy = mkdtempSync(path.join(tmpdir(), "biome-scope-decoy-"));
    tempRoots.push(decoy);
    execFileSync("git", ["init", "--quiet"], { cwd: decoy, stdio: "pipe", env: isolatedGitEnv() });
    const bare = () =>
      execFileSync("git", ["config", "--get", "core.bare"], {
        cwd: decoy,
        encoding: "utf-8",
        env: isolatedGitEnv(),
      }).trim();
    expect(bare()).toBe("false");

    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(decoy, ".git");
    let planted: string;
    try {
      planted = plantRepo(readConfig());
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }

    expect(bare(), "an inherited GIT_DIR turned the decoy bare").toBe("false");
    expect(readdirSync(planted), "git init must create the miniature repo's own .git").toContain(
      ".git",
    );
  });
});

describe("biome scope over in-repo git worktrees", () => {
  it("enables the ignore file rather than enumerating worktree paths", () => {
    const vcs = readConfig().vcs;
    expect(vcs?.enabled, "biome.json must enable the vcs integration").toBe(true);
    expect(vcs?.clientKind).toBe("git");
    expect(
      vcs?.useIgnoreFile,
      "without useIgnoreFile a worktree at any unlisted path aborts `biome check .`",
    ).toBe(true);
  });

  it("no longer carries the per-worktree-path enumeration it replaced", () => {
    const includes = readConfig().files?.includes ?? [];
    // Re-adding one of these is the symptom of the bug coming back: someone hit
    // the nested-root abort and patched the path instead of the rule.
    expect(includes).not.toContain("!.claude");
    expect(includes).not.toContain("!.worktrees");
  });

  it("keeps both worktree roots gitignored, since that is now the mechanism", () => {
    const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf-8");
    const lines = gitignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines, "`.worktrees/` must stay ignored").toContain(".worktrees/");
    expect(lines, "`.claude/worktrees/` must stay ignored").toContain(".claude/worktrees/");
  });

  it("checks a repo whose gitignored directory holds a nested biome.json", () => {
    const result = runBiome(plantRepo(readConfig()));
    expect(result.output).not.toMatch(/nested root configuration/i);
    expect(result.status, result.output).toBe(0);
    // Zero files checked is how the abort presents, so the count is the half
    // that proves the run actually happened.
    const checked = /Checked (\d+) files?/.exec(result.output);
    expect(checked, result.output).not.toBeNull();
    expect(Number(checked?.[1]), result.output).toBeGreaterThan(0);
  });

  it("control: the same repo aborts once useIgnoreFile is removed", () => {
    // Without this the spec above would pass for any reason at all — including
    // biome quietly dropping the nested-root diagnostic in a future release.
    const config = readConfig();
    delete config.vcs;
    const result = runBiome(plantRepo(config));
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(/nested root configuration/i);
  });
});
