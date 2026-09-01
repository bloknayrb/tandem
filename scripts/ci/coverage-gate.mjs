/**
 * Per-module coverage floors (Unit 13 of the maintainability programme).
 *
 * Reads `coverage/coverage-summary.json` and `scripts/ci/coverage-policy.json`,
 * and fails when a gated module falls below a floor, stops being instrumented,
 * or disappears.
 *
 * **What a percentage floor can and cannot detect, because the unit's own
 * review question is one of the things it CANNOT answer.** That question is
 * "can a critical branch in a newly deepened module be removed without a test
 * or coverage gate failing?", and for these floors the answer is yes:
 *
 *  - Deleting a COVERED branch removes it from the numerator and the
 *    denominator together. `open.ts` sits at 85/93 branches; one deletion is
 *    84/92 = 91.30 %, still over its 91 floor. Fourteen deletions are needed
 *    before the ratio breaches.
 *  - Deleting an UNCOVERED branch RAISES the percentage.
 *  - On a module observed at 100 % the ratio is deletion-proof by construction:
 *    45/45 and 44/44 are both 100 %.
 *
 * So these floors detect **new code arriving untested**, which is a real and
 * distinct regression, and they do not detect behaviour being deleted. The
 * thing that detects deletion is the behavioural suite each policy entry names
 * in `suite` — and `tests/scripts/coverage-gate-wiring.test.ts` checks those
 * paths from inside `check`, the required job, precisely because the floors
 * themselves run in `coverage`, which is advisory today.
 *
 * Saying this here rather than in a commit message is deliberate: the failure
 * mode of a coverage gate is that a reader assumes it proves more than it does.
 *
 * Pure by construction: {@link evaluateGate} touches no filesystem and exits no
 * process, so `tests/scripts/coverage-gate.test.ts` drives every verdict with a
 * synthetic input and asserts it actually refuses.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The four metrics every policy entry must carry. */
export const METRICS = ["statements", "lines", "branches", "functions"];

/**
 * How far below `observed` a floor may sit. The unit instruction allows "at
 * most a one-point rounding allowance"; the seeding rule (round down to the
 * nearest half point) always lands inside it, and
 * `coverage-gate-wiring.test.ts` proves that from the recorded `observed`
 * rather than trusting the seeding script.
 */
export const MAX_FLOOR_ALLOWANCE = 1;

/**
 * How far a module's instrumented statement count may fall below its seeded
 * `minStatements` before the gate refuses.
 *
 * **This exists because a percentage is blind to logic MOVING.** Extract the
 * least-covered half of a gated module into an ungated sibling and the
 * survivors keep the ratio up while the logic that mattered leaves the gated
 * set entirely. A ratio cannot see that; a denominator can. The tolerance is
 * deliberately generous — ordinary refactoring inside a module shifts the count
 * a little — and the check is a floor on SIZE, not an assertion that the module
 * never shrinks.
 */
export const MIN_STATEMENT_RATIO = 0.75;

/** Exit code for "the gate could not evaluate", distinct from a real failure. */
export const EXIT_CANNOT_EVALUATE = 3;

const pct = (n) => `${n.toFixed(2)}%`;

/**
 * Normalize a coverage-summary key to a repo-relative POSIX path.
 *
 * The summary keys are ABSOLUTE and OS-native: backslashes on Windows, forward
 * slashes on the ubuntu runner that actually gates. Matching on a `/src/…`
 * suffix instead would be wrong in both directions — this repo has
 * `infra/license-issuance-worker/src/` inside the same report, so a policy path
 * of `src/crypto.ts` would match a worker file. Resolve against the repo root
 * and compare whole relative paths.
 */
export function relativizeSummaryKey(key, repoRoot) {
  return path.relative(repoRoot, key).split(path.sep).join("/");
}

/**
 * Evaluate the policy against a coverage summary.
 *
 * Returns `{ ok, cannotEvaluate, checked, failures }` — the same four keys on
 * every path — and never throws for a malformed input or exits the process.
 * `cannotEvaluate` separates "the measurement did not
 * happen" from "the measurement happened and was bad" — a gate that cannot say
 * "I learned nothing" is muted by its first flake (#1229, which this repo has
 * now produced three times).
 */
export function evaluateGate({ policy, summary, repoRoot }) {
  if (!summary || typeof summary !== "object") {
    return cannot("coverage summary is missing or not an object");
  }
  if (!summary.total || typeof summary.total !== "object") {
    // The same shape `coverage-manifest.mjs` refuses on. A summary without a
    // `total` is not a low-coverage report, it is a report of nothing.
    return cannot("coverage summary has no `total` key");
  }
  if (!policy || !Array.isArray(policy.modules) || policy.modules.length === 0) {
    return cannot("coverage policy is missing, malformed, or gates zero modules");
  }

  const byRelative = new Map();
  for (const key of Object.keys(summary)) {
    if (key === "total") continue;
    byRelative.set(relativizeSummaryKey(key, repoRoot), summary[key]);
  }

  const failures = [];
  for (const mod of policy.modules) {
    const measured = byRelative.get(mod.path);

    if (!measured) {
      // Not the same thing as zero coverage. v8 reports every file matching
      // `coverage.include` whether or not a test imports it, so a module at 0 %
      // is PRESENT at 0 %. Absent means the file left the include glob — a
      // rename, an extension change, a deletion — and its gate would otherwise
      // vanish with it, silently and permanently.
      failures.push({ path: mod.path, kind: "ABSENT", detail: "no entry in the coverage summary" });
      continue;
    }

    // Zero-denominator, per metric rather than per module. A file can keep its
    // statements while its BRANCHES collapse to 0/0 — flatten every conditional
    // and v8 reports 100 % branch coverage over nothing, clearing any floor.
    // Checking only `statements.total` would be the same zero-of-zero hole one
    // metric over.
    // Every metric is examined before the module is abandoned, and both bad
    // arms accumulate identically. An earlier draft `break`-ed on MALFORMED and
    // fell through on UNINSTRUMENTED, so a module with both reported only the
    // first -- the opposite of the rule the floor loop below is tested against
    // ("report every failing metric, not just the first").
    const unusable = METRICS.filter((metric) => {
      const entry = measured[metric];
      if (!entry || typeof entry.pct !== "number" || typeof entry.total !== "number") {
        failures.push({
          path: mod.path,
          kind: "MALFORMED",
          detail: `summary entry has no usable \`${metric}\``,
        });
        return true;
      }
      if (entry.total === 0) {
        failures.push({
          path: mod.path,
          kind: "UNINSTRUMENTED",
          detail: `\`${metric}\` measured 0/0, which satisfies any floor including 100`,
        });
        return true;
      }
      return false;
    });
    if (unusable.length > 0) continue;

    const floorStatements = Math.floor(mod.minStatements * MIN_STATEMENT_RATIO);
    if (measured.statements.total < floorStatements) {
      failures.push({
        path: mod.path,
        kind: "SHRUNK",
        detail:
          `${measured.statements.total} instrumented statements, seeded at ` +
          `${mod.minStatements} (floor ${floorStatements}) — logic may have moved to an ungated file`,
      });
      continue;
    }

    for (const metric of METRICS) {
      const floor = mod.floors?.[metric];
      if (typeof floor !== "number") {
        failures.push({
          path: mod.path,
          kind: "MALFORMED",
          detail: `policy entry has no \`floors.${metric}\``,
        });
        continue;
      }
      // `>=`, so a run that reproduces the floor exactly passes. The boundary is
      // the only place `>` and `>=` disagree, and it is pinned by name in
      // `coverage-gate.test.ts`.
      if (measured[metric].pct < floor) {
        failures.push({
          path: mod.path,
          kind: "BELOW",
          detail: `${metric} ${pct(measured[metric].pct)} < floor ${pct(floor)}`,
        });
      }
    }
  }

  // `failures` is present on BOTH arms, empty on success, rather than being
  // optional. An optional array reads as `T[] | undefined` at every call site,
  // and `expect(v.ok).toBe(false)` does not narrow it — so every assertion in
  // the suite would need a non-null assertion, which is exactly the operator
  // that hides the case where the array really is missing.
  if (failures.length > 0) {
    return { ok: false, cannotEvaluate: false, checked: 0, failures };
  }
  return { ok: true, cannotEvaluate: false, checked: policy.modules.length, failures: [] };
}

const cannot = (message) => ({
  ok: false,
  cannotEvaluate: true,
  checked: 0,
  failures: [{ path: "-", kind: "CANNOT-EVALUATE", detail: message }],
});

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");

  let policy;
  let summary;
  try {
    policy = JSON.parse(readFileSync(path.join(here, "coverage-policy.json"), "utf8"));
  } catch (error) {
    console.error(`[coverage-gate] cannot read coverage-policy.json: ${error.message}`);
    process.exit(EXIT_CANNOT_EVALUATE);
  }
  try {
    summary = JSON.parse(
      readFileSync(path.join(repoRoot, "coverage", "coverage-summary.json"), "utf8"),
    );
  } catch (error) {
    console.error(`[coverage-gate] cannot read coverage/coverage-summary.json: ${error.message}`);
    process.exit(EXIT_CANNOT_EVALUATE);
  }

  const verdict = evaluateGate({ policy, summary, repoRoot });

  if (verdict.ok) {
    console.log(`[coverage-gate] ${verdict.checked} gated modules at or above their floors.`);
    console.log(
      "[coverage-gate] These floors detect new code arriving untested. They do NOT detect " +
        "deleted behaviour — see the header of scripts/ci/coverage-gate.mjs.",
    );
    return;
  }

  for (const f of verdict.failures) {
    console.error(`[coverage-gate] ${f.kind}  ${f.path}: ${f.detail}`);
  }
  if (verdict.cannotEvaluate) {
    console.error("[coverage-gate] The gate could not evaluate. This is not a pass.");
    process.exit(EXIT_CANNOT_EVALUATE);
  }
  console.error(`[coverage-gate] ${verdict.failures.length} failure(s).`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
