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

/** A check command at column zero — the first one ends the decision region. */
const CHECK_COMMAND = /^(npx|npm|cargo)\s/;

function hookLines(): string[] {
  return readFileSync(HOOK_PATH, "utf-8").split(/\r?\n/);
}

/**
 * Everything the hook decides before the first check command runs. Slicing it
 * out rather than copying the logic is what keeps this test honest: an edit to
 * the hook is an edit to the code under test.
 */
function decisionBlock(): { block: string; skipMessage: string } {
  const lines = hookLines();

  // Slice at the FIRST check command, not at the first bare `fi`.
  //
  // The `fi` anchor was defeated: appending a second early exit *after* the
  // delete-only guard put it outside the slice, so a new unconditional
  // `SKIP_PREPUSH` bypass of the entire suite left all six specs green. The
  // region that matters is "everything the hook decides before any check
  // runs", and that is exactly what ends at the first check command — so an
  // added skip path now lands inside the block these specs execute, and inside
  // the reach of the single-exit spec below.
  const end = lines.findIndex((line) => CHECK_COMMAND.test(line));
  expect(end, "the hook no longer runs a recognised check command").toBeGreaterThan(0);
  const block = lines.slice(0, end).join("\n");

  // A slice that no longer contains the decision would make every spec below
  // pass vacuously, so make its absence the failure.
  expect(block, "sliced prefix lost the stdin read loop").toContain("while read -r");

  // Read the skip message OUT of the hook instead of hardcoding it. A copy
  // edit to that echo string is not a behaviour change, and an earlier version
  // of this file — which pinned the wording — turned a comma-to-dash reword
  // into six red specs. The sanity check that exists to stop vacuous passing
  // must not itself become the brittle part.
  const echoed = /echo "([^"]+)"/.exec(block);
  expect(echoed, "sliced prefix lost the skip branch's echo").not.toBeNull();
  return { block, skipMessage: (echoed as RegExpExecArray)[1] };
}

/** Runs the guard with `stdin` and reports what the hook would have done. */
function runGuard(stdin: string): { skipped: boolean; ranChecks: boolean } {
  const { block, skipMessage } = decisionBlock();
  const script = `${block}\necho "${RUNNING_MARKER}"\n`;
  const out = execFileSync("sh", ["-c", script], { input: stdin, encoding: "utf-8" });
  return { skipped: out.includes(skipMessage), ranChecks: out.includes(RUNNING_MARKER) };
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

  it("counts a final line that has no trailing newline", () => {
    // POSIX `read` reports failure at EOF-without-newline, so a plain
    // `while read` drops that line AFTER assigning its variables. A deletion
    // followed by an unterminated real update therefore skipped every check —
    // the same fail-open wearing a different disguise, and invisible to the
    // five specs above because every one of them terminates its last line.
    const stdin = `${deleteLine("stale")}\n${updateLine("feature")}`;
    expect(runGuard(stdin)).toEqual({ skipped: false, ranChecks: true });
  });

  it("has exactly one way to exit before the checks run", () => {
    // The scope defeat, and the reason this spec is not redundant with the six
    // above. They pin how the delete-only branch DECIDES; none of them notices
    // a SECOND early exit appearing next to it. An added
    // `[ -n "$SKIP_PREPUSH" ] && exit 0` is a new unconditional bypass of
    // biome, the test-tree typecheck, vitest and cargo — the exact failure
    // this file exists to prevent — and it passed all six while the slice was
    // anchored at the first `fi`.
    //
    // A second exit is not forbidden, only unreviewable in silence: adding one
    // means adding its specs here.
    const lines = hookLines();
    const decisionRegion = lines.slice(
      0,
      lines.findIndex((line) => CHECK_COMMAND.test(line)),
    );
    const exits = decisionRegion.filter((line) => /\bexit\b/.test(line));
    expect(exits, "the hook gained or lost an early exit before the checks").toHaveLength(1);
    expect(exits[0]).toContain("exit 0");
  });
});
