import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The `vitest-windows` job (#2397): the full vitest suite on `windows-latest`.
 *
 * The job is ADVISORY. It is not a required status check, so a red run blocks
 * nothing; #2398 holds the dated decision on whether it becomes one. ADR-051:
 * the job does the work, and this test, inside `check` on the ubuntu leg, pins
 * the job's shape, so removing or disarming it turns a required check red.
 *
 * What this pins: the job exists under this id, on a literal Windows runner,
 * and runs `check`'s own setup, install, build, vitest command and file
 * anchor, each exactly as written, with nothing that lets it skip or pass on a
 * failure; its two accommodations for the hosted runner, by exact value, so
 * the list cannot grow unseen; and, of the workflow it inherits from, the
 * push trigger, the trigger set and the read-only default token.
 *
 * What this cannot pin, and the job does not show either:
 *  - A test skipped on Windows. The anchor compares files, never statuses
 *    (`scripts/ci/vitest-file-anchor.mjs`), so a `skipIf(win32)` added to a
 *    test, or a platform branch in a setup file, leaves the job green with
 *    less running. `windows-acl-proof` is the job that refuses a skip.
 *  - That a red run blocks a merge. Only branch protection does that.
 *
 * ADR-051 rule 5, one owner per fact. Not re-asserted here:
 *  - the literal of `check`'s Test command and of its anchor step:
 *    `vitest-file-anchor-wiring.test.ts`. This file compares the Windows job's
 *    steps to `check`'s parsed ones.
 *  - `package.json`'s `test` script, and "the workflow sets no `env` or
 *    `defaults`": `ownership-flag-on-wiring.test.ts`.
 *  - `package.json`'s `build` script cannot swallow a failure:
 *    `tests/build/third-party-notices-wiring.test.ts` (its last command) and
 *    `e2e-guard-wiring.test.ts` (its client step).
 *  - `pull_request` and `merge_group` trigger unfiltered:
 *    `windows-acl-proof-wiring.test.ts`.
 *  - the action SHAs: `workflow-action-pin.test.ts`.
 *  - the `npm ci --ignore-scripts` spelling and site count:
 *    `release-ci-hygiene.test.ts`.
 */

type Step = Record<string, unknown>;
type Job = Record<string, unknown> & { steps: Step[] };

const workflow = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8")) as {
  on: Record<string, unknown>;
  permissions?: unknown;
  jobs: Record<string, Job>;
};

const JOB_ID = "vitest-windows";

function windowsJob(): Job {
  const job = workflow.jobs[JOB_ID];
  if (!job) {
    throw new Error(
      `.github/workflows/ci.yml has no \`${JOB_ID}\` job. Nothing in CI runs the vitest suite ` +
        "on Windows again (#2397) — see tests/scripts/vitest-windows-wiring.test.ts.",
    );
  }
  return job;
}

function checkStep(predicate: (s: Step) => boolean, label: string): Step {
  const step = workflow.jobs.check.steps.find(predicate);
  if (!step) throw new Error(`ci.yml: check has no ${label} step`);
  return step;
}

const usesStep = (prefix: string) =>
  checkStep((s) => typeof s.uses === "string" && s.uses.startsWith(prefix), prefix);

const isFullSuiteRun = (s: Step) => typeof s.run === "string" && /^npm test\b/.test(s.run.trim());

/** Any spelling that starts vitest from a step: `npm test`, `npx vitest`, `vitest run`. */
const invokesVitest = (s: Step) =>
  typeof s.run === "string" && /\b(npm (run )?test\b|vitest\b)/.test(s.run);

/** Does this job run on Windows, directly or through a matrix leg? */
function reachesWindows(job: Job): boolean {
  if (String(job["runs-on"] ?? "").startsWith("windows")) return true;
  return /windows/.test(JSON.stringify(job.strategy ?? {}));
}

describe("the vitest-windows job (#2397, ADR-051)", () => {
  it("exists under that id, on a literal Windows runner, with nothing that can skip or soften it", () => {
    const job = windowsJob();
    // The key set, not a list of forbidden keys: `if` and a failed `needs` skip
    // the job, `continue-on-error` turns its red green, a `strategy` can move it
    // off Windows while `runs-on` reads `${{ matrix.os }}`, `name` renames the
    // check #2398 would make required, and job `env`/`defaults` change what
    // every step runs under.
    expect(Object.keys(job).sort()).toEqual(["runs-on", "steps", "timeout-minutes"]);
    expect(job["runs-on"]).toBe("windows-latest");
    // GitHub's default is six hours, and a hung advisory job keeps a PR's
    // checks pending that long. Exact, because a value below the job's real
    // duration (about nine minutes) turns every run red: about three times it.
    expect(job["timeout-minutes"]).toBe(30);
  });

  it("runs exactly these steps, in this order, each as check runs it but for two accommodations", () => {
    // Whole step objects, so a `continue-on-error`, `if`, `shell`, `env` or
    // `timeout-minutes` added to any step, an argument appended to a `run`
    // (`|| true`, an `--exclude`), or a dropped reporter flag, changes the
    // object and fails.
    //
    // The two accommodations are literals for the same reason. Each makes the
    // hosted runner look like an ordinary Windows machine (ci.yml says what
    // fails without it); neither skips a test. A third, or a quarantine list,
    // has to be written here first, where a required check reads it.
    const anchor = checkStep(
      (s) => typeof s.run === "string" && s.run.includes("vitest-file-anchor"),
      "file anchor",
    );
    expect(windowsJob().steps).toEqual([
      usesStep("actions/checkout@"),
      usesStep("actions/setup-node@"),
      usesStep("actions/setup-python@"),
      checkStep((s) => s.run === "npm ci --ignore-scripts", "npm ci"),
      checkStep((s) => s.name === "Build", "Build"),
      {
        name: "Give TEMP its long name",
        run: `node -e "const fs=require('node:fs');const t=fs.realpathSync.native(require('node:os').tmpdir());fs.appendFileSync(process.env.GITHUB_ENV,'TEMP='+t+'\\nTMP='+t+'\\n')"`,
      },
      {
        name: "Create the \\tmp directory document-service.test.ts writes under",
        run: `node -e "require('node:fs').mkdirSync('/tmp',{recursive:true})"`,
      },
      checkStep(isFullSuiteRun, "Test"),
      anchor,
    ]);
    // The comparison above is to `check`'s steps, so it would also pass if
    // `check` lost its anchor's condition. That literal has an owner
    // (`vitest-file-anchor-wiring.test.ts`); this only refuses a vacuous match.
    expect(anchor.if).toBeDefined();
    expect(checkStep(isFullSuiteRun, "Test").run).toContain("--outputFile.json=");
  });

  it("is the only job that runs the suite on Windows", () => {
    // A second Windows suite job, or a Windows leg added to `check`'s matrix,
    // would leave this one in place and pinned while the copy drifts. The brief
    // for #2397 also rules out the matrix: `check` is a required check by name.
    const ids = Object.entries(workflow.jobs)
      .filter(([, job]) => reachesWindows(job) && (job.steps ?? []).some(invokesVitest))
      .map(([id]) => id);
    expect(ids).toEqual([JOB_ID]);
  });
});

describe("the workflow the job inherits from", () => {
  it("still runs on every push to master", () => {
    // The whole value, so a `paths-ignore` or a second branch filter added
    // beside `branches` fails too.
    expect(workflow.on.push).toEqual({ branches: ["master"] });
  });

  it("defaults every job to a read-only token, and triggers on these four events only", () => {
    // The job declares no permissions of its own (its key set is pinned
    // above), so this block is all it has.
    expect(workflow.permissions).toEqual({ contents: "read" });
    // The job runs the build and the whole suite for pull requests, forks
    // included. `pull_request_target` or `workflow_run` would run that with the
    // base repository's token and cache scope, so the set is exact.
    // `windows-acl-proof-wiring.test.ts` owns that `pull_request` and
    // `merge_group` are unfiltered; this owns that nothing else is here.
    expect(Object.keys(workflow.on).sort()).toEqual([
      "merge_group",
      "pull_request",
      "push",
      "workflow_dispatch",
    ]);
  });
});

describe("docs match the wiring", () => {
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

  it("ADR-051's instances table has a row for the job and this test", () => {
    const row = read("docs/decisions.md")
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes("`vitest-windows`"));
    expect(row, "ADR-051's table has no `vitest-windows` row").toBeDefined();
    expect(row).toContain("tests/scripts/vitest-windows-wiring.test.ts");
  });

  it.each(["CLAUDE.md", "CONTRIBUTING.md"])("%s names the job and says it is advisory", (rel) => {
    // #1399 was a doc describing less than existed; a doc that calls this job
    // blocking would be the same error in the other direction. One sentence
    // must carry both words, so "advisory" elsewhere in the file does not count.
    const sentence = read(rel)
      .split(/(?<=[.;])\s+/)
      .find((s) => s.includes("`vitest-windows`") && /advisory/i.test(s));
    expect(sentence, `${rel} never calls \`vitest-windows\` advisory`).toBeDefined();
  });
});
