import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateGate,
  MAX_FLOOR_ALLOWANCE,
  METRICS,
  MIN_STATEMENT_RATIO,
  relativizeSummaryKey,
} from "../../scripts/ci/coverage-gate.mjs";

/**
 * Behavioural tests for the Unit 13 comparator.
 *
 * `evaluateGate` is pure, so every verdict below is driven by a synthetic
 * summary rather than by a coverage run. **That is also this file's blind
 * spot**: an input I build myself can only confirm my model of what v8 writes,
 * so it cannot catch a key-shape mismatch between the real report and the
 * reader. The control for that is running the script against a real
 * `coverage/coverage-summary.json`, which the unit's PR records; it is not
 * something this file can assert.
 */

const REPO = process.platform === "win32" ? "C:\\repo" : "/repo";
const abs = (rel: string) => path.join(REPO, ...rel.split("/"));

/** A metric block shaped like v8's json-summary output. */
const metric = (pct: number, total = 100) => ({
  total,
  covered: Math.round((pct / 100) * total),
  skipped: 0,
  pct,
});

function summaryFor(rel: string, pcts: Partial<Record<string, number>> = {}, total = 100) {
  const block: Record<string, unknown> = {};
  for (const m of METRICS) block[m] = metric(pcts[m] ?? 100, total);
  return {
    total: {
      statements: metric(70),
      lines: metric(70),
      branches: metric(70),
      functions: metric(70),
    },
    [abs(rel)]: block,
  };
}

function policyFor(rel: string, floors: Partial<Record<string, number>> = {}, minStatements = 100) {
  const f: Record<string, number> = {};
  for (const m of METRICS) f[m] = floors[m] ?? 90;
  return {
    modules: [
      { path: rel, unit: "test", suite: "tests/x.test.ts", minStatements, observed: f, floors: f },
    ],
  };
}

const MOD = "src/server/documents/open.ts";

describe("evaluateGate — the passing case", () => {
  it("passes when every metric is above its floor", () => {
    const v = evaluateGate({
      policy: policyFor(MOD),
      summary: summaryFor(MOD, { statements: 95, lines: 95, branches: 95, functions: 95 }),
      repoRoot: REPO,
    });
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(1);
  });

  it("passes when a metric sits EXACTLY on its floor", () => {
    // The boundary, and the only value at which `>` and `>=` disagree. A suite
    // that only tests a comfortable margin leaves the comparison unpinned --
    // which is exactly the hole review found in the SNAPSHOT_CAP spec on #1726,
    // where the fixture was twice the cap and both operators agreed there.
    const v = evaluateGate({
      policy: policyFor(MOD, { branches: 91.39 }),
      summary: summaryFor(MOD, { branches: 91.39 }),
      repoRoot: REPO,
    });
    expect(v.ok).toBe(true);
  });

  it("fails one hundredth of a point below the floor", () => {
    // The discriminating half of the pair above. Without it, `>=` and `>` and
    // even `>= floor - 1` all pass the boundary spec.
    const v = evaluateGate({
      policy: policyFor(MOD, { branches: 91.39 }),
      summary: summaryFor(MOD, { branches: 91.38 }),
      repoRoot: REPO,
    });
    expect(v.ok).toBe(false);
    expect(v.failures.map((f) => f.kind)).toEqual(["BELOW"]);
  });
});

describe("evaluateGate — BELOW", () => {
  it("names the metric, the observed value and the floor", () => {
    const v = evaluateGate({
      policy: policyFor(MOD, { statements: 97 }),
      summary: summaryFor(MOD, { statements: 80 }),
      repoRoot: REPO,
    });
    expect(v.ok).toBe(false);
    expect(v.failures[0].kind).toBe("BELOW");
    expect(v.failures[0].detail).toContain("statements");
    expect(v.failures[0].detail).toContain("80.00%");
    expect(v.failures[0].detail).toContain("97.00%");
  });

  it("reports every failing metric, not just the first", () => {
    // A gate that stops at the first failure makes a reader fix one number,
    // re-run the 6-minute job, and find the next one.
    const v = evaluateGate({
      policy: policyFor(MOD, { statements: 97, lines: 97, branches: 97, functions: 97 }),
      summary: summaryFor(MOD, { statements: 10, lines: 10, branches: 10, functions: 10 }),
      repoRoot: REPO,
    });
    expect(v.failures).toHaveLength(4);
  });
});

describe("evaluateGate — ABSENT", () => {
  it("fails when a gated module has no entry in the summary", () => {
    // A rename or an extension change drops the file out of the include glob.
    // Its gate would otherwise vanish with it, permanently and silently.
    const v = evaluateGate({
      policy: policyFor(MOD),
      summary: summaryFor("src/server/documents/renamed.ts"),
      repoRoot: REPO,
    });
    expect(v.ok).toBe(false);
    expect(v.failures[0].kind).toBe("ABSENT");
  });

  it("does NOT confuse a module measured at zero with an absent one", () => {
    // v8 reports every file matching the include glob whether or not a test
    // imports it, so an untested module is PRESENT at 0%. That must read as
    // BELOW -- a fixable coverage problem -- not as ABSENT, which says the
    // gate lost track of the file.
    const v = evaluateGate({
      policy: policyFor(MOD),
      summary: summaryFor(MOD, { statements: 0, lines: 0, branches: 0, functions: 0 }),
      repoRoot: REPO,
    });
    expect(v.ok).toBe(false);
    expect(v.failures.every((f) => f.kind === "BELOW")).toBe(true);
  });
});

describe("evaluateGate — UNINSTRUMENTED", () => {
  it("refuses a module whose statements measured 0/0 even though it reports 100%", () => {
    // The zero-of-zero hole. `src/server/yjs/lifecycle.ts` (a pure interface)
    // and `src/server/documents/registry-testing.ts` (a pure re-export) both
    // report exactly this today, which is why neither is in the policy.
    const v = evaluateGate({
      policy: policyFor(MOD),
      summary: summaryFor(MOD, {}, 0),
      repoRoot: REPO,
    });
    expect(v.ok).toBe(false);
    expect(v.failures[0].kind).toBe("UNINSTRUMENTED");
  });

  it("refuses a zero denominator on ANY metric, not only on statements", () => {
    // Flatten every conditional in a module and v8 reports branches 0/0 at
    // 100%, clearing any branch floor, while the statement count stays healthy.
    // Keying the check on `statements.total` alone would be the same hole one
    // metric over.
    const summary = summaryFor(MOD, { statements: 99, lines: 99, functions: 99 });
    (summary[abs(MOD)] as Record<string, unknown>).branches = metric(100, 0);
    const v = evaluateGate({ policy: policyFor(MOD), summary, repoRoot: REPO });
    expect(v.ok).toBe(false);
    expect(v.failures[0].kind).toBe("UNINSTRUMENTED");
    expect(v.failures[0].detail).toContain("branches");
  });

  it("refuses a zero denominator even when the floor for that metric is 0", () => {
    // The denominator is the defect, not the value. A gate that compared only
    // `pct >= floor` would pass this happily, which is the whole reason
    // UNINSTRUMENTED is a class of its own rather than a flavour of BELOW.
    const v = evaluateGate({
      policy: policyFor(MOD, { statements: 0, lines: 0, branches: 0, functions: 0 }),
      summary: summaryFor(MOD, {}, 0),
      repoRoot: REPO,
    });
    expect(v.ok).toBe(false);
    expect(v.failures[0].kind).toBe("UNINSTRUMENTED");
  });
});

describe("evaluateGate — SHRUNK", () => {
  it("refuses a module whose statement count collapsed, even at 100%", () => {
    // The path-keyed policy's blind spot: move the least-covered half of a
    // module into an ungated sibling and the survivors keep the ratio up. A
    // ratio cannot see that; a denominator can.
    const v = evaluateGate({
      policy: policyFor(MOD, {}, 200),
      summary: summaryFor(MOD, {}, 10),
      repoRoot: REPO,
    });
    expect(v.ok).toBe(false);
    expect(v.failures[0].kind).toBe("SHRUNK");
    expect(v.failures[0].detail).toContain("200");
  });

  it("puts the shrink boundary at a FIXED count, not wherever the constant happens to be", () => {
    // The pair below derives its threshold from MIN_STATEMENT_RATIO itself, so
    // it agrees with the constant no matter what the constant is — it pins the
    // arithmetic and not the tolerance. Changing 0.75 to 0.5 or 0.95 survived
    // every other spec in this file, which is a real loosening of how much logic
    // can move to an ungated sibling before SHRUNK fires.
    //
    // Seeded at 200, the floor is Math.floor(200 * 0.75) = 150: 150 passes and
    // 149 fails. Both halves are asserted, because the passing one alone is
    // satisfied by a tolerance of zero.
    const seeded = 200;
    const atFloor = evaluateGate({
      policy: policyFor(MOD, {}, seeded),
      summary: summaryFor(MOD, {}, 150),
      repoRoot: REPO,
    });
    expect(atFloor.ok, "150 of a seeded 200 should pass at a 0.75 ratio").toBe(true);

    const belowFloor = evaluateGate({
      policy: policyFor(MOD, {}, seeded),
      summary: summaryFor(MOD, {}, 149),
      repoRoot: REPO,
    });
    expect(belowFloor.ok, "149 of a seeded 200 should fail at a 0.75 ratio").toBe(false);
    expect(belowFloor.failures[0].kind).toBe("SHRUNK");
  });

  it("tolerates ordinary shrinkage inside the ratio", () => {
    // Deliberately generous: refactoring inside a module moves the count, and a
    // gate that fires on that is a gate people learn to edit rather than read.
    const seeded = 200;
    const stillFine = Math.ceil(seeded * MIN_STATEMENT_RATIO) + 1;
    const v = evaluateGate({
      policy: policyFor(MOD, {}, seeded),
      summary: summaryFor(MOD, {}, stillFine),
      repoRoot: REPO,
    });
    expect(v.ok).toBe(true);
  });
});

describe("evaluateGate — CANNOT-EVALUATE", () => {
  it.each([
    ["a missing summary", undefined],
    ["a non-object summary", "not json" as unknown],
    ["a summary with no total key", { [abs(MOD)]: {} }],
  ])("refuses %s without calling it a pass", (_label, summary) => {
    const v = evaluateGate({ policy: policyFor(MOD), summary, repoRoot: REPO });
    expect(v.ok).toBe(false);
    expect(v.cannotEvaluate).toBe(true);
  });

  it("refuses a policy that gates zero modules", () => {
    // Zero-of-zero, one level up: an empty policy trivially satisfies "every
    // gated module is above its floor". The gate has to say it learned nothing.
    const v = evaluateGate({
      policy: { modules: [] },
      summary: summaryFor(MOD),
      repoRoot: REPO,
    });
    expect(v.ok).toBe(false);
    expect(v.cannotEvaluate).toBe(true);
  });

  it("separates cannot-evaluate from an ordinary failure", () => {
    // The distinction is the point of #1229: a gate with only pass/fail is
    // muted by its first flake, because the flake is indistinguishable from
    // the thing it was watching for.
    const below = evaluateGate({
      policy: policyFor(MOD, { statements: 97 }),
      summary: summaryFor(MOD, { statements: 10 }),
      repoRoot: REPO,
    });
    expect(below.ok).toBe(false);
    expect(below.cannotEvaluate).toBe(false);
  });
});

describe("evaluateGate — MALFORMED", () => {
  it("refuses a policy entry with a missing floor", () => {
    const policy = policyFor(MOD);
    delete (policy.modules[0].floors as Record<string, number>).branches;
    const v = evaluateGate({ policy, summary: summaryFor(MOD), repoRoot: REPO });
    expect(v.ok).toBe(false);
    expect(v.failures[0].kind).toBe("MALFORMED");
  });

  it("refuses a summary entry whose metric block is not a metric", () => {
    const summary = summaryFor(MOD);
    (summary[abs(MOD)] as Record<string, unknown>).lines = { pct: "high" };
    const v = evaluateGate({ policy: policyFor(MOD), summary, repoRoot: REPO });
    expect(v.ok).toBe(false);
    expect(v.failures[0].kind).toBe("MALFORMED");
  });
});

describe("relativizeSummaryKey", () => {
  it("turns an absolute OS-native key into a repo-relative POSIX path", () => {
    expect(relativizeSummaryKey(abs("src/client/layout/model.svelte.ts"), REPO)).toBe(
      "src/client/layout/model.svelte.ts",
    );
  });

  it("relativizes a WINDOWS-shaped key regardless of the platform running this", () => {
    // The seam that mattered and was not observable before: floors are seeded on
    // Windows and the gate runs on ubuntu. The old implementation used the
    // ambient `path.relative`/`path.sep`, which is correct on each platform but
    // means a mutant hardcoding `/` is indistinguishable from the real thing on
    // ubuntu — the suite only ever saw its own platform's separator.
    expect(
      relativizeSummaryKey(
        "C:\\Users\\x\\tandem\\src\\client\\layout\\model.svelte.ts",
        "C:\\Users\\x\\tandem",
      ),
    ).toBe("src/client/layout/model.svelte.ts");
  });

  it("relativizes a POSIX-shaped key regardless of the platform running this", () => {
    // The other direction, which is what CI actually feeds it.
    expect(
      relativizeSummaryKey(
        "/home/runner/work/tandem/tandem/src/server/documents/open.ts",
        "/home/runner/work/tandem/tandem",
      ),
    ).toBe("src/server/documents/open.ts");
  });

  it("does not let a nested src/ directory impersonate the repo's own", () => {
    // The report includes `infra/license-issuance-worker/src/crypto.ts`, so a
    // matcher keyed on a trailing `/src/<path>` would resolve a policy entry of
    // `src/crypto.ts` to a worker file. Anchoring on the repo root is what
    // makes that impossible.
    const nested = abs("infra/license-issuance-worker/src/crypto.ts");
    expect(relativizeSummaryKey(nested, REPO)).toBe("infra/license-issuance-worker/src/crypto.ts");
    expect(relativizeSummaryKey(nested, REPO)).not.toBe("src/crypto.ts");
  });
});

describe("exported constants", () => {
  it("keeps the allowance and the shrink ratio where the wiring test can read them", () => {
    // Both are asserted against the committed policy by
    // coverage-gate-wiring.test.ts. Re-deriving either there would let the two
    // copies drift.
    expect(MAX_FLOOR_ALLOWANCE).toBe(1);
    // By exact value, because the shrink-boundary spec above is written against
    // 0.75. A range assertion let the tolerance move to 0.5 or 0.95 with every
    // spec in this file still green.
    expect(MIN_STATEMENT_RATIO).toBe(0.75);
    expect(METRICS).toEqual(["statements", "lines", "branches", "functions"]);
  });
});
