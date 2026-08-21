import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The session-monitor acceptance harness (82 tests) had no runner in CI or the
 * pre-push hook until #1399. #1397 bumped `skills/tandem/SKILL.md` to version 11
 * and broke 13 of those tests while every check on both PRs stayed green; the
 * breakage was found by hand, on merged content.
 *
 * This file is the guard on the wiring that fixed it, and it PARSES the workflow
 * rather than substring-matching it. That is not stylistic. An earlier draft used
 * `toContain` against the raw text and was mutation-tested: three separate
 * reversions -- commenting the whole block out with `#`, adding
 * `jobs.check.continue-on-error: true`, and deleting the `setup-python` step --
 * left every assertion green. `jobs.<id>.continue-on-error` is valid Actions
 * syntax that neuters an entire job, and a skipped job's check-run conclusion is
 * `skipped`, which required-status-checks treat as passing. Those are the #1229
 * failure mode exactly: a gate that reports success when it could not evaluate.
 *
 * Steps are located by their `run` value, never by their prose `name`. A rename
 * must not be able to blind the guard, and a commented-out step simply does not
 * exist in the parsed document.
 *
 * Scope note: nothing else in `tests/` reads `.github/workflows/ci.yml`. This is
 * the first, which is part of why the gap survived as long as it did.
 */

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: unknown;
  "continue-on-error"?: unknown;
  shell?: unknown;
};

/**
 * `defaults.run.shell` is settable at BOTH workflow and job level, and either
 * placement overrides the shell of every `run:` step below it. It is the one row
 * of the step-level defence table whose job/workflow twin would otherwise be
 * uncovered -- measured: with the step-level `shell:` guard in place, adding
 * `defaults: {run: {shell: 'bash -c "bash {0}; exit 0"'}}` at either level left
 * this file 19/19 green while every `run:` step in the job exited 0 regardless of
 * the command's real status.
 */
type Defaults = { run?: { shell?: unknown } };

const workflow = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8")) as {
  on: Record<string, unknown>;
  defaults?: Defaults;
  jobs: Record<
    string,
    { if?: unknown; "continue-on-error"?: unknown; defaults?: Defaults; steps: Step[] }
  >;
};

const checkJob = workflow.jobs.check;
const steps = checkJob.steps;

const HARNESS_COMMAND = "npm run test:acceptance-harness";

/**
 * Throws rather than returning -1. `tests/docs/wake-availability-claims.test.ts`
 * records why: "`indexOf` returning -1 is exactly how the previous version of
 * this guard degraded into silently asserting against an empty or whole-file
 * window." An ordering assertion built on a sentinel passes vacuously the moment
 * the thing it orders is deleted, which is the likeliest reversion of all.
 */
function stepIndex(label: string, predicate: (step: Step) => boolean): number {
  const index = steps.findIndex(predicate);
  if (index < 0) {
    throw new Error(`.github/workflows/ci.yml: the "check" job has no step matching ${label}`);
  }
  return index;
}

function extract(label: string, source: string, pattern: RegExp): string {
  const match = source.match(pattern);
  if (!match?.[1]) {
    throw new Error(`cannot extract ${label} with ${pattern}`);
  }
  return match[1];
}

/**
 * Deliberately a function, not a module-level const. Resolved at import time, a
 * missing step throws during collection and takes the whole FILE down as one
 * error -- including the mutation guards and the doc assertions, which have
 * nothing to do with it. Per-test resolution keeps each failure attributable,
 * which is what makes the mutation matrix in the PR body readable.
 */
function harnessStepIndex(): number {
  return stepIndex("the acceptance-harness command", (s) =>
    typeof s.run === "string" ? s.run.includes("test:acceptance-harness") : false,
  );
}

describe("acceptance-harness CI wiring", () => {
  it("runs the harness from the check job, as a bare command", () => {
    // Exact equality, not `toContain`. It subsumes the whole exit-code-masking
    // family in one assertion -- `|| true`, `; true`, `|| echo ...`, `set +e &&`,
    // a trailing pipe -- which a denylist only ever covers partly.
    expect(steps[harnessStepIndex()].run?.trim()).toBe(HARNESS_COMMAND);
  });

  it("keeps the harness step unconditional and blocking", () => {
    // The only mechanism by which a step in a running job is skipped is `if:`.
    // Note this catches `if:` written ABOVE `name:`, which a line-slicing text
    // guard misses by accident.
    const step = steps[harnessStepIndex()];
    expect(
      step.if,
      "an `if:` on the harness step lets it skip, which reads as pass",
    ).toBeUndefined();
    expect(step["continue-on-error"] ?? false).toBeFalsy();
    // `shell:` is the third way to turn a failing `run` into a passing step, and
    // it does it without touching the `run` value that the assertion above pins.
    // `shell: bash -c "bash {0}; exit 0"` forces the exit status to 0.
    expect(step.shell ?? "default", "a custom `shell:` can swallow the exit status").toBe(
      "default",
    );
  });

  it("keeps the whole check job unconditional and blocking", () => {
    // The job level is outside the step-level guarantee. A skipped job's
    // conclusion is `skipped`, which required-status-checks treat as passing, and
    // `continue-on-error` at job level neuters every step at once.
    expect(checkJob.if, "an `if:` on the check job skips it, which reads as pass").toBeUndefined();
    expect(checkJob["continue-on-error"] ?? false).toBeFalsy();
    // The job/workflow twin of the step-level `shell:` guard above. `defaults.run.shell`
    // rewrites the shell of every `run:` step at once without touching a single step,
    // so `bash -c "bash {0}; exit 0"` makes the harness report success while failing.
    expect(
      checkJob.defaults?.run?.shell,
      "a job-level `defaults.run.shell` swallows the exit status of every step in the job",
    ).toBeUndefined();
    expect(
      workflow.defaults?.run?.shell,
      "a workflow-level `defaults.run.shell` swallows the exit status of every step in every job",
    ).toBeUndefined();
  });

  it("still triggers on every pull request, unfiltered", () => {
    // A perfectly-written gate that never runs is the cheapest way to disable
    // this without touching the job at all -- and the key merely EXISTING is not
    // enough. `pull_request: {branches: [release/**]}` and
    // `pull_request: {paths-ignore: ['**']}` both keep the key while never firing
    // on a PR to master, and the second is a realistic performance-motivated edit.
    // A bare `pull_request:` with no body parses to null under yaml@2.8.x, so
    // null is exactly "unfiltered".
    expect(Object.keys(workflow.on)).toContain("pull_request");
    expect(
      workflow.on.pull_request,
      "`on.pull_request` has filters: a branch/path filter can exclude PRs to master while leaving this key in place",
    ).toBeNull();
  });

  it("fetches the tag the harness actually reads, unconditionally", () => {
    // The harness reads its immutable v9 baseline with
    // `git show <tag>:skills/tandem/SKILL.md`, and checkout@v6 is depth-1 and
    // tagless. Nothing else in the repo ties the workflow's tag to the Python
    // constant, so a bump of SEEDED_SKILL_TAG would otherwise leave CI fetching
    // the old tag and every PR failing with a confusing `git show` error.
    const fetchIndex = stepIndex("a `git fetch` of the skill-baseline tag", (s) =>
      typeof s.run === "string" ? /\bgit\s+fetch\b/.test(s.run) : false,
    );
    const step = steps[fetchIndex];
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"] ?? false).toBeFalsy();
    expect(step.shell ?? "default").toBe("default");
    expect(step.run).not.toMatch(/\|\||;\s*true\b/);

    // Regex, not a literal command string: a behaviour-preserving rewrite (flag
    // reorder, an explicit refs/tags/ refspec) must not false-fail. Both sides
    // throw rather than coalescing to a sentinel that would compare equal.
    const workflowTag = extract(
      "the fetched tag from the ci.yml git fetch step",
      step.run as string,
      /(?:\btag\s+|refs\/tags\/)(v[0-9][^\s:]*)/,
    );
    const harnessSource = readFileSync(
      path.join(ROOT, "scripts/spikes/session_monitor_acceptance.py"),
      "utf-8",
    );
    const pythonTag = extract(
      "SEEDED_SKILL_TAG from scripts/spikes/session_monitor_acceptance.py",
      harnessSource,
      /^SEEDED_SKILL_TAG\s*=\s*"([^"]+)"/m,
    );
    expect(workflowTag).toBe(pythonTag);

    // The step's prose `name:` also carries the tag, and the ci.yml comment makes
    // that load-bearing for diagnosis ("must fail HERE, at a step whose name
    // carries the tag"). Pinned so a future SEEDED_SKILL_TAG bump cannot leave the
    // name pointing at the old tag while the command fetches the new one.
    expect(steps[fetchIndex].name ?? "").toContain(pythonTag);

    expect(fetchIndex).toBeLessThan(harnessStepIndex());
  });

  it("provisions python before both steps that need it", () => {
    // The npm script invokes bare `python`. Pinning the interpreter means a host
    // without it fails the job at a named step instead of the harness dying on
    // `python: not found` -- or, worse, a future author "fixing" that with an
    // `if:` guard.
    const pythonIndex = stepIndex("actions/setup-python", (s) =>
      typeof s.uses === "string" ? s.uses.startsWith("actions/setup-python@") : false,
    );
    expect(pythonIndex).toBeLessThan(harnessStepIndex());

    // The vitest step needs it too: the runner fixture suite in THIS file spawns
    // python. Those assertions fail closed on a missing interpreter, so this
    // ordering is what keeps that failure from being a confusing one.
    const testIndex = stepIndex("the vitest step", (s) =>
      typeof s.run === "string" ? /^npm test\b/.test(s.run.trim()) : false,
    );
    expect(pythonIndex).toBeLessThan(testIndex);
  });

  it("runs the harness after npm ci", () => {
    // Undocumented precondition, found by running the suite in a bare clone:
    // test_injector_rejects_non_loopback_endpoints spawns
    // scripts/spikes/session-monitor-user-event.mjs, which imports
    // @hocuspocus/provider. Above `npm ci` this fails as ERR_MODULE_NOT_FOUND,
    // which reads like a source bug rather than a step-ordering one.
    const installIndex = stepIndex("npm ci", (s) =>
      typeof s.run === "string" ? /^npm ci\b/.test(s.run.trim()) : false,
    );
    expect(installIndex).toBeLessThan(harnessStepIndex());
  });
});

describe("acceptance-harness runner is fail-closed", () => {
  const runnerRel = "scripts/spikes/run_acceptance_tests.py";
  const launcherRel = "scripts/spikes/run-acceptance-harness.mjs";

  it("is exactly what the npm script invokes, and exists", () => {
    // Exact equality for the same reason as the ci.yml `run:` assertion, and it
    // is not redundant with it: `npm run` propagates the SCRIPT's exit code, so
    // the entire exit-code-masking family the ci.yml assertion subsumes is
    // available intact one indirection down. `"... python run_acceptance_tests.py
    // || true"` and `"echo noop # run_acceptance_tests.py"` both satisfy a
    // substring check while leaving the gate completely dead -- one token, in a
    // file that changes constantly for unrelated reasons.
    //
    // Reverting to `python -m unittest <module>` is the other reversion this
    // pins: that exits 0 on zero collected, on all-skipped, and on
    // @unittest.expectedFailure, which is the entire reason the runner exists.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test:acceptance-harness"]).toBe(
      "node scripts/spikes/run-acceptance-harness.mjs",
    );
    expect(existsSync(path.join(ROOT, runnerRel))).toBe(true);
    expect(existsSync(path.join(ROOT, launcherRel))).toBe(true);

    // The launcher exists to remove an asymmetry, not to add a layer: the npm
    // script used to hard-code `python`, a name absent from a stock Debian box,
    // while THIS file resolves `python3` or `python` -- so `npm test` passed and
    // `npm run test:acceptance-harness` died on the same machine. Pinning the
    // candidate list keeps the two resolvers from drifting apart again. Source-
    // level, and weaker than the behavioural block below for that reason; what it
    // guards is a list, not a decision.
    const launcher = readFileSync(path.join(ROOT, launcherRel), "utf-8");
    expect(launcher).toContain('["python3", "python"]');
    // A launcher that exits 0 regardless would silently void the gate one level
    // above everything the behavioural block proves about the runner.
    expect(launcher).not.toMatch(/process\.exit\(\s*0\s*\)/);
  });

  it("caps skips rather than flooring executions", () => {
    // A ceiling on skips does not move when tests are legitimately added or
    // removed, so any diff that raises it is unambiguously a weakening. A floor
    // on executed tests would be a second frozen literal, editable in the same
    // diff that breaks it -- and blind to a suite that grew to 120 then lost 40.
    //
    // On its own this assertion is weak: it pins a NUMBER IN THE SOURCE, not a
    // decision. The whole runner body can be gutted -- `wasSuccessful()` check
    // returning 0, the ceiling compared against 10_000 -- with MAX_SKIPS left at
    // 2 and this still green. The behavioural suite below is what actually covers
    // the runner; this one survives because it names the ceiling directly.
    const runner = readFileSync(path.join(ROOT, runnerRel), "utf-8");
    const maxSkips = Number(extract("MAX_SKIPS", runner, /^MAX_SKIPS\s*=\s*(\d+)\s*$/m));
    expect(maxSkips).toBeLessThanOrEqual(2);
  });
});

/**
 * The runner IS the gate -- ci.yml only invokes it -- so it is tested by being
 * RUN, against purpose-built broken suites, not by grepping its source.
 *
 * Each case copies the real `run_acceptance_tests.py` verbatim into a tmpdir and
 * drops a `test_session_monitor_acceptance.py` beside it (the module name the
 * runner hardcodes), so the file under test is never edited. The healthy control
 * is not optional: without it, a runner that unconditionally exited 1 would
 * satisfy every negative case here.
 */
describe("acceptance-harness runner rejects suites that evaluated nothing", () => {
  const workspaces: string[] = [];
  afterAll(() => {
    for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
  });

  // Fail closed, never skip: an absent interpreter must turn this red rather than
  // quietly voiding the only coverage the runner's decisions have. ci.yml runs
  // `actions/setup-python` before the vitest step for exactly this reason.
  function python(): string {
    for (const candidate of ["python3", "python"]) {
      if (spawnSync(candidate, ["--version"], { encoding: "utf-8" }).status === 0) {
        return candidate;
      }
    }
    throw new Error("neither `python3` nor `python` is on PATH; cannot exercise the runner");
  }

  function runAgainst(
    suiteSource: string,
    args: string[] = [],
  ): { status: number | null; output: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "tandem-acceptance-runner-"));
    workspaces.push(dir);
    copyFileSync(
      path.join(ROOT, "scripts/spikes/run_acceptance_tests.py"),
      path.join(dir, "run_acceptance_tests.py"),
    );
    writeFileSync(path.join(dir, "test_session_monitor_acceptance.py"), suiteSource, "utf-8");
    const proc = spawnSync(python(), ["run_acceptance_tests.py", ...args], {
      cwd: dir,
      encoding: "utf-8",
    });
    return { status: proc.status, output: `${proc.stdout ?? ""}${proc.stderr ?? ""}` };
  }

  const HEALTHY = `import unittest


class Healthy(unittest.TestCase):
    def test_one(self):
        self.assertTrue(True)

    def test_two(self):
        self.assertTrue(True)

    def test_three(self):
        self.assertTrue(True)
`;

  it("accepts a healthy suite (the control: without this, always-exit-1 would pass)", () => {
    const { status, output } = runAgainst(HEALTHY);
    expect(output).toContain("collected=3 run=3 skipped=0 expected_failures=0");
    expect(status).toBe(0);
  });

  it("rejects a suite whose test methods were renamed away (collects nothing)", () => {
    // `python -m unittest` reports "Ran 0 tests ... OK" and exits 0 here.
    const { status, output } = runAgainst(HEALTHY.replace(/def test_/g, "def check_"));
    expect(output).toContain("collected no tests");
    expect(status).toBe(1);
  });

  it("rejects a suite where every test is skipped", () => {
    // `python -m unittest` reports "OK (skipped=3)" and exits 0 here.
    const skipped = HEALTHY.replace("class Healthy", '@unittest.skip("disabled")\nclass Healthy');
    const { status, output } = runAgainst(skipped);
    expect(output).toMatch(/tests skipped|no test body ran/);
    expect(status).toBe(1);
  });

  it("rejects a suite at exactly MAX_SKIPS where nothing executed", () => {
    // The ceiling alone cannot see this: 2 collected, 2 skipped satisfies both
    // `collected > 0` and `skipped <= MAX_SKIPS`. Caught by the derived
    // `testsRun - skipped` check, not by lowering the ceiling.
    const twoSkipped = `import unittest


@unittest.skip("disabled")
class Boundary(unittest.TestCase):
    def test_one(self):
        self.assertTrue(True)

    def test_two(self):
        self.assertTrue(True)
`;
    const { status, output } = runAgainst(twoSkipped);
    expect(output).toContain("no test body ran");
    expect(status).toBe(1);
  });

  it("rejects a failing test laundered through @unittest.expectedFailure", () => {
    // The nastiest of the three: unittest scores an expected failure as a PASS,
    // so `wasSuccessful()` stays true, `testsRun` and the skip count are
    // unchanged, and `python -m unittest` prints "OK (expected failures=1)" and
    // exits 0. Reproduced against the real 82-test harness before this guard
    // existed: every count in the summary line was byte-identical to a healthy run.
    const laundered = `${HEALTHY}

class Laundered(unittest.TestCase):
    @unittest.expectedFailure
    def test_broken(self):
        self.fail("this failure is being hidden")
`;
    const { status, output } = runAgainst(laundered);
    expect(output).toContain("expected_failures=1");
    expect(output).toContain("@unittest.expectedFailure");
    expect(status).toBe(1);
  });

  it("refuses unittest flags rather than running everything and reporting success", () => {
    // `loadTestsFromName(MODULE)` hard-codes the target and nothing reads argv, so
    // `-v`, `-k <pattern>`, `-f` and `Class.test_name` -- all of which worked
    // against the `python -m unittest MODULE` this runner replaced -- would run
    // the FULL suite and exit 0. A developer narrowing to one test would read that
    // 0 as "my one test passed" while having run a superset. The control above
    // proves this same suite exits 0 with no arguments, so the non-zero here is
    // attributable to the argument and nothing else.
    const { status, output } = runAgainst(HEALTHY, ["-v"]);
    expect(output).toContain("takes no arguments");
    expect(status).not.toBe(0);
  });

  it("rejects a suite with a genuinely failing test", () => {
    // Isolates `wasSuccessful()`. Every other case in this block is a SUCCESSFUL
    // unittest run that evaluated nothing, so without this one the whole
    // `if not result.wasSuccessful(): return 1` line can be changed to `return 0`
    // with this suite still green -- measured, that is exactly what happened to
    // the first version of this block.
    const failing = `${HEALTHY}

class Broken(unittest.TestCase):
    def test_fails(self):
        self.fail("a real failure")
`;
    const { status } = runAgainst(failing);
    expect(status).toBe(1);
  });

  it("rejects a suite that skips more than MAX_SKIPS while still executing something", () => {
    // Isolates the ceiling. The all-skipped cases above are caught by the
    // executed-body guard before the ceiling is ever reached, so the ceiling
    // comparison itself is only covered here: 3 skips (> MAX_SKIPS) with one test
    // still running.
    const overCeiling = `import unittest


class Mixed(unittest.TestCase):
    def test_runs(self):
        self.assertTrue(True)

    @unittest.skip("one")
    def test_a(self):
        self.assertTrue(True)

    @unittest.skip("two")
    def test_b(self):
        self.assertTrue(True)

    @unittest.skip("three")
    def test_c(self):
        self.assertTrue(True)
`;
    const { status, output } = runAgainst(overCeiling);
    expect(output).toContain("tests skipped, at most 2 expected");
    expect(status).toBe(1);
  });

  it("rejects a suite that cannot be imported", () => {
    const { status, output } = runAgainst("import nonexistent_module_for_this_test\n");
    expect(output).toContain("could not be collected");
    expect(status).toBe(1);
  });
});

describe("docs match the wiring", () => {
  // #1399 was a doc claiming less coverage than existed. Flipping it to a
  // positive with no pin recreates it in the opposite direction: the first person
  // to delete the CI step leaves CLAUDE.md -- auto-loaded into every session --
  // asserting a gate that is gone. Both directions, same shape as
  // monitor-arming-claims.test.ts's positive-carry half.
  const claudeMd = readFileSync(path.join(ROOT, "CLAUDE.md"), "utf-8");
  const cliDoc = readFileSync(path.join(ROOT, "docs/cli.md"), "utf-8");

  it("CLAUDE.md no longer says the harness is unrun, and names the CI job", () => {
    expect(claudeMd).not.toMatch(/acceptance harness is not run by CI/i);
    expect(claudeMd).toMatch(/acceptance harness[^.]*`check` job/i);
  });

  it("docs/cli.md no longer calls the npm script the only runner, and names the CI job", () => {
    expect(cliDoc).not.toMatch(/this is its only runner/i);
    expect(cliDoc).toMatch(/`check` job/i);
  });
});
