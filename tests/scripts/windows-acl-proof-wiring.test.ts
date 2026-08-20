import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
// @ts-expect-error -- plain .mjs CI script, no type declarations. `tests/` is not
// covered by any tsconfig `include`, so this affects nothing but this comment.
import { evaluateReport, WINDOWS_ACL_PROOF_SPECS } from "../../scripts/ci/windows-acl-proof.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * #1529 — the #1299 real-`icacls` proof had never run in CI and could not: the
 * only vitest job (`check`) is ubuntu-latest, so the Windows-gated specs loaded,
 * skipped, and reported green on every push. Measured before this file existed:
 *
 *   $ npx vitest run tests/server/file-io/doc-backup-acl-repair.test.ts
 *    Test Files  1 skipped (1) ; Tests  1 skipped (1) ; exit 0
 *
 * and under `--reporter=json` that file's own status is `passed`.
 *
 * This is the guard on the wiring that fixed it. Like
 * `acceptance-harness-wiring.test.ts` it PARSES `ci.yml` rather than
 * substring-matching it, locates steps by their `run:` value rather than their
 * prose `name:`, and THROWS instead of returning a sentinel when a step is
 * missing — an assertion built on `indexOf` returning -1 passes vacuously the
 * moment the thing it orders is deleted, which is the likeliest reversion.
 *
 * The property that matters most: this file runs on the UBUNTU leg, so
 * **deleting the Windows job turns `check` red.** A gate whose removal is
 * invisible is the failure mode #1529 describes.
 */

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: unknown;
  "continue-on-error"?: unknown;
  shell?: unknown;
};

type Defaults = { run?: { shell?: unknown } };

type Job = {
  "runs-on"?: unknown;
  if?: unknown;
  needs?: unknown;
  strategy?: unknown;
  "continue-on-error"?: unknown;
  defaults?: Defaults;
  steps: Step[];
};

const workflow = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8")) as {
  on: Record<string, unknown>;
  defaults?: Defaults;
  jobs: Record<string, Job>;
};

const RUNNER_REL = "scripts/ci/windows-acl-proof.mjs";
const PROOF_COMMAND = `node ${RUNNER_REL}`;

type SpecEntry = { spec: string; suite: string };
const SPECS = WINDOWS_ACL_PROOF_SPECS as SpecEntry[];

/**
 * Locates the job by the COMMAND it runs, never by its id or its prose name. A
 * rename must not be able to blind the guard, and a commented-out job simply does
 * not exist in the parsed document. Throws rather than returning undefined so a
 * deleted job fails here, loudly, instead of turning every assertion below into a
 * vacuous pass.
 */
function proofJob(): Job {
  const match = Object.entries(workflow.jobs).find(([, job]) =>
    (job.steps ?? []).some((s) => typeof s.run === "string" && s.run.includes(RUNNER_REL)),
  );
  if (!match) {
    throw new Error(
      `.github/workflows/ci.yml: no job runs ${RUNNER_REL}. The #1529 real-icacls proof has ` +
        `no runner again — see tests/scripts/windows-acl-proof-wiring.test.ts.`,
    );
  }
  return match[1];
}

function stepIndex(job: Job, label: string, predicate: (step: Step) => boolean): number {
  const index = (job.steps ?? []).findIndex(predicate);
  if (index < 0) {
    throw new Error(`.github/workflows/ci.yml: the windows-acl-proof job has no step ${label}`);
  }
  return index;
}

function proofStepIndex(job: Job): number {
  return stepIndex(job, `running ${RUNNER_REL}`, (s) =>
    typeof s.run === "string" ? s.run.includes(RUNNER_REL) : false,
  );
}

describe("windows-acl-proof CI wiring", () => {
  it("runs the proof from a job, as a bare command", () => {
    const job = proofJob();
    // Exact equality, not `toContain`. It subsumes the whole exit-code-masking
    // family in one assertion -- `|| true`, `; true`, `|| echo ...`, `set +e &&`,
    // a trailing pipe -- which a denylist only ever covers partly.
    expect(job.steps[proofStepIndex(job)].run?.trim()).toBe(PROOF_COMMAND);
  });

  it("pins the runner to a literal windows-latest host", () => {
    // The whole point. `${{ matrix.os }}` or `ubuntu-latest` here would make every
    // spec skip; the runner script refuses on a non-Windows platform, so that
    // reversion is caught twice -- but it should be caught BEFORE burning a
    // runner, and a string comparison says exactly what went wrong.
    expect(proofJob()["runs-on"]).toBe("windows-latest");
    // A matrix would let a later edit widen the host set back to ubuntu while
    // leaving `runs-on` looking untouched.
    expect(proofJob().strategy, "a matrix can widen the host set silently").toBeUndefined();
  });

  it("keeps the proof step unconditional and blocking", () => {
    const step = proofJob().steps[proofStepIndex(proofJob())];
    // The only mechanism by which a step in a running job is skipped is `if:`.
    // This also catches `if:` written ABOVE `name:`, which a line-slicing text
    // guard misses by accident.
    expect(step.if, "an `if:` on the proof step lets it skip, which reads as pass").toBeUndefined();
    expect(step["continue-on-error"] ?? false).toBeFalsy();
    // `shell:` is the third way to turn a failing `run` into a passing step, and
    // it does it without touching the `run` value pinned above.
    // `shell: bash -c "bash {0}; exit 0"` forces the exit status to 0. Absent
    // means the runner's default pwsh template, which ends `exit $LASTEXITCODE`.
    expect(step.shell ?? "default", "a custom `shell:` can swallow the exit status").toBe(
      "default",
    );
  });

  it("keeps the whole job unconditional, blocking and independent", () => {
    const job = proofJob();
    // A skipped job's check-run conclusion is `skipped`, which required-status
    // checks treat as passing -- the #1229 failure mode.
    expect(job.if, "an `if:` on the job skips it, which reads as pass").toBeUndefined();
    expect(job["continue-on-error"] ?? false).toBeFalsy();
    // `needs: check` would make this job skip whenever `check` fails or is
    // cancelled -- turning a red build into a build where the proof silently did
    // not run. It has no build dependency on any other job.
    expect(job.needs, "`needs:` makes this job skip when its dependency fails").toBeUndefined();
    // The job/workflow twins of the step-level `shell:` guard: `defaults.run.shell`
    // rewrites every `run:` step at once without touching a single step.
    expect(job.defaults?.run?.shell).toBeUndefined();
    expect(workflow.defaults?.run?.shell).toBeUndefined();
  });

  it("installs node and dependencies before the proof", () => {
    const job = proofJob();
    const nodeIndex = stepIndex(job, "actions/setup-node", (s) =>
      typeof s.uses === "string" ? s.uses.startsWith("actions/setup-node@") : false,
    );
    const installIndex = stepIndex(job, "npm ci", (s) =>
      typeof s.run === "string" ? /^npm ci\b/.test(s.run.trim()) : false,
    );
    // Without `npm ci` the runner dies on a missing node_modules/vitest entry --
    // which it reports by name, but at the cost of a whole Windows runner.
    expect(nodeIndex).toBeLessThan(installIndex);
    expect(installIndex).toBeLessThan(proofStepIndex(job));
  });

  it("still triggers on every pull request, unfiltered", () => {
    // A perfectly-written gate that never runs is the cheapest way to disable
    // this without touching the job at all -- and the key merely EXISTING is not
    // enough. `pull_request: {branches: [release/**]}` and
    // `pull_request: {paths-ignore: ['**']}` both keep the key while never firing
    // on a PR to master. A bare `pull_request:` with no body parses to null.
    expect(Object.keys(workflow.on)).toContain("pull_request");
    expect(
      workflow.on.pull_request,
      "`on.pull_request` has filters: a branch/path filter can exclude PRs to master while leaving this key in place",
    ).toBeNull();
  });
});

describe("windows-acl-proof spec list", () => {
  it("names specs that exist, with a suite title each", () => {
    expect(SPECS.length).toBeGreaterThan(0);
    for (const { spec, suite } of SPECS) {
      expect(existsSync(path.join(ROOT, spec)), `${spec} does not exist`).toBe(true);
      expect(typeof suite).toBe("string");
      expect(suite.length).toBeGreaterThan(0);
    }
  });

  it("names a suite title that actually appears in each spec", () => {
    // The suite title is the load-bearing half of the gate: it is what
    // distinguishes "the Windows describe ran" from "the file had some passing
    // test". A typo or a rename would make the runner fail on Windows only --
    // i.e. on the one host nobody can reproduce from a Linux box.
    for (const { spec, suite } of SPECS) {
      const source = readFileSync(path.join(ROOT, spec), "utf-8");
      expect(source, `${spec} contains no describe titled ${JSON.stringify(suite)}`).toContain(
        suite,
      );
    }
  });

  it("still proves the thing with REAL icacls, not a mock", () => {
    // The docblocks of both specs claim real `icacls`. Swapping in a mock while
    // keeping a green `it` would satisfy every count-based check in the runner
    // while proving nothing -- and is the plausible "make CI green" edit.
    for (const { spec } of SPECS) {
      const source = readFileSync(path.join(ROOT, spec), "utf-8");
      expect(source, `${spec} no longer mentions icacls`).toContain("icacls");
      expect(
        source,
        `${spec} now mocks acl-win, so it no longer exercises real icacls`,
      ).not.toMatch(/vi\.mock\([^)]*acl-win/);
    }
  });

  it("covers every test file in the repo that spawns real icacls", () => {
    // The drift guard. #1529 records the cost of the alternative: a sweep-path
    // case was added to the doc-backup spec for #1433 and contributed zero
    // enforced coverage, because the file it joined never ran. A new
    // real-`icacls` spec must join the list or turn this red.
    //
    // Built from non-literal fragments so this file cannot match its own pattern.
    const spawnCall = new RegExp(String.raw`(?:execFile|spawn)\w*\(\s*[^)]*` + "icacls");
    // A spec can also reach icacls INDIRECTLY, via the shared fixture helper.
    // Matching only the direct spawn would let a new spec built on the helper
    // slip past this guard entirely -- the same blind spot in a new shape.
    const viaFixture = /from\s+["'][^"']*helpers\/win-acl-fixture(?:\.js)?["']/;
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".test.ts")) {
          const source = readFileSync(full, "utf-8");
          if (spawnCall.test(source) || viaFixture.test(source)) {
            found.push(path.relative(ROOT, full).replace(/\\/g, "/"));
          }
        }
      }
    };
    walk(path.join(ROOT, "tests"));

    const declared = SPECS.map(({ spec }) => spec).sort();
    expect(found.sort()).toEqual(declared);
  });
});

/**
 * The runner IS the gate, so its decision logic is tested by being RUN against
 * reports built to be exactly the shapes that must be rejected -- not by grepping
 * its source. The healthy control is not optional: without it, an
 * always-reject evaluator would satisfy every negative case here.
 */
describe("windows-acl-proof runner rejects reports that proved nothing", () => {
  const SPEC = "tests/server/file-io/doc-backup-acl-repair.test.ts";
  const SUITE = "doc-backup — recovery from a pre-#1299 poisoned install";
  const specs: SpecEntry[] = [{ spec: SPEC, suite: SUITE }];

  const report = (assertions: Array<{ status: string; ancestorTitles?: string[] }>, over = {}) => ({
    success: true,
    testResults: [
      {
        name: `C:\\a\\b\\${SPEC.replace(/\//g, "\\")}`,
        assertionResults: assertions.map((a) => ({ ancestorTitles: [SUITE], ...a })),
      },
    ],
    ...over,
  });

  it("accepts a healthy report (the control: without this, always-reject would pass)", () => {
    const { ok, lines } = evaluateReport({ report: report([{ status: "passed" }]), specs });
    expect(ok).toBe(true);
    expect(lines[0]).toContain("passed=1 skipped=0 failed=0");
  });

  it("rejects the all-skipped report this whole gate exists for", () => {
    // Verbatim the Linux shape, measured: file status `passed`, one `skipped`
    // assertion, `success: true`, vitest exit 0.
    const { ok, failures } = evaluateReport({ report: report([{ status: "skipped" }]), specs });
    expect(ok).toBe(false);
    expect(failures.join("\n")).toContain("executed no passing test body");
  });

  it("rejects a partially-skipped suite", () => {
    // A `it.skipIf` sneaked onto one case inside the Windows describe would
    // otherwise ride along on its siblings' passes.
    const { ok, failures } = evaluateReport({
      report: report([{ status: "passed" }, { status: "skipped" }]),
      specs,
    });
    expect(ok).toBe(false);
    expect(failures.join("\n")).toContain("must run in full");
  });

  it("counts jest-style `pending` as a skip", () => {
    const { ok } = evaluateReport({ report: report([{ status: "pending" }]), specs });
    expect(ok).toBe(false);
  });

  it("rejects passes that came from a DIFFERENT describe in the same file", () => {
    // The decisive case. `acl-win.test.ts` yields 3 passes on Linux from its
    // `source contract` and `POSIX no-op` describes while the Windows describe is
    // skipped in full -- so a whole-file "had a passing test" check is green on
    // the exact runs this gate must reject.
    const { ok, failures } = evaluateReport({
      report: report([{ status: "passed", ancestorTitles: ["acl-win — source contract"] }]),
      specs,
    });
    expect(ok).toBe(false);
    expect(failures.join("\n")).toContain("produced no results");
  });

  it("rejects a failing suite", () => {
    const { ok, failures } = evaluateReport({
      report: report([{ status: "passed" }, { status: "failed" }]),
      specs,
    });
    expect(ok).toBe(false);
    expect(failures.join("\n")).toContain("failing test(s)");
  });

  it("rejects a report missing the spec entirely", () => {
    const { ok, failures } = evaluateReport({ report: { success: true, testResults: [] }, specs });
    expect(ok).toBe(false);
    expect(failures.join("\n")).toContain("expected exactly 1 report entry, got 0");
  });

  it("rejects success:false even when every declared suite passed", () => {
    const { ok, failures } = evaluateReport({
      report: report([{ status: "passed" }], { success: false }),
      specs,
    });
    expect(ok).toBe(false);
    expect(failures.join("\n")).toContain("success=false");
  });

  it("rejects an absent or unparseable report rather than treating it as nothing to check", () => {
    expect(evaluateReport({ report: undefined, specs }).ok).toBe(false);
    expect(evaluateReport({ report: {}, specs }).ok).toBe(false);
  });
});

describe("windows-acl-proof runner refuses to pass where it cannot evaluate", () => {
  it("exits non-zero on this (non-Windows) host, naming the platform", () => {
    // End-to-end proof of the plumbing -- spawn, guards, exit code -- executed on
    // the ubuntu `check` leg. Without this the entire script could be reduced to
    // `process.exit(0)` with every assertion above still green, because they only
    // ever call the pure evaluator.
    //
    // Skipped rather than inverted on Windows: there the script would really run
    // vitest, which is the CI job's business, not this test's.
    if (process.platform === "win32") return;
    const proc = spawnSync(process.execPath, [path.join(ROOT, RUNNER_REL)], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(proc.status).not.toBe(0);
    expect(`${proc.stdout ?? ""}${proc.stderr ?? ""}`).toContain(
      `refusing to report success on platform "${process.platform}"`,
    );
  });
});

describe("docs match the wiring", () => {
  // #1399 was a doc claiming less coverage than existed. Flipping a claim to a
  // positive with no pin recreates it in the opposite direction: the first person
  // to delete the CI job leaves CLAUDE.md -- auto-loaded into every session --
  // asserting a gate that is gone.
  const claudeMd = readFileSync(path.join(ROOT, "CLAUDE.md"), "utf-8");

  it("CLAUDE.md names the job that runs the real-icacls proof", () => {
    expect(claudeMd).toMatch(/windows-acl-proof/);
  });
});
