import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HISTORICAL, HUB, listFiles } from "../../scripts/check-doc-links.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The ADR-051 half of the doc-link gate.
 *
 * `npm run check:links` ran in neither CI nor the hooks for its whole life, so
 * a moved doc broke links silently until someone happened to run it. The step
 * now runs inside `check`, which is required — and being required makes a RED
 * block but does nothing about a step that never runs. `|| true` on the npm
 * script, `continue-on-error: true`, an `if:` or deleting the step each leave
 * `check` green with the vault rotting underneath it (#1229's shape).
 *
 * So this file PARSES `ci.yml` (ADR-051 rule 2), pins the step's command and
 * the npm script by exact equality (rule 1), asserts absent keys as absent
 * (rule 4), and pins the historical set as a literal (rule 3) so shrinking or
 * widening the exemption is a visible test edit, not a quiet one.
 *
 * One owner per fact (rule 5): the checker's behaviour is owned by
 * `check-links-checker.test.ts`; this file owns only the wiring.
 */

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  if?: unknown;
  with?: Record<string, unknown>;
  shell?: unknown;
  "continue-on-error"?: unknown;
};
type Defaults = { run?: { shell?: unknown } };
type Job = {
  needs?: unknown;
  if?: unknown;
  "continue-on-error"?: unknown;
  defaults?: Defaults;
  steps?: Step[];
};

const workflow = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8")) as {
  on: Record<string, unknown>;
  defaults?: Defaults;
  jobs: Record<string, Job>;
};
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
  scripts: Record<string, string>;
};

const COMMAND = "npm run check:links";
const SCRIPT = "node scripts/check-doc-links.mjs";

function checkJob(): Job {
  const job = workflow.jobs.check;
  if (!job) throw new Error(".github/workflows/ci.yml has no `check` job");
  return job;
}

/** Throws rather than returning -1, so an ordering assertion cannot pass vacuously. */
function stepIndex(label: string, predicate: (s: Step) => boolean): number {
  const index = (checkJob().steps ?? []).findIndex(predicate);
  if (index < 0) throw new Error(`.github/workflows/ci.yml: \`check\` has no step ${label}`);
  return index;
}

const isLinkStep = (s: Step) => s.run?.includes("check:links") ?? false;

describe("check:links CI wiring", () => {
  it("runs in `check` as a bare command", () => {
    const step = checkJob().steps?.[stepIndex(COMMAND, isLinkStep)];
    // Exact equality subsumes the exit-code-masking family (`|| true`, `; true`,
    // `set +e &&`, a trailing pipe) in one assertion.
    expect(step?.run?.trim()).toBe(COMMAND);
  });

  it("is unconditional and blocking, at step, job and workflow level", () => {
    const job = checkJob();
    const step = job.steps?.[stepIndex(COMMAND, isLinkStep)];
    expect(step?.if, "an `if:` can silence the gate while leaving it visible").toBeUndefined();
    expect(step?.["continue-on-error"]).toBeUndefined();
    expect(step?.shell).toBeUndefined();
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"], "masks every step in the job").toBeUndefined();
    expect(
      job.needs,
      "a failing dependency would skip the job, which reads as a pass",
    ).toBeUndefined();
    expect(job.defaults?.run?.shell).toBeUndefined();
    expect(workflow.defaults?.run?.shell).toBeUndefined();
  });

  it("runs after a full checkout and the dependency install", () => {
    const checkout = stepIndex(
      "actions/checkout",
      (s) => s.uses?.startsWith("actions/checkout@") ?? false,
    );
    const install = stepIndex("`npm ci`", (s) => /^npm ci\b/.test(s.run?.trim() ?? ""));
    const links = stepIndex(COMMAND, isLinkStep);
    expect(links).toBeGreaterThan(checkout);
    expect(links).toBeGreaterThan(install);
    // The checker lists files with `git ls-files`. A sparse checkout would hand
    // it a partial tree that still reports success.
    const checkoutStep = checkJob().steps?.[checkout];
    expect(checkoutStep?.with?.["sparse-checkout"]).toBeUndefined();
  });

  it("fires on pull requests without a branch or path filter", () => {
    expect(workflow.on.pull_request).toBeNull();
  });

  it("delegates to a script that cannot mask its own exit code", () => {
    expect(pkg.scripts["check:links"]?.trim()).toBe(SCRIPT);
  });
});

describe("check:links inputs", () => {
  it("selects files from git, not a filesystem walk", () => {
    // The fallback walk would scan gitignored trees (`.claude/worktrees/`) and
    // fail locally on links CI never sees, or vice versa. In this checkout git
    // must be what answers.
    const { source, files } = listFiles(ROOT, ".md");
    expect(source).toBe("git");
    expect(files).toContain("README.md");
    expect(files.some((f) => f.startsWith(".claude/worktrees/"))).toBe(false);
  });

  it("keeps the hub and the historical set exactly as reviewed", () => {
    expect(HUB).toBe("docs/README.md");
    expect(HISTORICAL).toEqual([
      { path: "docs/plans/", except: ["docs/plans/README.md"] },
      { path: "docs/superpowers/", except: ["docs/superpowers/README.md"] },
      { path: "docs/archive/" },
      { path: "docs/triage/" },
      { path: "docs/design-history/", except: ["docs/design-history/README.md"] },
      {
        path: "docs/reviews/",
        except: ["docs/reviews/README.md", "docs/reviews/2026-10-20-docs-audit.md"],
      },
      { path: "docs/spikes/", except: ["docs/spikes/README.md"] },
      { path: "docs/roadmap-history.md" },
      { path: "docs/v10-triage.md" },
    ]);
  });
});
