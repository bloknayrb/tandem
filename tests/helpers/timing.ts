import { expect } from "vitest";

/**
 * Assert that something finished inside a wall-clock budget -- except during a
 * coverage run, where the budget measures the profiler.
 *
 * V8 coverage instrumentation slows this suite substantially (measured on the
 * first full baseline runs: `tests` 765s uninstrumented against 847-982s
 * instrumented, and two files with their own inline ceilings exceeded them --
 * see `timeoutMs` below for which). A wall-clock
 * upper bound written to catch a real regression -- streaming that silently
 * degrades to decompress-everything, a probe that stops being bounded -- cannot
 * distinguish that regression from the instrumentation once both are in play.
 *
 * The three sites that use this all followed the same reasoning in their own
 * comments: time is the only available *proxy* for the property they care
 * about. A proxy that is known-invalid under a given run should say so, not
 * quietly ride on whether the machine was fast enough that day. Before this
 * helper, `tests/server/platform.test.ts`'s 500ms bound and
 * `tests/cli/mcp-stdio.test.ts`'s 3s bound both PASSED under coverage while
 * `tests/server/docx-size-gate.test.ts`'s 5s bound failed -- the difference was
 * luck, not signal.
 *
 * **This suspends the bound only when `TANDEM_COVERAGE=1`, which is set by the
 * `test:coverage` script and by nothing else.** Under `npm test`, the pre-push
 * hook and the CI `check` job, every one of these is enforced exactly as
 * before. `scripts/ci/coverage-manifest.mjs` lists the suspended sites in the
 * published artifact, and `tests/scripts/coverage-manifest-wiring.test.ts`
 * fails if that list drifts from the call sites here -- so a fourth site cannot
 * be added and silently go unmentioned.
 *
 * Lower bounds do not need this and must not use it: instrumentation can only
 * make something take longer, so a `toBeGreaterThan` is unaffected.
 *
 * @param elapsedMs   measured duration
 * @param budgetMs    the upper bound the test is asserting
 * @param proxyFor    what the bound stands in for, for the failure message
 */
let announcedSuspension = false;

export function expectWithinMs(elapsedMs: number, budgetMs: number, proxyFor: string): void {
  if (process.env.TANDEM_COVERAGE === "1") {
    // Say so, once. A suspension that leaves no trace in the output is the same
    // shape as the problem this helper exists to fix: an assertion that is not
    // asserting, with nothing visible to say it stopped. `TANDEM_COVERAGE` is
    // set only by `test:coverage` today -- pinned by
    // `tests/scripts/coverage-manifest-wiring.test.ts` -- but a stray export in
    // a shell profile or a copy-pasted CI `env:` would silently disarm all
    // three bounds, and this line is what makes that visible instead.
    if (!announcedSuspension) {
      announcedSuspension = true;
      console.warn(
        "[timing] TANDEM_COVERAGE=1: wall-clock upper bounds are SUSPENDED for this run. " +
          "Expected under `npm run test:coverage`; anywhere else, the variable has leaked.",
      );
    }
    return;
  }
  expect(elapsedMs, `wall-clock proxy for: ${proxyFor}`).toBeLessThan(budgetMs);
}

/**
 * A per-test or per-hook timeout with extra headroom under coverage.
 *
 * Vitest's `--testTimeout` / `--hookTimeout` flags do NOT raise a timeout
 * written as the second argument to `it`/`beforeAll` -- the explicit value
 * wins. So the handful of places that set their own ceiling have to opt in, or
 * they fail under instrumentation for a reason that has nothing to do with what
 * they assert. Both current callers are in that position: one builds 1,500
 * editor entries, the other scans every tracked `.md` in the repo (measured at
 * 175s instrumented, against a 120s ceiling).
 *
 * This is only ever safe where duration is NOT the property under test. Where
 * it is, use {@link expectWithinMs}, which suspends the bound and gets the site
 * named in the published coverage manifest. Silently multiplying a ceiling that
 * IS the assertion would turn a real gate into a slower real gate that no
 * longer catches anything.
 */
export function timeoutMs(normal: number, underCoverage: number): number {
  return process.env.TANDEM_COVERAGE === "1" ? underCoverage : normal;
}
