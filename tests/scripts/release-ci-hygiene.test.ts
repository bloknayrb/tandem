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

function jobOf(file: string, name: string): Job {
  const job = loadWorkflow(file).jobs?.[name];
  if (!job) throw new Error(`${file} has no job \`${name}\``);
  return job;
}

/**
 * Locate a step by a marker inside its own `run` body. Throws on zero or more
 * than one — an assertion that silently passes when its subject is deleted is
 * the likeliest reversion.
 */
function stepByMarker(job: Job, marker: string): { index: number; step: Step } {
  const steps = job.steps ?? [];
  const hits = steps
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => step.run?.includes(marker));
  if (hits.length !== 1) {
    throw new Error(`expected exactly 1 step carrying \`${marker}\`, found ${hits.length}`);
  }
  return hits[0] as { index: number; step: Step };
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

/**
 * #1830 — nothing verified the updater `.sig` against `tauri.conf.json`'s
 * pubkey, so a private key that no longer matches ships green and breaks the
 * update on every installed copy.
 *
 * The step first executes at the next `v*` tag, so this wiring test is the only
 * thing that can hold it. Finding the step by a marker inside its own `run`
 * body is deliberate: a YAML comment is absent from the parse tree, so a marker
 * on the `name:` line would be invisible here. Same shape as
 * `release-signing-gates.test.ts`'s APPLE_GATE_RUN.
 */
describe("#1830 updater signatures are verified before a release is published", () => {
  const FILE = "tauri-release.yml";
  const JOB = "verify-release-manifest";
  const MARKER = "# gate:updater-sig";
  const RUN = `${MARKER}\nnode scripts/ci/verify-updater-signatures.mjs\n`;

  it("runs the verifier with the exact body and env it needs", () => {
    const { step } = stepByMarker(jobOf(FILE, JOB), MARKER);
    // Exact equality including the marker line: `toContain` is satisfied by
    // `node … || true` and by a commented-out invocation.
    expect(step.run).toBe(RUN);
    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      RELEASE_ID: "${{ needs.create-release.outputs.release_id }}",
    });
  });

  it("cannot be disarmed at the step level", () => {
    const { step } = stepByMarker(jobOf(FILE, JOB), MARKER);
    // Parsed fields, never substrings of the run line (ADR-051 rule 2), and no
    // `?? false` default (rule 4) — absent is the state being asserted.
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
  });

  it("cannot be disarmed at the job level", () => {
    // One line, because a single `continue-on-error: true` here greens both the
    // existing shape gate and this signature gate at once, in a workflow no
    // required check reads. Precedent: typecheck-tests-wiring.test.ts:145-148.
    expect(jobOf(FILE, JOB)["continue-on-error"]).toBeUndefined();
  });

  it("checks out the repo first, or the script cannot read tauri.conf.json", () => {
    const job = jobOf(FILE, JOB);
    const { index } = stepByMarker(job, MARKER);
    const checkout = (job.steps ?? []).findIndex((s) => s.uses?.startsWith("actions/checkout@"));
    if (checkout === -1) throw new Error(`${FILE}:${JOB} has no checkout step`);
    expect(checkout).toBeLessThan(index);
  });
});

/**
 * #1748 items 1 and 2.
 *
 * 1. An RC tag would auto-update every user, on BOTH channels: the desktop
 *    updater reads `releases/latest/download/latest.json` and GitHub resolves
 *    `releases/latest` to the newest non-prerelease release, while `npm publish`
 *    with no `--tag` stamps `latest`.
 * 2. `Test` ran before `Build`, so `tests/build/version-baked.test.ts` skipped
 *    and `tests/monitor/build-artifact.test.ts` PASSED with zero assertions on
 *    every CI run since it was written.
 *
 * Item 3 (NPM_TOKEN expiry) was resolved by #1878 — `publish.yml` has no
 * NPM_TOKEN at all, it uses npm Trusted Publishing (OIDC) — and item 4 (an
 * inert `.github/codeql/codeql-config.yml`) is a deletion, so neither is
 * asserted here.
 */
describe("#1748 a prerelease tag reaches neither update channel", () => {
  it("derives the desktop release's prerelease flag from the tag", () => {
    const job = jobOf("tauri-release.yml", "create-release");
    const step = (job.steps ?? []).find((s) => s.uses?.startsWith("actions/github-script@"));
    if (!step) throw new Error("create-release has no github-script step");
    const script = step.with?.script;
    if (typeof script !== "string") throw new Error("github-script step has no `script`");

    // Not "the literal `prerelease: tag.includes('-')` twice": one
    // `const prerelease = tag.includes('-')` passed to both calls is correct.
    expect(script).toContain("tag.includes('-')");
    expect(script).not.toContain("prerelease: false");
    // The reuse branch returns before createRelease, so a re-run on a tag whose
    // first run created the draft would otherwise inherit that run's flag — and
    // re-runs are normal for a four-platform signed build.
    expect(script).toContain("updateRelease");

    // Scoped to the updateRelease ARGUMENTS, not the whole script:
    // `context.repo.owner` is already in the script twice (listReleases,
    // createRelease), so a whole-script assertion passes green against the bare
    // `updateRelease({ owner, repo, … })` shorthand that ReferenceErrors at a
    // `v*` tag — the one thing this exists to prevent.
    const at = script.indexOf("updateRelease(");
    if (at === -1) throw new Error("no updateRelease( call to scope the repo assertion to");
    const call = script.slice(at, script.indexOf("});", at));
    expect(call).toContain("owner: context.repo.owner");
    expect(call).toContain("repo: context.repo.repo");
  });

  it("derives the npm dist-tag inside the publish step itself", () => {
    const job = jobOf("publish.yml", "publish");
    const hits = (job.steps ?? []).filter((s) => s.run?.includes("npm publish"));
    if (hits.length !== 1) {
      throw new Error(`expected exactly 1 \`npm publish\` step, found ${hits.length}`);
    }
    const step = hits[0] as Step;
    // Exact equality: the `case` arms and the publish line are ONE string, so
    // the derivation cannot be deleted or rewritten without reddening this.
    expect(step.run?.trim()).toBe(
      [
        "set -euo pipefail",
        'case "$TAG" in',
        "  *-*) NPM_TAG=next ;;",
        "  *)   NPM_TAG=latest ;;",
        "esac",
        'npm publish --provenance --access public --tag "$NPM_TAG"',
      ].join("\n"),
    );
    expect(step.env).toEqual({ TAG: "${{ inputs.tag || github.ref_name }}" });
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
  });

  it("has no step anywhere that runs a bare `npm publish` without --tag", () => {
    for (const { file, job, step } of allSteps()) {
      if (!step.run?.includes("npm publish")) continue;
      expect(step.run, `${file}:${job} publishes without a --tag`).toContain("--tag");
    }
  });

  it("runs Build before Test in `check`, so the dist-gated suites assert", () => {
    const steps = jobOf("ci.yml", "check").steps ?? [];
    const build = steps.findIndex((s) => s.run?.trim() === "npm run build");
    const test = steps.findIndex((s) => /^npm test\b/.test(s.run?.trim() ?? ""));
    if (build === -1) throw new Error("ci.yml:check has no `npm run build` step");
    if (test === -1) throw new Error("ci.yml:check has no `npm test` step");
    // Reorder these back and both dist-gated suites silently stop asserting:
    // version-baked.test.ts skips, and build-artifact.test.ts skips visibly
    // only because #1748 replaced its two early `return`s with a skipIf.
    expect(build).toBeLessThan(test);
  });

  it("tells the release runbook which publish command a prerelease takes", () => {
    const skill = readFileSync(path.join(ROOT, ".claude/skills/release/SKILL.md"), "utf8");
    const publishLines = skill
      .split("\n")
      .filter((line) => line.includes("gh release edit") && line.includes("--draft=false"));
    if (publishLines.length === 0) {
      throw new Error("release SKILL.md has no step-7 publish command");
    }
    const prerelease = publishLines.filter((line) => line.includes("--prerelease"));
    const normal = publishLines.filter((line) => !line.includes("--prerelease"));
    if (prerelease.length === 0) throw new Error("SKILL.md has no prerelease publish branch");
    if (normal.length === 0) throw new Error("SKILL.md has no non-prerelease publish branch");

    // Whole-token, never `line.includes("--latest")`: the substring form goes
    // red on `--draft=false --prerelease --latest=false`, which is exactly the
    // line the fix introduces. Precedent: skill-instruction-contract.test.ts:257.
    const BARE_LATEST = /(^|\s)--latest(\s|$)/;
    expect(normal.some((line) => BARE_LATEST.test(line))).toBe(true);
    for (const line of prerelease) {
      expect(line).toContain("--latest=false");
      expect(BARE_LATEST.test(line), `prerelease branch pairs a bare --latest: ${line}`).toBe(
        false,
      );
    }
  });
});
