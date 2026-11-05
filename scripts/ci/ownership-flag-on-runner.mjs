#!/usr/bin/env node
/**
 * Did the flag-on test run actually run ownership flag-on? (#2358, ADR-054)
 *
 * The `ownership-flag-on` job runs the whole vitest suite with
 * `TANDEM_OWNERSHIP=1`. Everything in that suite also passes flag-off, so a
 * run where the variable never reached the workers would read exactly as green
 * as a real one. One test file, `tests/server/ownership-anchor.test.ts`, runs
 * only when `ownershipEnabled()` is true (`it.runIf`) and asserts something only
 * a flag-on process can make true. This reads the run's JSON report and refuses
 * unless that file ran and every assertion in it PASSED.
 *
 * It reads assertion statuses, never the file's status: vitest reports a file
 * whose every test was skipped as `passed`. It also refuses a report whose own
 * verdict is not success, so the run's result does not rest on the `Test`
 * step's exit code alone.
 *
 * Exit 0 = the anchor ran and passed; 1 = it was skipped, failed or the run
 * failed; 3 = the anchor could not evaluate (no report, unparsable, the anchor
 * file absent from it). The same convention as `vitest-file-anchor.mjs`, whose
 * path normalisation this shares.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "./vitest-file-anchor.mjs";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CANNOT_EVALUATE = 3;

/** The anchor file, repo-relative. */
export const ANCHOR_FILE = "tests/server/ownership-anchor.test.ts";

/**
 * Judge a vitest JSON report. Pure.
 *
 * @param {unknown} report
 * @param {string} repoRoot
 * @returns {{ code: 0 | 1 | 3, reason: string }}
 */
export function evaluateAnchors(report, repoRoot) {
  if (report === null || typeof report !== "object") {
    return { code: EXIT_CANNOT_EVALUATE, reason: "the report is not a JSON object" };
  }
  const r = /** @type {Record<string, unknown>} */ (report);
  if (!Array.isArray(r.testResults)) {
    return { code: EXIT_CANNOT_EVALUATE, reason: "the report has no testResults array" };
  }
  const want = normalize(repoRoot, ANCHOR_FILE);
  const file = r.testResults.find(
    (f) => f && typeof f === "object" && normalize(repoRoot, /** @type {any} */ (f).name) === want,
  );
  if (!file) {
    return {
      code: EXIT_CANNOT_EVALUATE,
      reason: `${ANCHOR_FILE} is not in the report: it was not collected or never ran`,
    };
  }
  if (r.success !== true || r.numFailedTests !== 0) {
    return {
      code: EXIT_FAILED,
      reason: `the run did not succeed (success=${String(r.success)}, numFailedTests=${String(r.numFailedTests)})`,
    };
  }
  const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
  if (assertions.length === 0) {
    return { code: EXIT_FAILED, reason: `${ANCHOR_FILE} reported no assertions` };
  }
  const notPassed = assertions.filter((a) => !a || a.status !== "passed");
  if (notPassed.length > 0) {
    const statuses = [...new Set(notPassed.map((a) => String(a?.status)))].join(", ");
    return {
      code: EXIT_FAILED,
      reason:
        `${notPassed.length} of ${assertions.length} anchor assertion(s) did not pass (${statuses}). ` +
        "A skipped anchor means TANDEM_OWNERSHIP never reached the test workers: this run was flag-off.",
    };
  }
  return { code: EXIT_OK, reason: `${assertions.length} anchor assertion(s) passed flag-on` };
}

/** Read and judge one report file; an unreadable one cannot be evaluated. */
function judgeFile(file, repoRoot) {
  if (!file) {
    return {
      code: EXIT_CANNOT_EVALUATE,
      reason: "usage: ownership-flag-on-runner.mjs <report.json>",
    };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { code: EXIT_CANNOT_EVALUATE, reason: `cannot read ${file}: ${err?.message ?? err}` };
  }
  return evaluateAnchors(report, repoRoot);
}

export function main(argv = process.argv.slice(2), repoRoot = process.cwd()) {
  const verdict = judgeFile(argv[0], repoRoot);
  const tag =
    verdict.code === EXIT_OK ? "OK" : verdict.code === EXIT_FAILED ? "FAIL" : "CANNOT EVALUATE";
  const out = verdict.code === EXIT_OK ? console.log : console.error;
  out(`[ownership-anchor] ${tag}: ${verdict.reason}`);
  if (verdict.code === EXIT_CANNOT_EVALUATE) {
    console.error("[ownership-anchor] The anchor could not evaluate. This is not a pass.");
  }
  return verdict.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
