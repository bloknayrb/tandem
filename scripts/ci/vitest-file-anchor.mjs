/**
 * Every collected test file actually ran (#1673).
 *
 * Vitest's summary counts what it **ran**. Nothing in this tree asserted that
 * what it ran equals what it **collected**. A run that loses seven files to
 * `[vitest-pool]: Failed to start forks worker` prints `580 passed (580)` where
 * the healthy tree reports 587 — indistinguishable from a pass unless the reader
 * knows the number by heart, and whether such a run exits 0 or 1 is a property
 * of which files happened to be lost. This is the #1229 / #1399 / #1529
 * zero-of-zero shape: a gate that reports success when it could not evaluate.
 *
 * Two inputs, compared as sets of resolved absolute posix paths:
 *
 *  - `expected` — `vitest list --filesOnly --json`'s array of
 *    `{file, projectName}`. It emits one entry per (file, project) PAIR while
 *    the run report carries no project at all, so `expected` is reduced to a
 *    `Set` first: a file collected under two projects would otherwise become a
 *    permanent false DID-NOT-RUN. Measured on this tree (Node v24.2.0, vitest
 *    4.1.11): 655 entries / 655 unique files, projects `client` and `node`,
 *    disjoint only because `vitest.config.ts` excludes `tests/client/**` from
 *    `node`.
 *  - `reported` — the run report's `testResults` array of `{name, status}`.
 *
 * **The comparator never reads `status`.** A file that is reported at all RAN;
 * a file that never started is not a skip. Vitest's file-level enum is
 * `passed | failed` only (a fully skipped file reports `passed`), so a status
 * filter could only subtract from a presence test.
 *
 * Pure by construction: {@link compareFileSets} touches no filesystem and exits
 * no process, so `tests/scripts/vitest-file-anchor.test.ts` drives every verdict
 * with synthetic input. Modelled on `scripts/ci/coverage-gate.mjs`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * "The anchor could not evaluate" — deliberately distinct from 1, "collected
 * files did not run". Same convention and same value as
 * `coverage-gate.mjs#EXIT_CANNOT_EVALUATE`, because the whole point of this
 * script is that a red says something specific about the diff under test.
 */
export const EXIT_CANNOT_EVALUATE = 3;

/** Resolved absolute, forward-slashed. Guards a future disagreement on either axis. */
const normalize = (repoRoot, p) => path.resolve(repoRoot, String(p)).replace(/\\/g, "/");

const cannot = (message) => ({
  ok: false,
  cannotEvaluate: true,
  checked: 0,
  failures: [{ file: "-", kind: "CANNOT-EVALUATE", detail: message }],
});

/**
 * Compare what vitest collected against what it reported running.
 *
 * Returns the same four keys on every path, with `failures` present and empty
 * on success rather than optional — the `coverage-gate.mjs` reason: an optional
 * array reads as `T[] | undefined` at every call site and `expect(v.ok).toBe(false)`
 * does not narrow it.
 *
 * @param {{expected: unknown, reported: unknown, repoRoot?: string}} input
 */
export function compareFileSets({ expected, reported, repoRoot }) {
  const root = repoRoot ?? process.cwd();

  // "Zero collected" is the failure this exists to catch, never "nothing to
  // check, therefore fine".
  if (!Array.isArray(expected) || expected.length === 0) {
    return cannot("the collected-file list is empty or not an array");
  }
  if (!Array.isArray(reported)) {
    return cannot("the run report has no testResults array");
  }

  const collected = new Set(
    expected.map((e) => normalize(root, typeof e === "string" ? e : (e?.file ?? ""))),
  );
  const ran = new Set(reported.map((r) => normalize(root, r?.name ?? "")));

  const failures = [];
  for (const file of collected) {
    if (!ran.has(file)) failures.push({ file, kind: "DID-NOT-RUN" });
  }

  return { ok: failures.length === 0, cannotEvaluate: false, checked: collected.size, failures };
}

/**
 * Read and parse a JSON file, or exit 3 with a NAMED reason.
 *
 * Every acquisition fails closed to EXIT_CANNOT_EVALUATE, never to 1. An
 * uncaught throw would exit 1 — the same code as "collected files did not run" —
 * destroying the distinction this whole script exists to create. Precedent:
 * `coverage-gate.mjs` wraps both its reads the same way.
 */
function readJsonOrDie(file, label) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    console.error(`[vitest-file-anchor] cannot read ${label} ${file}: ${error.message}`);
    process.exit(EXIT_CANNOT_EVALUATE);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(`[vitest-file-anchor] cannot parse ${label} ${file}: ${error.message}`);
    process.exit(EXIT_CANNOT_EVALUATE);
  }
}

/**
 * Collect the file list by spawning vitest — `node node_modules/vitest/vitest.mjs`,
 * deliberately not `npx`, so a step in the required `check` job never depends on
 * npx resolution. Measured: 2.46 s, 655 files.
 */
function collectExpected(repoRoot) {
  const dir = mkdtempSync(path.join(tmpdir(), "vitest-file-anchor-"));
  const out = path.join(dir, "collected.json");
  try {
    const r = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
        "list",
        "--filesOnly",
        `--json=${out}`,
      ],
      // stdout is never read — the file list lands in `out`; stderr stays visible.
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] },
    );
    if (r.status !== 0) {
      console.error(`[vitest-file-anchor] cannot collect: vitest list exited ${r.status}`);
      process.exit(EXIT_CANNOT_EVALUATE);
    }
    return readJsonOrDie(out, "the collected-file list at");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Escape hatch for the specs: feed a synthetic collected-file list instead of spawning vitest. */
const EXPECTED_FLAG = "--expected=";

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");

  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error("[vitest-file-anchor] cannot read the run report: no path given");
    console.error(
      `[vitest-file-anchor] usage: vitest-file-anchor.mjs <report.json> [${EXPECTED_FLAG}<list.json>]`,
    );
    process.exit(EXIT_CANNOT_EVALUATE);
  }

  const report = readJsonOrDie(path.resolve(repoRoot, reportPath), "the run report at");

  const flag = process.argv.slice(3).find((a) => a.startsWith(EXPECTED_FLAG));
  const expected = flag
    ? readJsonOrDie(path.resolve(repoRoot, flag.slice(EXPECTED_FLAG.length)), "--expected at")
    : collectExpected(repoRoot);

  const verdict = compareFileSets({ expected, reported: report?.testResults, repoRoot });

  if (verdict.cannotEvaluate) {
    for (const f of verdict.failures) {
      console.error(`[vitest-file-anchor] ${f.detail}`);
    }
    console.error("[vitest-file-anchor] The anchor could not evaluate. This is not a pass.");
    process.exit(EXIT_CANNOT_EVALUATE);
  }

  if (verdict.ok) {
    console.log(`[vitest-file-anchor] ${verdict.checked} collected test files all ran.`);
    return;
  }

  // Names, not a count: a count tells the reader a number they do not know by
  // heart is wrong, which is the condition this script exists to remove.
  for (const f of verdict.failures) {
    console.error(`[vitest-file-anchor] ${f.kind}  ${f.file}`);
  }
  console.error(
    `[vitest-file-anchor] ${verdict.failures.length} collected file(s) never ran. ` +
      "This is worker starvation or a lost pool child, not a verdict about the diff.",
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
