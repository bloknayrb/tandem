import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIR = path.join(ROOT, ".github/workflows");

/**
 * ADR-051 wiring tests for the release/CI hygiene fixes in wave 7 (#1832,
 * #1830, #1748).
 *
 * Why here rather than in the workflows themselves: `tauri-release.yml` runs on
 * `push: tags: ["v*"]` and `publish.yml` on a published release, so **no
 * PR-time check reads either file**. A step deleted, disarmed with `|| true`,
 * given `continue-on-error: true`, or fenced behind an `if:` that stops
 * matching leaves every required check green with the guarantee gone. `check`
 * IS a required status check on `master`, so an assertion in here is what makes
 * these edits hold.
 *
 * ADR-051 rules followed: parse the YAML rather than substring-matching the
 * file (a comment is absent from the parse tree, so a marker must live inside a
 * `run` body to be findable); throw rather than return a sentinel when a
 * subject is missing; pin SETS and COUNTS rather than validating whichever
 * members happen to be present; pin bodies by exact equality rather than by
 * regex, because `toContain`/`/…/` are satisfied by `… || true` and by a
 * commented-out flag.
 */

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  if?: unknown;
  "continue-on-error"?: unknown;
};

type Job = {
  steps?: Step[];
  "continue-on-error"?: unknown;
};

type Workflow = {
  jobs?: Record<string, Job>;
};

function workflowFiles(): string[] {
  const files = readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
  if (files.length === 0) {
    throw new Error(`no workflow files under ${WORKFLOW_DIR}`);
  }
  return files;
}

function loadWorkflow(file: string): Workflow {
  return parse(readFileSync(path.join(WORKFLOW_DIR, file), "utf8")) as Workflow;
}

/** Every step in every job of one workflow, tagged with where it came from. */
function stepsOf(file: string): { file: string; job: string; step: Step }[] {
  const workflow = loadWorkflow(file);
  const out: { file: string; job: string; step: Step }[] = [];
  for (const [job, body] of Object.entries(workflow.jobs ?? {})) {
    for (const step of body?.steps ?? []) {
      out.push({ file, job, step });
    }
  }
  return out;
}

function allSteps(): { file: string; job: string; step: Step }[] {
  return workflowFiles().flatMap(stepsOf);
}

/**
 * #1832 — `npm ci` runs a dependency tree's install scripts in jobs that later
 * log into Azure and sign Windows binaries, or mint an npm provenance
 * attestation. `--ignore-scripts` closes the install-time entrypoint.
 *
 * The exact-equality pin is deliberate and is the rule
 * `typecheck-tests-wiring.test.ts:134-138` states: a regex like
 * `/\bnpm ci\b[^\n]*--ignore-scripts/` is satisfied by
 * `npm ci --ignore-scripts || true` and by `npm ci # --ignore-scripts`, so
 * equality subsumes the whole exit-code-masking family in one assertion. The
 * count pin is what stops five of the six being deleted, and what makes a
 * seventh site arrive red rather than silently unflagged.
 */
describe("#1832 npm ci runs no dependency lifecycle scripts", () => {
  const EXPECTED = "npm ci --ignore-scripts";
  const EXPECTED_SITES = 6;

  function installSteps() {
    return allSteps().filter(({ step }) => step.run?.includes("npm ci"));
  }

  it("has exactly six npm ci sites across the workflows", () => {
    const sites = installSteps().map(({ file, job }) => `${file}:${job}`);
    expect(
      sites.length,
      `expected ${EXPECTED_SITES} \`npm ci\` steps, found ${sites.length}: ${sites.join(", ")}`,
    ).toBe(EXPECTED_SITES);
  });

  it("carries --ignore-scripts at every site, with nothing appended", () => {
    const sites = installSteps();
    expect(sites.length).toBeGreaterThan(0);
    for (const { file, job, step } of sites) {
      expect(step.run?.trim(), `${file}:${job} \`npm ci\` step`).toBe(EXPECTED);
    }
  });
});
