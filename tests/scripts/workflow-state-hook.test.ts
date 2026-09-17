import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `tests/hooks/test_workflow_state.sh` is a real assertion suite for the
 * workflow-state hooks, and until #1783 it was invoked by no npm script, no
 * hook and no workflow — so every assertion in it had been green-by-absence
 * since it was written. This runs it inside `npm test`, which is what CI's
 * `check` job and the pre-push hook both run.
 *
 * What this detects: the script exiting non-zero (its `fail()` calls `exit 1`,
 * so an assertion that FIRES AND FAILS lands here), and the summary line going
 * missing. What it does NOT detect: an assertion block DELETED from the script
 * — the count would simply drop and the line would still print.
 *
 * The count is deliberately not pinned. `test_workflow_state.sh` reads
 * `HAS_JQ` from `command -v jq` and three of its blocks are jq-conditional (one
 * only fires without it), so it prints 24 with jq and 22 without. A literal
 * would red on any jq-less machine — including under the pre-push hook, which
 * runs the whole suite locally — and would conflate "jq is missing" with "an
 * assertion stopped firing".
 */

const ROOT = path.resolve(__dirname, "..", "..");

describe("tests/hooks/test_workflow_state.sh", () => {
  // `check` is ubuntu-only and the script is bash; a Windows dev box runs the
  // rest of the suite without it rather than reporting a false failure.
  it.skipIf(process.platform === "win32")("runs green and reports its assertions", () => {
    const run = spawnSync("bash", ["tests/hooks/test_workflow_state.sh"], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(run.error, `could not spawn bash: ${run.error?.message}`).toBeUndefined();
    expect(run.status, `script failed:\n${run.stdout}\n${run.stderr}`).toBe(0);

    const summary = run.stdout.match(/^OK: (\d+) assertions passed\.$/m);
    expect(summary, `no summary line in:\n${run.stdout}`).not.toBeNull();
    expect(Number(summary?.[1]), "the script ran zero assertions").toBeGreaterThan(0);
  });
});
