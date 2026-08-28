import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The pre-push hook is the only local runner for biome, `typecheck:tests`, the
 * vitest suite and `cargo test`, and it carries one early exit: a delete-only
 * push skips all four. That skip decides whether the suite runs at all, so it
 * is the one part of the hook worth pinning — and it had a fail-open default,
 * where stdin carrying no refs took the same branch as stdin carrying only
 * deletions and printed "delete-only push" over a silently unverified push.
 *
 * These specs execute the hook's real decision block, sliced out of the real
 * file, rather than reasoning about it. The slice is asserted to still be the
 * decision block, so restructuring the hook fails the test instead of quietly
 * leaving it testing an empty string.
 */

const HOOK_PATH = path.resolve(__dirname, "../../.husky/pre-push");
const RUNNING_MARKER = "pre-push-test: fell through to the checks";
const SKIP_MESSAGE = "pre-push: delete-only push, skipping checks";

/**
 * Everything up to and including the guard's terminating `fi`. Slicing there
 * rather than copying the logic is what keeps this test honest: an edit to the
 * hook is an edit to the code under test.
 */
function decisionBlock(): string {
  const lines = readFileSync(HOOK_PATH, "utf-8").split(/\r?\n/);
  const end = lines.findIndex((line) => line === "fi");
  expect(end, "the hook no longer has a bare `fi` closing its skip guard").toBeGreaterThan(0);
  const block = lines.slice(0, end + 1).join("\n");

  // A slice that no longer contains the decision would make every spec below
  // pass vacuously, so make its absence the failure.
  expect(block, "sliced prefix lost the stdin read loop").toContain("while read -r");
  expect(block, "sliced prefix lost the skip branch").toContain(SKIP_MESSAGE);
  expect(block, "sliced prefix swallowed a check command").not.toContain("npx biome");
  return block;
}

/** Runs the guard with `stdin` and reports what the hook would have done. */
function runGuard(stdin: string): { skipped: boolean; ranChecks: boolean } {
  const script = `${decisionBlock()}\necho "${RUNNING_MARKER}"\n`;
  const out = execFileSync("sh", ["-c", script], { input: stdin, encoding: "utf-8" });
  return { skipped: out.includes(SKIP_MESSAGE), ranChecks: out.includes(RUNNING_MARKER) };
}

const ZERO_OID = "0".repeat(40);
const REAL_OID = "9f1c0e7b2a4d6f8091a3b5c7d9e1f3a5b7c9d1e3";
const deleteLine = (ref: string) => `(delete) ${ZERO_OID} refs/heads/${ref} ${REAL_OID}`;
const updateLine = (ref: string) => `refs/heads/${ref} ${REAL_OID} refs/heads/${ref} ${ZERO_OID}`;

describe("pre-push delete-only skip", () => {
  it("runs the checks when stdin carries no refs at all", () => {
    // The regression. Empty stdin is not evidence of a delete-only push — it is
    // evidence of nothing, and the hook must fail toward running the suite.
    expect(runGuard("")).toEqual({ skipped: false, ranChecks: true });
  });

  it("runs the checks when stdin is a blank line", () => {
    // A blank line yields an empty oid, which contains no non-zero character
    // and would otherwise be counted as one more deletion.
    expect(runGuard("\n")).toEqual({ skipped: false, ranChecks: true });
  });

  it("skips on a single deletion", () => {
    expect(runGuard(`${deleteLine("stale")}\n`)).toEqual({ skipped: true, ranChecks: false });
  });

  it("skips when every ref is a deletion", () => {
    const stdin = `${deleteLine("stale-a")}\n${deleteLine("stale-b")}\n`;
    expect(runGuard(stdin)).toEqual({ skipped: true, ranChecks: false });
  });

  it("runs the checks when a deletion is pushed alongside a real update", () => {
    const stdin = `${deleteLine("stale")}\n${updateLine("feature")}\n`;
    expect(runGuard(stdin)).toEqual({ skipped: false, ranChecks: true });
  });

  it("runs the checks on an ordinary push", () => {
    expect(runGuard(`${updateLine("feature")}\n`)).toEqual({ skipped: false, ranChecks: true });
  });
});
