import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
    expect(new Set(GATED).size).toBe(GATED.length);
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
 * The `coverage:` job's YAML body, sliced out by indentation.
 *
 * Both CI checks below read it, and they must read the SAME text: an earlier
 * draft sliced the job two different ways and one of them silently covered the
 * whole rest of the file, which would have passed on any `if:` anywhere below.
 */
function coverageJobBody(): string {
  const ci = read(".github/workflows/ci.yml");
  const start = ci.indexOf("\n  coverage:");
  expect(start, "ci.yml has no coverage job").toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const nextJob = rest.search(/\n {2}\w[\w-]*:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob);
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

  it("keeps the coverage job running that script with nothing that can mask a failure", () => {
    const job = coverageJobBody();
    expect(job).toContain("npm run test:coverage");
    expect(job).not.toContain("|| true");
  });

  it("does not let the coverage job be skipped or made non-fatal", () => {
    // `continue-on-error` on the step or the job, and an `if:` that can evaluate
    // false, both turn a red gate into a green run. `if: always()` on the
    // artifact upload is the one sanctioned use, so it is admitted by name
    // rather than by a loose match.
    const job = coverageJobBody();
    expect(job).not.toContain("continue-on-error");
    const ifs = [...job.matchAll(/^\s*if:\s*(.+)$/gm)].map((m) => m[1].trim());
    expect(ifs).toEqual(["always()"]);
  });

  it("keeps the comparator on disk where the script points", () => {
    expect(existsSync(path.join(ROOT, "scripts/ci/coverage-gate.mjs"))).toBe(true);
    expect(existsSync(path.join(ROOT, "scripts/ci/coverage-policy.json"))).toBe(true);
  });
});
