#!/usr/bin/env node
/**
 * Did the `byo-flag-on` E2E run actually run the local-model specs lit?
 * (#1123 PR 8a, ADR-039's amendment on E2E for the Models specs.)
 *
 * The `byo-flag-on` job edits `BYO_MODELS_ENABLED` to `true` in its own
 * checkout and runs the whole Playwright suite. Every flag-gated spec starts
 * with a file-level `test.skip(!BYO_MODELS_ENABLED, ...)`, so a run in which
 * the edit never took (the sed matched nothing, a step was reordered, the
 * backend was not rebuilt) reports those specs as skipped and the run is green
 * anyway: a skip reads exactly like a pass. This reads the run's Playwright
 * JSON report and refuses unless every spec named in
 * `tests/e2e/local-model-gated-specs.json` is in the report with at least one
 * test, and none of its tests was skipped.
 *
 * It judges skips and presence only. Whether a test failed is the E2E step's
 * own exit code, which this step does not replace.
 *
 * Exit 0 = every gated spec ran, none skipped; 1 = a gated spec is missing or
 * skipped something; 3 = cannot evaluate (no report, unparsable, an empty or
 * unreadable list). The convention of `ownership-flag-on-runner.mjs`.
 *
 * Temporary: the flip PR deletes this file with the job (ADR-039).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CANNOT_EVALUATE = 3;

/** The gated-spec list, repo-relative; also read by the skip pin. */
export const GATED_SPECS_FILE = "tests/e2e/local-model-gated-specs.json";

/**
 * Every test in a Playwright JSON report, with the file it belongs to. Specs
 * sit in nested suites (one per `describe`), so the walk recurses.
 *
 * @param {unknown[]} suites
 * @returns {Array<{ file: string, title: string, status: string, expectedStatus: string }>}
 */
function collectTests(suites, out = []) {
  for (const suite of suites) {
    if (!suite || typeof suite !== "object") continue;
    const s = /** @type {any} */ (suite);
    for (const spec of Array.isArray(s.specs) ? s.specs : []) {
      for (const test of Array.isArray(spec?.tests) ? spec.tests : []) {
        out.push({
          file: String(spec.file ?? s.file ?? ""),
          title: String(spec.title ?? ""),
          status: String(test?.status),
          expectedStatus: String(test?.expectedStatus),
        });
      }
    }
    if (Array.isArray(s.suites)) collectTests(s.suites, out);
  }
  return out;
}

/** Report paths are relative to the config's `testDir` (`tests/e2e`), as the list is. */
function normalize(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Judge a Playwright JSON report against the gated list. Pure.
 *
 * @param {unknown} report
 * @param {unknown} gated
 * @returns {{ code: 0 | 1 | 3, reason: string }}
 */
export function evaluateGatedSpecs(report, gated) {
  if (!Array.isArray(gated) || gated.length === 0 || !gated.every((g) => typeof g === "string")) {
    return {
      code: EXIT_CANNOT_EVALUATE,
      reason: `${GATED_SPECS_FILE} is not a non-empty list of spec file names`,
    };
  }
  if (report === null || typeof report !== "object" || !Array.isArray(report.suites)) {
    return { code: EXIT_CANNOT_EVALUATE, reason: "the report has no suites array" };
  }
  const tests = collectTests(report.suites);
  const problems = [];
  for (const spec of gated) {
    const want = normalize(spec);
    const mine = tests.filter((t) => normalize(t.file) === want);
    if (mine.length === 0) {
      problems.push(`${spec} is not in the report (not collected, or never ran)`);
      continue;
    }
    const skipped = mine.filter((t) => t.status === "skipped" || t.expectedStatus === "skipped");
    if (skipped.length > 0) {
      problems.push(
        `${spec}: ${skipped.length} of ${mine.length} test(s) skipped (first: "${skipped[0].title}")`,
      );
    }
  }
  if (problems.length > 0) {
    return {
      code: EXIT_FAILED,
      reason:
        `${problems.join("; ")}. A skipped gated spec means this run had local models OFF ` +
        "(the literal edit did not take, or the backend was not rebuilt after it).",
    };
  }
  return {
    code: EXIT_OK,
    reason: `${gated.length} gated spec(s) ran lit with nothing skipped`,
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function main(argv = process.argv.slice(2), repoRoot = process.cwd()) {
  const [reportFile, listFile = path.join(repoRoot, GATED_SPECS_FILE)] = argv;
  let verdict;
  if (!reportFile) {
    verdict = {
      code: EXIT_CANNOT_EVALUATE,
      reason: "usage: byo-flag-on-anchor.mjs <playwright-report.json> [gated-list.json]",
    };
  } else {
    let gated;
    let report;
    try {
      gated = readJson(listFile);
    } catch (err) {
      verdict = {
        code: EXIT_CANNOT_EVALUATE,
        reason: `cannot read ${listFile}: ${err?.message ?? err}`,
      };
    }
    if (!verdict) {
      try {
        report = readJson(reportFile);
      } catch (err) {
        verdict = {
          code: EXIT_CANNOT_EVALUATE,
          reason: `cannot read ${reportFile}: ${err?.message ?? err}`,
        };
      }
    }
    verdict ??= evaluateGatedSpecs(report, gated);
  }
  const tag =
    verdict.code === EXIT_OK ? "OK" : verdict.code === EXIT_FAILED ? "FAIL" : "CANNOT EVALUATE";
  const out = verdict.code === EXIT_OK ? console.log : console.error;
  out(`[byo-flag-on-anchor] ${tag}: ${verdict.reason}`);
  if (verdict.code === EXIT_CANNOT_EVALUATE) {
    console.error("[byo-flag-on-anchor] The anchor could not evaluate. This is not a pass.");
  }
  return verdict.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
