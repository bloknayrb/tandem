#!/usr/bin/env node
/**
 * Interpreter-resolving launcher for the acceptance-harness runner (#1399).
 *
 * The npm script was `cd scripts/spikes && python run_acceptance_tests.py`, which
 * hard-codes a name that does not exist on a stock Debian/Ubuntu box -- only
 * `python3` is on PATH there. Meanwhile `tests/scripts/acceptance-harness-wiring.test.ts`
 * resolves `python3` OR `python`, so on that box `npm test` went GREEN against the
 * same runner while `npm run test:acceptance-harness` died on `python: not found`.
 * Two resolution rules for one interpreter is what hid that; this file is the
 * single rule, and the wiring test pins the npm script to it.
 *
 * Why a launcher rather than a conditional in the npm script: npm runs scripts
 * through cmd.exe on Windows, where `if command -v ...` is not syntax; and the
 * `python3 ... || python ...` form re-runs the entire suite under a second
 * interpreter whenever the first reports a genuine test failure, which is both
 * slow and a route to a different verdict than the one that failed.
 *
 * This adds no policy of its own: it resolves, forwards argv, and exits with the
 * child's status. It must never turn a non-zero child into a zero exit -- the
 * runner it fronts exists precisely because `unittest` does that.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SPIKES = path.dirname(fileURLToPath(import.meta.url));

function resolveInterpreter() {
  for (const candidate of ["python3", "python"]) {
    if (spawnSync(candidate, ["--version"], { encoding: "utf-8" }).status === 0) {
      return candidate;
    }
  }
  console.error(
    "neither `python3` nor `python` is on PATH; the acceptance harness needs Python 3.10+ " +
      "(see CONTRIBUTING.md -- it is also a prerequisite of `npm test`)",
  );
  process.exit(1);
}

// argv is forwarded rather than dropped so the runner's own refusal of unittest
// flags is reachable from `npm run test:acceptance-harness -- -v`. Swallowing it
// here would reproduce, one level up, exactly the silent-drop this fixes.
const result = spawnSync(
  resolveInterpreter(),
  ["run_acceptance_tests.py", ...process.argv.slice(2)],
  {
    cwd: SPIKES,
    stdio: "inherit",
  },
);

// `status` is null when the child died on a signal, which is not a pass.
process.exit(result.status ?? 1);
