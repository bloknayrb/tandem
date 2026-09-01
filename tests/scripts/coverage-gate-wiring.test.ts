import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MAX_FLOOR_ALLOWANCE, METRICS } from "../../scripts/ci/coverage-gate.mjs";

/**
 * What holds the Unit 13 gate in place — and this file is the load-bearing half
 * of it, because the floors themselves run in `coverage`, which is NOT a
 * required status check. Everything asserted here runs inside `check`, which is.
 *
 * The precedent is `typecheck-tests-wiring.test.ts`, which exists because a
 * `|| true` appended to an npm script leaves `ci.yml` byte-identical while
 * disarming everything the job claims to run. So the package.json script is
 * pinned by EXACT EQUALITY, not by `toContain`.
 *
 * Four of these checks came from an adversarial review of the plan, each one an
 * attack that defeated an earlier draft while leaving every other check green:
 *
 *  1. **The policy's module SET is pinned.** Deleting one entry disarms that
 *     module forever, and a gate that only validates the shape of the entries
 *     it finds reports success truthfully while doing less.
 *  2. **Coverage-ignore hints are forbidden in gated files.** A `v8 ignore`
 *     comment shrinks the denominator, so one line clears a floor with no test
 *     written. Demonstrated against this repo's own vitest install: a module at
 *     2/5 statements reported 2/3 once the untested branch carried a
 *     three-line ignore hint. Nothing in a coverage summary records that a hint
 *     fired, so no comparator reading the summary can see it.
 *  3. **Every floor is proved against its recorded `observed`**, rather than
 *     against the seeding script's promise. The first draft's table spent more
 *     than the permitted one point on six of ten rows.
 *  4. **Every `suite` path must exist.** The floors cannot detect deleted
 *     behaviour (see the comparator's header); a named behavioural suite can,
 *     and this is what makes deleting one red a required job.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const policy = JSON.parse(read("scripts/ci/coverage-policy.json")) as {
  modules: {
    path: string;
    unit: string;
    suite: string;
    minStatements: number;
    observed: Record<string, number>;
    floors: Record<string, number>;
  }[];
};

/**
 * The gated set, spelled out. Removing a module from the policy must fail here
 * rather than quietly shrink what is gated — the reviewer's most severe finding
 * against the plan, and the one no other check in this file catches.
 */
const GATED = [
  "src/server/documents/registry.ts",
  "src/server/documents/dirty.ts",
  "src/server/documents/open.ts",
  "src/server/documents/reload-family.ts",
  "src/server/documents/watcher.ts",
  "src/server/annotations/lifecycle.ts",
  "src/server/annotations/projection.ts",
  "src/server/annotations/sync.ts",
  "src/server/annotations/schema.ts",
  "src/server/events/observers/annotations.ts",
  "src/server/events/observers/replies.ts",
  "src/client/hooks/useDocumentWorkspace.svelte.ts",
  "src/client/layout/model.svelte.ts",
  "src/client/layout/rail-content.svelte.ts",
];

describe("coverage policy — the gated set", () => {
  it("gates exactly the modules Units 5, 7, 8 and 10 produced", () => {
    expect(policy.modules.map((m) => m.path)).toEqual(GATED);
  });

  it("names no module twice", () => {
    // Read from the POLICY, not from `GATED`. This asserted
    // `new Set(GATED).size === GATED.length` — a literal array checked against
    // itself, which cannot fail for any content of the file it claims to be
    // testing. Harmless only because the equality check above would catch a real
    // duplicate first, which is the definition of a spec carrying no weight.
    const paths = policy.modules.map((m) => m.path);
    expect(new Set(paths).size, "the policy names a module twice").toBe(paths.length);
  });

  it("points every gated path at a file that exists", () => {
    // STALE, caught in `check` rather than only in the advisory job. A rename
    // that forgets the policy fails here, at the same time as the rename.
    for (const m of policy.modules) {
      expect(existsSync(path.join(ROOT, m.path)), `${m.path} is missing`).toBe(true);
    }
  });

  it("names an existing behavioural suite for every gated module", () => {
    for (const m of policy.modules) {
      expect(typeof m.suite, `${m.path} has no suite`).toBe("string");
      expect(existsSync(path.join(ROOT, m.suite)), `${m.suite} is missing`).toBe(true);
    }
  });

  it("names a suite that actually references the module it is the suite for", () => {
    // `existsSync` alone is satisfied by any file on disk, so it would accept a
    // suite pointed at something unrelated — and `suite` is the half of this
    // gate that detects DELETED behaviour, so a suite that does not touch the
    // module is the one failure that matters most here.
    //
    // The check is a text reference rather than an import graph: a suite may
    // reach a module through a harness or a helper, and demanding a direct
    // import would push those onto a weaker check instead of a stronger one.
    for (const m of policy.modules) {
      const stem = path.basename(m.path).replace(/\.svelte\.ts$|\.ts$/, "");
      const source = read(m.suite);
      expect(source.includes(stem), `${m.suite} never mentions ${stem}`).toBe(true);
    }
  });
});

describe("coverage policy — the floors", () => {
  it("carries all four metrics, in both floors and observed, for every module", () => {
    for (const m of policy.modules) {
      for (const metric of METRICS) {
        expect(typeof m.floors[metric], `${m.path}.floors.${metric}`).toBe("number");
        expect(typeof m.observed[metric], `${m.path}.observed.${metric}`).toBe("number");
      }
    }
  });

  it("never sets a floor above what was observed", () => {
    // A floor over the observed value is red on the very run that seeded it.
    for (const m of policy.modules) {
      for (const metric of METRICS) {
        expect(m.floors[metric], `${m.path}.${metric}`).toBeLessThanOrEqual(m.observed[metric]);
      }
    }
  });

  it("spends at most the one-point allowance the unit instruction permits", () => {
    // The check the first draft of this policy would have failed on six rows of
    // ten: its prose said `floor(observed)` while its table had quietly gone a
    // second point lower.
    for (const m of policy.modules) {
      for (const metric of METRICS) {
        const gap = m.observed[metric] - m.floors[metric];
        expect(gap, `${m.path}.${metric} spends ${gap} points`).toBeLessThanOrEqual(
          MAX_FLOOR_ALLOWANCE,
        );
      }
    }
  });

  it("sets no floor to zero", () => {
    // A floor of 0 passes at any coverage, forever, while still satisfying
    // "never above observed" and "within the allowance". It is the zero-of-zero
    // hole expressed as a value rather than as a denominator, and nothing else
    // in this file forbids it.
    for (const m of policy.modules) {
      for (const metric of METRICS) {
        expect(m.floors[metric], `${m.path}.${metric} has a floor of 0`).toBeGreaterThan(0);
      }
    }
  });

  it("records a positive seeded statement count for every module", () => {
    // Zero-of-zero at the policy layer: `minStatements: 0` would make the
    // SHRUNK check unfalsifiable, and a module with no statements has no floor
    // worth holding in the first place.
    for (const m of policy.modules) {
      expect(m.minStatements, `${m.path}`).toBeGreaterThan(0);
    }
  });
});

describe("coverage gating — no coverage-ignore hints in gated files", () => {
  it("finds no v8, c8 or istanbul ignore hint in any gated module", () => {
    // A denominator-shrinking comment clears a floor with no test written, and
    // the coverage summary carries no trace that it fired. There are none in
    // `src/` today, so this check starts clean and any future hit is a real
    // signal rather than a backlog.
    //
    // Written as three separate needles rather than one regex alternation so a
    // failure message names which dialect was used.
    const needles = ["v8 ignore", "c8 ignore", "istanbul ignore"];
    for (const m of policy.modules) {
      const source = read(m.path);
      for (const needle of needles) {
        expect(source.includes(needle), `${m.path} contains "${needle}"`).toBe(false);
      }
    }
  });
});

/**
 * The parsed `coverage:` job.
 *
 * **Parsed, not sliced, and that is the finding rather than the style.** The
 * first draft carved the job out of the raw text and asserted
 * `not.toContain("continue-on-error")` over it — which
 * `coverage-manifest-wiring.test.ts` had already found to be close to
 * unconditionally true, because `continue-on-error` is a YAML sibling of `run:`
 * and never appears inside a shell line. That file's comment records the same
 * check being fixed once already; writing a second, weaker copy of it one file
 * over is how the two would have disagreed about the same job.
 */
function coverageJob() {
  const workflow = parse(read(".github/workflows/ci.yml")) as {
    jobs: Record<string, { steps?: { run?: string; if?: string }[]; if?: string }>;
  };
  const job = workflow.jobs.coverage;
  expect(job, "no `coverage` job in ci.yml").toBeDefined();
  return job;
}

describe("coverage gating — CI and npm wiring", () => {
  it("pins the test:coverage script by exact equality", () => {
    // `toContain` is beaten by an appended `|| true`, and by a `--coverage.exclude`
    // that removes a gated file from measurement entirely.
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:coverage"]).toBe(
      "cross-env TANDEM_COVERAGE=1 vitest run --coverage --coverage.reporter=text " +
        "--coverage.reporter=json-summary --coverage.reporter=html --testTimeout=120000 " +
        "--hookTimeout=300000 && node scripts/ci/coverage-manifest.mjs && " +
        "node scripts/ci/coverage-gate.mjs",
    );
  });

  it("does not let the coverage job or its measurement step be skipped", () => {
    // An `if:` that can evaluate false turns a red gate into a green run, and
    // this is the half `coverage-manifest-wiring.test.ts` does NOT cover: it
    // asserts `continue-on-error` is falsy on the job and the step, and that the
    // artifact upload keeps its `if: always()`, but it never asserts the job and
    // the measurement step carry no `if:` of their own. That gap is this test.
    //
    // Deliberately NOT re-asserting `continue-on-error` or `|| true` here. Both
    // are owned by that file, against the same parsed job, and a second copy is
    // a second thing to keep in agreement rather than a second layer.
    const job = coverageJob();
    expect(job.if, "the coverage job is conditional").toBeUndefined();
    const run = (job.steps ?? []).find((s) => s.run?.includes("test:coverage"));
    expect(run, "the coverage job never runs test:coverage").toBeDefined();
    expect(run?.if, "the measurement step is conditional").toBeUndefined();
  });

  it("runs its own main() when invoked as a script, and says so", () => {
    // The CLI entry point is the one piece `coverage-gate.test.ts` cannot reach:
    // it drives the pure `evaluateGate` directly and never spawns the file. So
    // the `import.meta.url === argv[1]` guard, the two try/catch blocks and the
    // exit codes had nothing covering them — and if that guard ever stops
    // matching, `main()` never runs, nothing is printed, and the process exits
    // **0**. That is the #1229 shape in the only uncovered part of this gate.
    //
    // Asserted on OUTPUT rather than on a specific code, because `check` runs
    // with no coverage report on disk (exit 3, cannot-evaluate) while a local
    // run after `test:coverage` has one (exit 0 or 1). What must never happen is
    // the combination this asserts against: exit 0 with the script having said
    // nothing, which is what a dead guard looks like from the outside.
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/ci/coverage-gate.mjs")], {
      encoding: "utf8",
    });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(output, "the gate produced no output at all").toContain("[coverage-gate]");
    expect([0, 1, 3], `unexpected exit ${r.status}`).toContain(r.status);
    if (r.status === 0) {
      // A pass has to look like a pass, not like a script that fell through.
      expect(output).toContain("at or above their floors");
    }
  });

  it("exits 3, not 0, when it cannot find a coverage report to judge", () => {
    // The spec above cannot see this: `coverage/coverage-summary.json` resolves
    // against the SCRIPT's own directory, so a local run that has one always
    // takes the pass/fail path and the cannot-evaluate branch is never entered.
    // Changing its `process.exit(EXIT_CANNOT_EVALUATE)` to `process.exit(0)`
    // survived every other spec in both files — which is #1229 exactly: a gate
    // that reports success when it could not evaluate is worse than no gate.
    //
    // Made reachable by copying the script AND its policy into a temp tree, so
    // `repoRoot` resolves there: the policy read succeeds, and the summary read
    // is the only thing missing. No repo file is touched.
    const tmp = mkdtempSync(path.join(tmpdir(), "coverage-gate-"));
    try {
      const ci = path.join(tmp, "scripts", "ci");
      mkdirSync(ci, { recursive: true });
      for (const f of ["coverage-gate.mjs", "coverage-policy.json"]) {
        copyFileSync(path.join(ROOT, "scripts/ci", f), path.join(ci, f));
      }

      const r = spawnSync(process.execPath, [path.join(ci, "coverage-gate.mjs")], {
        encoding: "utf8",
      });
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(output).toContain("cannot read coverage/coverage-summary.json");
      expect(r.status, `a missing report must not read as a pass (exit ${r.status})`).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the comparator on disk where the script points", () => {
    expect(existsSync(path.join(ROOT, "scripts/ci/coverage-gate.mjs"))).toBe(true);
    expect(existsSync(path.join(ROOT, "scripts/ci/coverage-policy.json"))).toBe(true);
  });
});
