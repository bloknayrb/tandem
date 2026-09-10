# CI-trust — #1862 coverage job: a red reads as a floor breach when vitest can flake before the gate ever runs

Branch `fix/ci-reds-that-say-nothing-about-the-diff-under-test-1673`. **`Refs #1862`, not `Closes` — #1862 stays open.** This PR fixes part 2 (the part the issue calls "the part that matters more"); part 1 is refuted as stated and stays tracked on #1862 with a comment, following this sweep's Decision B precedent. **This changes the group contract's `closes: #1862` to `refs`.** Track: `docs/reviews/2026-09-02-v1-review/tracks/K-tests-and-lows.md`. Probe: run `node scripts/ci/coverage-gate.mjs` from a temp tree with `coverage/` absent and read its exit code.

## Problem

`package.json:56` — `"test:coverage": "cross-env TANDEM_COVERAGE=1 vitest run --coverage … && node scripts/ci/coverage-manifest.mjs && node scripts/ci/coverage-gate.mjs"` — is one `&&` chain behind one CI step (`ci.yml`, `run: npm run test:coverage`). **Any** vitest exit short-circuits the chain, so the manifest and the gate never execute, and the job reports the identical red it reports for a genuine floor breach.

Measured 2026-09-09 on PR #1930, a docs-only diff: vitest exited 1 with 652 files passed / 0 failed and one `EnvironmentTeardownError` (`Closing rpc while "onUserConsoleLog" was pending`, originating in `tests/server/snapshot-truncation-reload.test.ts`). No floor was breached; no floor was **evaluated**. Establishing that took reading a whole log for a verdict line that was absent, then downloading the artifact.

The gate already knows how to say this: `coverage-gate.mjs` exports `EXIT_CANNOT_EVALUATE = 3` and prints `The gate could not evaluate. This is not a pass.` **The bug is not that the gate cannot report it — it is that the gate is never reached to say it.**

**The `&&` chain is doing a second job.** It also stops the gate judging a measurement nobody vouched for. Decouple naively — `if: ${{ !cancelled() }}` on both, no change to the gate — and a run that loses test files still writes `coverage/coverage-summary.json`; `coverage-manifest.mjs` refuses it and exits 1, and the gate evaluates it anyway. Under `coverage.include` an unexercised module reports **0%**, so the gate emits specific per-module floor breaches: a red that reads as a precise finding about the diff. That is worse than today.

So the fix has two halves: **run the gate whatever vitest did**, and **never let it reach exit 1 on a measurement that did not complete or that the manifest refused.** A vitest run that exits **0** having silently lost a handful of files is **not** covered here — that is #1673's file anchor in `check`, because catching it needs a files-collected/files-run comparison nothing in this job can do.

## Fix

**`package.json`** — three scripts where there was one. The vitest half keeps its flags byte-for-byte:

- `"test:coverage": "cross-env TANDEM_COVERAGE=1 vitest run --coverage --coverage.reporter=text --coverage.reporter=json-summary --coverage.reporter=html --testTimeout=120000 --hookTimeout=300000"`
- `"coverage:manifest": "node scripts/ci/coverage-manifest.mjs"`
- `"coverage:gate": "node scripts/ci/coverage-gate.mjs"`

**`.github/workflows/ci.yml`**, `coverage` job:

```yaml
      - name: Coverage baseline
        id: baseline
        run: npm run test:coverage
        timeout-minutes: 30

      - name: Coverage manifest
        if: ${{ !cancelled() }}
        run: npm run coverage:manifest

      - name: Coverage floors
        if: ${{ !cancelled() }}
        run: npm run coverage:gate
        env:
          TANDEM_MEASUREMENT_OUTCOME: ${{ steps.baseline.outcome }}

      - name: Upload coverage baseline
        uses: actions/upload-artifact@… # unchanged
        if: always()
        …
```

`${{ !cancelled() }}`, never `always()` and never `success()`. `success()` is the present behaviour written as YAML — the whole bug. `always()` would manufacture a cannot-evaluate red on a cancelled run. Both new steps stay blocking: no `continue-on-error`, no `|| true`.

**`Upload coverage baseline` stays LAST**, after `Coverage floors`: it is `if: always()` and its `path:` names `coverage/baseline-manifest.json`, which is now produced by the `Coverage manifest` step. Appending the new steps after the upload would publish an artifact missing the file that made the 2026-09-09 diagnosis possible.

**`scripts/ci/coverage-gate.mjs` — two new fail-closed arms**, both exiting `EXIT_CANNOT_EVALUATE` (3), never 1.

**Their placement is literal and load-bearing.** The order in `main()` is: read `coverage-policy.json` (`:233-238`), then read `coverage/coverage-summary.json` (`:240-247`) — both keeping their existing cannot-evaluate messages byte-for-byte, each gaining one **added trailing line** (below) — **then** arm 1, **then** arm 2, **then** the `evaluateGate` call at `:249`. Both arms therefore sit immediately above `evaluateGate` and **after** the summary read, never before it. That order is what keeps `tests/scripts/coverage-gate-wiring.test.ts:357` true: its temp tree (`:334-360`) holds only `coverage-gate.mjs` + `coverage-policy.json`, so `coverage/baseline-manifest.json` is absent there too, and it asserts the *specific* message `cannot read coverage/coverage-summary.json` with `status === 3`. Put arm 2 first and that spec goes red inside the **required** `check` job for a reason unrelated to the diff — this group's own failure class. **Do not reorder, and do not relax that assertion to a bare `toContain("[coverage-gate]")`**: its comment records that `process.exit(EXIT_CANNOT_EVALUATE) → process.exit(0)` survived every other spec in both files, so that message is the only thing pinning the exit.

1. **The measurement must have completed.** If `process.env.TANDEM_MEASUREMENT_OUTCOME` is set and is not `"success"`, print `[coverage-gate] the measurement did not complete (outcome: <v>); this is not a pass` and exit 3. **Absent** is not a failure — a local `npm run coverage:gate` sets nothing and keeps the normal path.
2. **The manifest must have accepted the measurement.** If `coverage/baseline-manifest.json` does not exist, print `[coverage-gate] no baseline manifest: the measurement was refused as partial (or coverage:manifest has not run since it)` and exit 3. `coverage-manifest.mjs` writes that file **only** on acceptance (`OUT` at `:47`; every refusal goes through `die()` → `process.exit(1)` at `:525` without writing), so its absence carries the manifest's refusal forward — the ordering guarantee the `&&` used to provide, restated as a precondition. It **never unlinks a previous manifest**, so absence is a sound proxy for refusal on a fresh checkout (CI) and can be masked locally by a stale file; the message's parenthetical is what tells a local reader which case they are in.

**Every cannot-evaluate path must end on the same last line.** Today the literal `The gate could not evaluate. This is not a pass.` is printed at exactly **one** site, `:264`, reachable only through `evaluateGate`'s `verdict.cannotEvaluate` branch at `:263` — which neither existing early read (`:237`, `:245`) nor either new arm ever reaches, because all four `process.exit(EXIT_CANNOT_EVALUATE)` before it. So the line the ci.yml triage guide and **Done when** both key on is a line no exit-3 path prints. Fix that directly: **all four** exits — the policy read, the summary read, arm 1 and arm 2 — print their **specific reason line** (unchanged byte-for-byte for the two existing ones) and then, as the **last** line, the shared literal:

```
[coverage-gate] The gate could not evaluate. This is not a pass.
```

The named reason is therefore the second-to-last line and the shared literal the last one, on every path a reader is told to key on. This is compatible with `tests/scripts/coverage-gate-wiring.test.ts:357`, which is a `toContain("cannot read coverage/coverage-summary.json")` plus `status === 3`: an extra trailing line leaves it byte-identical and green, which **Done when** requires.

No change to `coverage-manifest.mjs` or `coverage-policy.json`. No v8-ignore hint anywhere, no `|| true`.

**The job comment block above `coverage:` in `ci.yml`** says the chain runs as one step; that becomes false. Replace that claim with the three-way reading — the whole point of the issue:

> A red `Coverage floors` means the gate **ran** — read its last line. `[coverage-gate] N failure(s).` is a real floor breach on a measurement that completed and was accepted. `The gate could not evaluate. This is not a pass.` is a measurement that did not happen; read the two steps above it. Not covered here: a measurement that exited 0 having silently lost test files still grades as a floor breach — that is the vitest file anchor in `check` (#1673).

**`docs/cli.md:181`** documents `test:coverage` as one command that does all three. Correct that row to the three scripts and state their order as a precondition, because a reader who types only the first and third now gets an exit-3 red on a good measurement. Attribute the exit-3 convention to `coverage:gate` **only**: `coverage-manifest.mjs` exits **1** on every refusal (`:525` is its only exit call).

**ADR-051 half.** `coverage` is advisory and not a required status check (#1728, dated), so the guarantee this adds is disarmable by editing one YAML line and must be pinned from inside `check`. Both existing wiring tests pin the *old* shape and will fail; updating them **is** the work, not extra scope:

- `tests/scripts/coverage-gate-wiring.test.ts:280-308`. Its `toBe(...)` exact-equality pin on `test:coverage` (ADR-051 rule 1 — never `toContain`, because `|| true` leaves `ci.yml` byte-identical) becomes three exact-equality pins, one per script. Its "the job and the measurement step carry no `if:`" assertion keeps the measurement half and gains: a step whose `run` includes `coverage:gate` exists, **its `run` trimmed is `toBe("npm run coverage:gate")` by EXACT equality**, its parsed `if` is **exactly** `${{ !cancelled() }}`, its `continue-on-error` is falsy, and its parsed `env.TANDEM_MEASUREMENT_OUTCOME` is **exactly** `${{ steps.baseline.outcome }}` against a `Coverage baseline` step whose `id` is exactly `baseline`. Literal equality on the `if`, so `success()` and `always()` both fail it.

  **The exact-equality pin on the step's shell line is not optional and is not covered by the package.json pins.** Today the whole chain is one npm script pinned by exact equality at `:284`, and the single CI step's shell line is separately pinned at `coverage-manifest-wiring.test.ts:305` (`expect(run?.run).not.toContain("|| true")`). Moving the gate out of the `&&` chain into its own step moves the disarm surface with it: `run: npm run coverage:gate || true` leaves package.json byte-identical, `continue-on-error` absent and the `if` literal exact, so every other assertion here passes. Use the `typecheck-tests-wiring.test.ts:137` idiom — exact equality subsumes the whole exit-code-masking family (`|| true`, `; true`, `|| echo …`, `set +e &&`, a trailing pipe) in one assertion, where a denylist covers it only partly.
- `tests/scripts/coverage-manifest-wiring.test.ts:123-131`. Its three substring assertions over the `test:coverage` chain were checking that a chain could not be weakened; there is no chain now. Replace with an exact-equality pin on `coverage:manifest` **plus an exact-equality pin on the `Coverage manifest` step's own shell line — `expect(step.run?.trim()).toBe("npm run coverage:manifest")`, the same reason as above** — plus the same parsed-field assertions against that step. Its `TANDEM_COVERAGE` sweep (`:213-222`) asserts that variable is set only by `test:coverage` — that still holds; do not move `cross-env TANDEM_COVERAGE=1` onto the new scripts. The new variable is `TANDEM_MEASUREMENT_OUTCOME`, deliberately not a `TANDEM_COVERAGE_*` name, so it cannot collide with that sweep by construction.
- Read YAML attributes as **parsed fields**, never substrings (ADR-051 rule 2): `continue-on-error` and `env` are siblings of `run:` and never appear in a shell line.

## Tests

The wiring edits above are most of the tests; each is stated as the mutant it kills:

1. `if: success()` or `if: always()` on `Coverage floors` → the literal-equality assertion fails. `toBeTruthy()` would pass `always()` and `toBeDefined()` would pass `success()`; only a literal catches both.
2. `|| true` appended to `coverage:gate` in `package.json`, or the step deleted → the exact-equality pin / the "a step runs `coverage:gate`" assertion fails, while `ci.yml` stays byte-identical. ADR-051 rule 1's whole reason.
3. `continue-on-error: true` on either new step, or the `env:` block or `id: baseline` deleted → the parsed-field assertions fail. Without the env passthrough the gate silently loses arm 1 and grades incomplete measurements again, with no other symptom.
3a. `|| true` appended to **either new step's `run:` line in `ci.yml`** (not package.json) → the exact-equality pin on that step's `run` fails. Its own mutant, because item 2's package.json pin does not see it and `continue-on-error` stays absent: this is the surface the change creates by moving the gate out of the `&&` chain, and today's `coverage-manifest-wiring.test.ts:305` `not.toContain("|| true")` on the old single step is what it replaces.

Two behavioural specs, driven the way the existing exit-3 spec is — **by copying `coverage-gate.mjs` and `coverage-policy.json` into a `mkdtempSync` tree** so `repoRoot` resolves there (`main()` resolves it from the script's own directory, `:229-230`):

4. Summary present, `baseline-manifest.json` absent → exit **3**, output contains `no baseline manifest` **and its last line is `[coverage-gate] The gate could not evaluate. This is not a pass.`**. Kills arm 2's removal — the regression that lets a partial run land as a floor breach — and kills an arm that exits 3 without the shared closing line, which is what makes the ci.yml triage guide readable.
5. Summary present, manifest present, `TANDEM_MEASUREMENT_OUTCOME=failure` → exit **3**, output names the outcome **and ends on the same shared literal**; same fixture with the variable **unset** → not 3. Kills both an arm-1 removal and an over-eager arm 1 that would break every local `npm run coverage:gate`.

**Not a spec: "the shipped `coverage:gate` script name resolves to a process that exits 3."** `coverage-gate.mjs` resolves `repoRoot` from its own directory and reads `coverage/coverage-summary.json` beneath it; `coverage/` is gitignored and persists locally, so on any machine that has run `test:coverage` the shipped script takes the pass/fail path — the spec would be flaky or vacuous. The indirection is pinned textually instead: exact equality on the package.json script plus `existsSync` on the path.

## Done when

Three steps in the `coverage` job with the upload last; a vitest exit no longer prevents the gate from reporting; **`tests/scripts/coverage-gate-wiring.test.ts:357`'s `cannot read coverage/coverage-summary.json` assertion is still byte-identical and green**; the gate cannot reach exit 1 on a measurement that did not complete or that the manifest refused; **every one of the four `EXIT_CANNOT_EVALUATE` paths ends on the shared literal, with its named reason immediately above**; the wiring tests pin the `if` literal, the `env` passthrough, the `id`, the three scripts **and the two new steps' `run:` lines** by exact equality; specs 4 and 5 pass; `docs/cli.md` corrected; `npm run typecheck:tests` and the suite green. The observable outcome: a run that flakes at teardown shows `Coverage baseline` red and `Coverage floors` red **with `The gate could not evaluate. This is not a pass.` as its last line**, and no artifact download is needed to tell that from a floor breach.

## Files touched

`package.json`, `.github/workflows/ci.yml`, `scripts/ci/coverage-gate.mjs`, `tests/scripts/coverage-gate-wiring.test.ts`, `tests/scripts/coverage-manifest-wiring.test.ts`, `docs/cli.md`.

## Not in scope

**Part 1 of the issue — the `EnvironmentTeardownError` flake — is not fixed here, and the issue's hypothesis is refuted.** It proposes stubbing `console` in `tests/client/useTauriTheme.svelte.test.ts`; the 2026-09-09 instance originated in `tests/server/snapshot-truncation-reload.test.ts`, a different file in the other project. Two originating files means the class is `onUserConsoleLog` still in flight at teardown, not one noisy spec, so silencing one file buys nothing and would read as a fix. **No new issue is filed**: the PR says `Refs #1862`, #1862 stays open with a comment naming both originating files (this sweep's Decision B precedent). Closing #1862 while part 1 stands is what is not acceptable.

Also out: making `coverage` a required check (#1728, dated); any change to the floors, the policy, `coverage-manifest.mjs`, or `vitest.config.ts`.

## Review corrections (scope cut)

The round-1 and round-2 correction logs are dropped as superseded. Removed in this pass:

- **The `Clear stale coverage manifest` step** (`rm -f coverage/baseline-manifest.json` before the measurement). Its own mutant list already conceded nothing pins it and that CI's fresh checkout makes it a no-op; it existed only for a local tree, where arm 2's message parenthetical now carries the caveat. One fewer YAML line and one fewer unpinned invariant.
- **The upload-step index-ordering assertion** added to `coverage-manifest-wiring.test.ts`. Keeping `Upload coverage baseline` last is stated as placement in the Fix section; pinning it is a new gate the issue did not ask for, and the artifact's contents are not what #1862 is about.
- **The mutant list, 8 items → 5**, by merging the `if: success()` / `if: always()` pair, the `|| true` / step-deleted pair, and the `continue-on-error` / `env` / `id` triple. No verdict lost a driver. The `TANDEM_COVERAGE`-sweep mutant is dropped as a mutant and kept as a one-line naming constraint, which is what actually prevents it.
- **The `docs/cli.md` ordering prose** is cut to a single required correction (three rows, their order, exit-3 attributed to `coverage:gate` only) rather than a paragraph of convention.

Fixed directly rather than removed: both round-2 findings that the two new arms were placed only "before `evaluateGate`", leaving arm 2 free to run before the summary read and turn `coverage-gate-wiring.test.ts:357` red inside the required `check` job — with the likely repair being to relax the one assertion pinning that `process.exit(EXIT_CANNOT_EVALUATE)`. The Fix section now states the order literally (policy read → summary read → arm 1 → arm 2 → `evaluateGate`) with the reason, and **Done when** requires `:357` to stay byte-identical and green.

## Review corrections (post-cut)

Three findings from the post-cut review, adopted directly.

- **The canonical closing line was named as the observable outcome and printed by no exit-3 path.** Done when (and the ci.yml triage guide) keyed on `The gate could not evaluate. This is not a pass.`, which is printed at exactly one site (`coverage-gate.mjs:264`) reachable only through `evaluateGate`'s `verdict.cannotEvaluate` branch — a branch all four early exits, including both new arms, exit before reaching. In the 2026-09-09 scenario the spec uses as its acceptance test, the last line would have been arm 1's message, so the reader would still have had to read the whole log: the exact defect this issue exists to remove. The Fix section now requires all four exits — policy read, summary read, arm 1, arm 2 — to print their specific reason and then the shared literal as the last line, and Tests 4 and 5 assert it. This is deliberately compatible with `coverage-gate-wiring.test.ts:357` (`toContain` + `status === 3`), which Done when still requires to stay byte-identical.
- **The `|| true` disarm surface moved from a pinned place to an unpinned one.** Today the whole chain is one npm script under one exact-equality pin (`coverage-gate-wiring.test.ts:284`) and that step's shell line carries its own `not.toContain("|| true")` (`coverage-manifest-wiring.test.ts:305`). Splitting into three scripts and two steps pins the scripts but left the two new `run:` lines seen by nothing — `npm run coverage:gate || true` keeps package.json byte-identical, `continue-on-error` absent and the `if` literal exact. Both wiring edits now pin each new step's `run` by exact equality (the `typecheck-tests-wiring.test.ts:137` idiom), and it is mutant 3a rather than a footnote.
- No other change: the arm placement, the `if` literal, the `env`/`id` passthrough and the scope boundaries are unchanged.
