# CI-trust — #1673 A vitest run that loses files to worker starvation can exit 0: nothing anchors files-collected against files-run

Branch `fix/ci-reds-that-say-nothing-about-the-diff-under-test-1673`. Closes #1673. Track: `docs/reviews/2026-09-02-v1-review/tracks/K-tests-and-lows.md`. Probe: `npx vitest list --filesOnly --json=<path>` against `npx vitest run --reporter=json` — measured below.

## Problem

Vitest's summary counts what it **ran**. It never asserts that what it ran equals what it **collected**. A run that loses seven files to `[vitest-pool]: Failed to start forks worker` prints `580 passed (580)` where the healthy tree reports 587 — indistinguishable from a pass unless the reader knows the number by heart. The recorded instance exited 1 (via the `Unhandled Errors` block), which is why the owner's triage comment on the issue asks for a discriminating run before treating silent-green as reproduced. The hardening request stands on its own regardless: **nothing in the tree compares the two lists**, so the exit code of a starved run is a property of which files happened to be lost, not a property the suite asserts. This is the #1229 / #1399 / #1529 zero-of-zero shape, and every previous instance was closed with a positive anchor.

The `check` job is a required status check, so an anchor placed there **blocks** — no ADR-051 wiring test is needed for it (ADR-051 governs advisory jobs; this is not one).

## Fix

One new script and one new `check` step. Nothing about pool sizing, timeouts or `maxForks` — the issue names raising ceilings as explicitly not the fix, and `vitest.config.ts`'s two existing comments already say those ceilings were measuring contention.

**`scripts/ci/vitest-file-anchor.mjs`** (new). Modelled on `scripts/ci/coverage-gate.mjs` — a pure exported comparator plus a `main()` behind the `import.meta.url` guard — and on `scripts/ci/windows-acl-proof.mjs` for the vitest-JSON-report shape and the fresh-report-directory rule.

- `export const EXIT_CANNOT_EVALUATE = 3;` — same convention and same value as `coverage-gate.mjs`, so a run that could not evaluate is distinguishable from one that evaluated and refused.
- `export function compareFileSets({ expected, reported })` — pure, touches no filesystem, exits no process. `expected` is `vitest list --filesOnly --json`'s array (`{file, projectName}`); `reported` is the run report's `testResults` (`{name, status}`). Returns the same four keys on every path: `{ ok, cannotEvaluate, checked, failures }`, `failures` present and empty on success (the reason `coverage-gate.mjs` gives: an optional array reads as `T[] | undefined` at every call site and `expect(v.ok).toBe(false)` does not narrow it).
  - Compare **normalized absolute paths**, not raw strings: `String(p).replace(/\\/g, "/")`, the `toPosix` helper `windows-acl-proof.mjs` already uses. Measured on Windows: both sources emit forward slashes today, so a raw comparison would pass here and be untestable — normalize anyway and pin both spellings, the same seam `relativizeSummaryKey` was rewritten for.
  - A file in `expected` with **no** entry in `reported` → `failures.push({ file, kind: "DID-NOT-RUN" })`.
  - A file reported with status `"pending"`/`"skipped"` **ran**. The issue is explicit: *a file that never started is not a skip.* Likewise `"failed"` ran — this anchor is not a test-failure gate; vitest's own exit code is.
  - `expected` empty, or not an array → `cannotEvaluate` ("zero collected" is the failure this exists to catch, never "nothing to check, therefore fine" — `windows-acl-proof.mjs`'s own phrasing).
  - `reported` missing or not an array → `cannotEvaluate`.
- `main()`: reads the run report from `process.argv[2]`; obtains `expected` either from `--expected=<path>` (a JSON file) or, absent that flag, by spawning `npx vitest list --filesOnly --json=<tmp>` into a fresh `mkdtempSync` directory. Measured: 2.46 s, 655 files, so the extra vitest boot is noise against `check`'s 13 min. Prints every missing filename (the issue asks for names, not a count), then `exit 0 / 1 / EXIT_CANNOT_EVALUATE`. **The `--expected=` seam exists so the exit-code contract is testable without booting vitest** — `main()` being coverable by nothing is the defect review found in `coverage-gate.mjs`, where `process.exit(EXIT_CANNOT_EVALUATE) → process.exit(0)` survived every spec.

**`.github/workflows/ci.yml`**, `check` job. The `Test` step becomes a block that clears any stale report first (`windows-acl-proof.mjs`'s fresh-report rule: a leftover at a fixed path is parsed as this run's if vitest died before writing one):

```yaml
      - name: Test
        run: |
          rm -f .vitest-report.json
          npm test -- --run --reporter=default --reporter=json --outputFile.json=.vitest-report.json

      - name: Every collected test file actually ran
        if: ${{ !cancelled() }}
        run: node scripts/ci/vitest-file-anchor.mjs .vitest-report.json
```

`--reporter=default` is kept so the human-readable output does not disappear; `--outputFile.json=` is the per-reporter form required when two reporters are active (verified: the report is written and the default output still prints). `if: ${{ !cancelled() }}` and not `always()`: a run can both fail a test **and** lose files, so the anchor must survive a red `Test`; `success()` would re-create exactly the bug #1862 is about. No `continue-on-error`, no `|| true`.

**`.gitignore`**: add `.vitest-report.json` beside the existing `coverage/` block.

## Tests

`tests/scripts/vitest-file-anchor.test.ts`, importing `compareFileSets` and `EXIT_CANNOT_EVALUATE` (the `coverage-gate.test.ts` pattern — synthetic inputs, every verdict driven, no CI involved). Each case names the wrong implementation it kills:

1. **Equal counts, different names** (one file lost, one unexpected extra) → `ok:false`, the lost name in `failures`. Kills the naive `expected.length === reported.length`, which is the first thing anyone writes and which passes the starvation case whenever a file is added in the same run.
2. **One collected file absent from the report** → `ok:false`, `kind: "DID-NOT-RUN"`, and the message contains the filename. Kills a count-only or boolean-only anchor (the issue: print the names).
3. **Reported with `status: "pending"`, and again with `"skipped"`** → `ok:true`. Kills the implementation that treats a skip as an absence — the anchor would then be red on every run of this tree, which has 3 skipped files, and would be disabled within a day.
4. **Reported with `status: "failed"`** → `ok:true`. Kills an anchor that duplicates vitest's exit code and turns one failing test into two reds saying different things.
5. **`expected: []`** → `cannotEvaluate:true`, `ok:false`. Kills "nothing collected, therefore fine" — the #1229 shape one level up, and the one a green `vitest list` failure would produce.
6. **`reported` undefined / not an array** → `cannotEvaluate:true`. Kills a comparator that treats a missing report as an empty one and reports every file missing (a red for the wrong reason) or none (a green for the wrong reason).
7. **Separator normalization**: `expected` with `/`, `reported` with `\` for the same file → `ok:true`; and the same pair with genuinely different files → `ok:false`. Kills a raw-string comparison, which on this repo's Windows checkout is indistinguishable from the real thing.
8. **CLI exit codes, subprocess** (the `coverage-gate-wiring.test.ts` `main()` spec's shape, `spawnSync(process.execPath, [script, report, "--expected=" + expectedPath])` over temp fixtures): a complete pair → exit 0; one missing file → exit 1; a report path that does not exist → exit `EXIT_CANNOT_EVALUATE` (3), **not** 1 and **not** 0. Without this the three arms of `main()` are covered by nothing and `process.exit(3) → process.exit(0)` survives the whole file.

## Done when

`compareFileSets` refuses a collected-but-unrun file by name; the eight cases above pass; the `check` job runs the anchor after `Test` with `if: ${{ !cancelled() }}`; a hand-edited report with one entry deleted turns the anchor red locally; `npm run typecheck:tests` and the suite are green.

## Not in scope

The pre-push hook (the anchor is CI-only; the hook already runs the full suite and a starved local run is the developer's own machine). `maxForks` / pool sizing — the issue calls it a partial mitigation and explicitly not a substitute. Any change to `vitest.config.ts`'s two timeouts. A wiring test pinning the anchor step: `check` is required, so the anchor's own red is the signal, and the step failing closed on a missing report (exit 3) already covers the disarm-by-dropping-the-reporter case.
