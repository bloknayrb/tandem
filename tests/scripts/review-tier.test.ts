import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classify,
  globToRegExp,
  loadTiers,
  realpathish,
  toRepoRelative,
} from "../../.claude/hooks/review-tier.mjs";

/**
 * ADR-058 review tiers. `.claude/review-tiers.json` decides which changes may
 * skip plan review; this pins that the allowlist stays narrow and fails closed,
 * and that `nudge-plan-review.sh` warns on a Tier A edit made with no plan.
 *
 * Enforcement is a nudge, never a block (ADR-058 names the residuals: the
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

  it.each([
    ".claude/plans/feature.md",
    ".claude/worktrees/x/src/a.ts",
    ".claude/.workflow-state/s/m",
  ])("%s is agent scratch, not a change", (rel) => {
    expect(tier(rel)).toBe("outside");
  });

  it("resolves a symlinked checkout to the same repo-relative path", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "review-tier-link-"));
    try {
      const link = path.join(dir, "repo");
      symlinkSync(ROOT, link);
      expect(toRepoRelative(path.join(link, "src", "server", "index.ts"))).toBe(
        "src/server/index.ts",
      );
      // A file that does not exist yet resolves through its nearest existing ancestor.
      expect(toRepoRelative(path.join(link, "tests", "server", "not-yet.test.ts"))).toBe(
        "tests/server/not-yet.test.ts",
      );
      expect(realpathish(path.join(link, "no", "such", "dir", "f.ts"))).toBe(
        path.join(ROOT, "no", "such", "dir", "f.ts"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  /** The reminder the model would see: the stdout JSON (jq or node builds it). */
  const reminder = (run: ReturnType<typeof runHook>): string => {
    if (run.stdout.trim() === "") return "";
    const out = JSON.parse(run.stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(out.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    return out.hookSpecificOutput?.additionalContext ?? "";
  };

  it("warns once on a Tier A edit with no plan, and never on Tier B", () => {
    const session = `vitest-tier-${process.pid}`;
    const stateDir = path.join(ROOT, ".claude", ".workflow-state", session);
    try {
      const b = runHook(session, "Edit", path.join(ROOT, "docs", "reviews", "x.md"));
      expect(b.status).toBe(0);
      expect(reminder(b)).not.toContain("Tier A");

      const plan = runHook(session, "Write", path.join(ROOT, ".claude", "plans", "p.md"));
      expect(reminder(plan), "writing the plan itself is not a Tier A edit").not.toContain(
        "Tier A",
      );

      const a = runHook(session, "Edit", path.join(ROOT, "src", "server", "index.ts"));
      expect(a.status, "the nudge never blocks").toBe(0);
      expect(reminder(a)).toContain("Tier A edit with no plan this session");

      const again = runHook(session, "Edit", path.join(ROOT, "src", "server", "index.ts"));
      expect(reminder(again), "one-shot per session").not.toContain("Tier A");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("stays quiet once a plan was written this session", () => {
    const session = `vitest-tier-plan-${process.pid}`;
    const stateDir = path.join(ROOT, ".claude", ".workflow-state", session);
    try {
      // Same marker track-workflow-events.sh writes after a plan-file write.
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path.join(stateDir, "last-plan-write"), "");
      const a = runHook(session, "Edit", path.join(ROOT, "src", "server", "index.ts"));
      expect(reminder(a)).not.toContain("Tier A");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["node is missing", ""],
    ["node runs but prints nothing", "#!/bin/sh\nexit 0\n"],
    ["node prints something unexpected", "#!/bin/sh\necho maybe\n"],
  ])("fails toward Tier A when %s", (_label, stub) => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "review-tier-bin-"));
    try {
      if (stub) {
        writeFileSync(path.join(bin, "node"), stub);
        chmodSync(path.join(bin, "node"), 0o755);
      }
      // A Tier B path, so only a classifier failure can make this say A.
      const run = spawnSync(
        "bash",
        [
          "-c",
          'source .claude/hooks/_workflow-state.sh; _ws_is_tier_a_edit "docs/reviews/x.md" 1 "" && echo A || echo B',
        ],
        { cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } },
      );
      expect(run.stdout.trim()).toBe("A");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
