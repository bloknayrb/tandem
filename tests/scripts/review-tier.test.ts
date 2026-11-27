import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classify,
  globToRegExp,
  loadTiers,
  toRepoRelative,
} from "../../.claude/hooks/review-tier.mjs";

/**
 * ADR-057 review tiers. `.claude/review-tiers.json` decides which changes may
 * skip plan review; this pins that the allowlist stays narrow and fails closed,
 * and that `nudge-plan-review.sh` warns on a Tier A edit made with no plan.
 *
 * Enforcement is a nudge, never a block (ADR-057 names the residuals: the
 * agent classifies its own work, and Bash writes never reach the hook).
 */

const ROOT = path.resolve(__dirname, "..", "..");
const tiers = loadTiers(ROOT);
const tier = (rel: string, created = false) => classify(rel, tiers, { created });

describe("review tier classification", () => {
  it("globs: ** spans directories, * stays within one", () => {
    expect(globToRegExp("docs/reviews/**").test("docs/reviews/a/b.md")).toBe(true);
    expect(globToRegExp("**/CLAUDE.md").test("CLAUDE.md")).toBe(true);
    expect(globToRegExp("**/CLAUDE.md").test("src/server/CLAUDE.md")).toBe(true);
    expect(globToRegExp("src/client/**/*.css").test("src/client/a/b.css")).toBe(true);
    expect(globToRegExp("src/client/**/*.css").test("src/client/a/b.ts")).toBe(false);
    expect(globToRegExp("README.md").test("docs/README.md")).toBe(false);
  });

  it.each([
    "docs/reviews/2026-11-27-x.md",
    "docs/plans/x.md",
    "README.md",
    "CHANGELOG.md",
    "src/client/styles/theme.css",
  ])("%s is Tier B", (rel) => {
    expect(tier(rel)).toBe("B");
  });

  it.each([
    // Unlisted paths fail closed.
    "src/server/positions.ts",
    "src/client/App.svelte",
    "src-tauri/src/lib.rs",
    "package.json",
    // Docs that act as instructions or as the #1602 exception's source.
    "docs/security.md",
    "docs/decisions.md",
    "docs/gotchas.md",
    "docs/lessons-learned.md",
    "docs/workflows.md",
    // Instruction files, reviewers, hooks, CI, scripts and the checks.
    "CLAUDE.md",
    "src/server/CLAUDE.md",
    "AGENTS.md",
    ".claude/agents/security-reviewer.md",
    ".claude/review-tiers.json",
    "skills/tandem/SKILL.md",
    ".github/workflows/ci.yml",
    ".github/pull_request_template.md",
    "scripts/ci/knip-ratchet.mjs",
    "tests/docs/tool-count-drift.test.ts",
    "tests/scripts/review-tier.test.ts",
    "tests/setup/app-data-isolation.ts",
  ])("%s is Tier A", (rel) => {
    expect(tier(rel)).toBe("A");
    expect(tier(rel, true), "creating it does not make it Tier B either").toBe("A");
  });

  it("a test file is Tier B only when the session creates it", () => {
    expect(tier("tests/server/new-thing.test.ts", true)).toBe("B");
    expect(tier("tests/server/new-thing.test.ts", false)).toBe("A");
    expect(tier("tests/docs/new-claims.test.ts", true), "checks stay Tier A").toBe("A");
  });

  it("alwaysTierA beats every Tier B glob", () => {
    expect(tier("docs/reviews/CLAUDE.md")).toBe("A");
  });

  it("maps paths to repo-relative form, and a path outside the repo to null", () => {
    expect(toRepoRelative(path.join(ROOT, "src", "a.ts"), ROOT)).toBe("src/a.ts");
    expect(toRepoRelative("src\\a.ts", ROOT)).toBe("src/a.ts");
    expect(toRepoRelative("/root/.claude/plans/x.md", ROOT)).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("nudge-plan-review.sh tier branch", () => {
  const runHook = (session: string, tool: string, file: string) =>
    spawnSync("bash", [".claude/hooks/nudge-plan-review.sh"], {
      cwd: ROOT,
      encoding: "utf8",
      input: JSON.stringify({
        session_id: session,
        tool_name: tool,
        tool_input: { file_path: file },
      }),
    });

  it("warns once on a Tier A edit with no plan, and never on Tier B", () => {
    const session = `vitest-tier-${process.pid}`;
    const stateDir = path.join(ROOT, ".claude", ".workflow-state", session);
    try {
      const b = runHook(session, "Edit", path.join(ROOT, "docs", "reviews", "x.md"));
      expect(b.status).toBe(0);
      expect(b.stderr).not.toContain("Tier A");

      const a = runHook(session, "Edit", path.join(ROOT, "src", "server", "index.ts"));
      expect(a.status, "the nudge never blocks").toBe(0);
      expect(a.stderr).toContain("Tier A edit with no plan this session");

      const again = runHook(session, "Edit", path.join(ROOT, "src", "server", "index.ts"));
      expect(again.stderr, "one-shot per session").not.toContain("Tier A");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("stays quiet once a plan was written this session", () => {
    const session = `vitest-tier-plan-${process.pid}`;
    const stateDir = path.join(ROOT, ".claude", ".workflow-state", session);
    try {
      // Same marker track-workflow-events.sh writes after a plan-file write.
      spawnSync("bash", ["-c", `mkdir -p "${stateDir}" && : > "${stateDir}/last-plan-write"`]);
      const a = runHook(session, "Edit", path.join(ROOT, "src", "server", "index.ts"));
      expect(a.stderr).not.toContain("Tier A");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("fails toward Tier A when the classifier cannot run", () => {
    const dir = mkdtempSync(path.join(ROOT, ".claude", ".workflow-state", "vitest-tierfail-"));
    try {
      const run = spawnSync(
        "bash",
        [
          "-c",
          'source .claude/hooks/_workflow-state.sh; PATH=/nonexistent _ws_is_tier_a_edit "docs/reviews/x.md" 1 "" && echo A || echo B',
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
      // With no node on PATH the classifier cannot run; the predicate must say A.
      expect(run.stdout.trim()).toBe("A");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
