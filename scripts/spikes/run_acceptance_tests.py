#!/usr/bin/env python3
"""Fail-closed runner for the session-monitor acceptance harness (#1399).

`python -m unittest test_session_monitor_acceptance` exits 0 in THREE situations where
nothing was actually evaluated, all reachable from an ordinary-looking edit:

  1. it collects zero tests -- rename the `test` method prefix and collection finds
     nothing (class names are irrelevant to `loadTestsFromName`; only the method
     prefix drives it), and `unittest` reports "Ran 0 tests ... OK";
  2. every collected test is skipped -- one blanket `@unittest.skip` on a class;
  3. a failing test is decorated `@unittest.expectedFailure` -- `unittest` counts an
     expected failure as a PASS, so `wasSuccessful()` stays true and the run reports
     "OK (expected failures=1)".

The third is the nastiest of the three, and it is why `expectedFailures` is checked
here rather than assumed absent: it does not move `testsRun`, does not move the skip
count, and leaves this module's own summary line byte-identical to a healthy run
unless the count is printed. A CI log reader looking at the one artefact this runner
emits would see nothing at all.

A gate that reports success when it could not evaluate is the #1229 failure mode, and
it is worse than no gate, because a green CI then asserts coverage that does not exist.
So this runner refuses to exit 0 unless the suite was really evaluated:

  * the loader reported no collection errors,
  * every test passed,
  * nothing was marked `@unittest.expectedFailure` -- a hard zero, not a ceiling; the
    harness has none today and a gate suite is not a place to acquire one,
  * `testsRun` equals the count the loader collected (nothing vanished in between),
  * at least one test actually executed,
  * and no more than MAX_SKIPS tests skipped.

MAX_SKIPS is a *ceiling*, deliberately, not a floor on executed tests. A floor is a
second frozen literal that moves every time a test is legitimately added or removed,
so a reviewer cannot tell a maintenance bump from a weakening. This ceiling does not
move with suite size, so any diff that raises it is unambiguously a weakening.

The ceiling has one boundary it cannot see on its own: a suite of exactly MAX_SKIPS
tests, all skipped, satisfies both `collected > 0` and `skipped <= MAX_SKIPS` while
executing no test bodies at all. That is a weakening which does not raise the ceiling.
It is unreachable against the real harness without first deleting 80 tests, but the
`testsRun - skipped` check below closes it anyway -- a derived quantity, so it does
not reintroduce the frozen-literal problem a MIN_EXECUTED floor would.

It also takes no arguments at all, and says so rather than ignoring them -- see the
comment in `main()`.

`tests/scripts/acceptance-harness-wiring.test.ts` spawns this file against purpose-built
broken fixtures and asserts it exits non-zero, so these decisions are covered as
behaviour rather than as constants appearing in the source.
"""

from __future__ import annotations

import sys
import unittest

MODULE = "test_session_monitor_acceptance"

# The two tests that are expected to skip, and the only two:
#   test_session_monitor_acceptance.py:478  @unittest.skipUnless(os.name == "nt", ...)
#       -- junction/reparse-point behaviour, Windows-only. Skips on the Linux CI runner.
#   test_session_monitor_acceptance.py:1796 self.skipTest("no evidence bundle available;
#       set TANDEM_ACCEPTANCE_BUNDLE") -- the stored ten-trial capture bundle is not in
#       the repo, so this skips anywhere it is not pointed at one.
# Raising this number is how a disabled test would be laundered into a green run.
MAX_SKIPS = 2


def main() -> int:
    # `loadTestsFromName(MODULE)` hard-codes the target, so every unittest flag and
    # selector that worked against the `python -m unittest MODULE` this replaced --
    # `-v`, `-k <pattern>`, `-f`, `Class.test_name` -- would now run the FULL suite
    # and exit 0, having ignored the narrowing without a word. A developer who
    # narrowed to one test would read that exit 0 as "my one test passed". Refusing
    # is the only option here that cannot be misread; forwarding argv into
    # `unittest.main()` would hand back the exit-0-on-nothing-evaluated behaviour
    # this whole file exists to remove.
    if sys.argv[1:]:
        print(
            f"FAIL: this runner takes no arguments (got {sys.argv[1:]}). It always runs all of "
            f"{MODULE}: unittest flags and test selectors would be silently ignored, not honoured. "
            f"To narrow a run, invoke `python -m unittest {MODULE} <args>` directly -- but note "
            "that is NOT the gate: it exits 0 on zero collected, on all-skipped, and on "
            "@unittest.expectedFailure.",
            file=sys.stderr,
        )
        return 2

    loader = unittest.TestLoader()
    suite = loader.loadTestsFromName(MODULE)

    # `loadTestsFromName` reports an import failure as a synthetic _FailedTest rather
    # than raising, so a broken module would otherwise "run 1 test" and look evaluated.
    if loader.errors:
        for error in loader.errors:
            print(error, file=sys.stderr)
        print(f"FAIL: {MODULE} could not be collected", file=sys.stderr)
        return 1

    collected = suite.countTestCases()
    result = unittest.TextTestRunner(verbosity=1, stream=sys.stderr).run(suite)
    skipped = len(result.skipped)
    expected_failures = len(result.expectedFailures)
    # `expected_failures` is in this line specifically so the telemetry is not blind to
    # the one laundering route that leaves every other number untouched.
    print(
        f"acceptance harness: collected={collected} run={result.testsRun} "
        f"skipped={skipped} expected_failures={expected_failures} max_skips={MAX_SKIPS}",
        file=sys.stderr,
    )

    if not result.wasSuccessful():
        return 1
    if collected == 0:
        print(f"FAIL: {MODULE} collected no tests", file=sys.stderr)
        return 1
    if expected_failures:
        print(
            f"FAIL: {expected_failures} test(s) marked @unittest.expectedFailure -- "
            "unittest scores those as passes, so this is a disabled test that leaves "
            "`Ran N tests ... OK` and every other count in this line unchanged",
            file=sys.stderr,
        )
        return 1
    if result.testsRun != collected:
        print(
            f"FAIL: collected {collected} tests but ran {result.testsRun}",
            file=sys.stderr,
        )
        return 1
    if result.testsRun - skipped <= 0:
        print(
            f"FAIL: all {result.testsRun} collected tests skipped -- no test body ran. "
            "A suite of MAX_SKIPS tests, all skipped, satisfies the ceiling below "
            "without executing anything.",
            file=sys.stderr,
        )
        return 1
    if skipped > MAX_SKIPS:
        print(
            f"FAIL: {skipped} tests skipped, at most {MAX_SKIPS} expected -- a test was "
            "disabled, or this ran somewhere the two known skips do not apply",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
