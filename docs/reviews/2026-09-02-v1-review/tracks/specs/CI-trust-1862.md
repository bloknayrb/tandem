# CI-trust — #1862 coverage job: a red reads as a floor breach when vitest can flake before the gate ever runs

Branch `fix/ci-reds-that-say-nothing-about-the-diff-under-test-1673`. Closes #1862 on its part 2 (the part the issue itself calls "the part that matters more"); part 1 is refuted as a file-specific bug and gets its own issue — see Not in scope. Track: `docs/reviews/2026-09-02-v1-review/tracks/K-tests-and-lows.md`. Probe: run `npm run coverage:gate` with `coverage/` absent and read its exit code.

## Problem

`package.json:56` — `"test:coverage": "cross-env TANDEM_COVERAGE=1 vitest run --coverage … && node scripts/ci/coverage-manifest.mjs && node scripts/ci/coverage-gate.mjs"` — is one `&&` chain behind one CI step (`ci.yml:240-242`, `run: npm run test:coverage`). **Any** vitest exit short-circuits the chain, so the manifest and the gate never execute, and the job reports the identical red it reports for a genuine floor breach.

Measured 2026-09-09 on PR #1930, a docs-only diff: vitest exited 1 with 652 files passed / 0 failed and one `EnvironmentTeardownError` (`Closing rpc while "onUserConsoleLog" was pending`, originating in `tests/server/snapshot-truncation-reload.test.ts`). No floor was breached; no floor was **evaluated**. Establishing that took reading a whole log for a verdict line that was absent, then downloading the `if: always()` artifact to find `coverage-summary.json` present and `baseline-manifest.json` absent.

The gate already knows how to say this. `coverage-gate.mjs` exports `EXIT_CANNOT_EVALUATE = 3`, prints `The gate could not evaluate. This is not a pass.`, and `coverage-gate-wiring.test.ts` pins exit 3 against a missing summary. **The bug is not that the gate cannot report "I could not evaluate" — it is that the gate is never reached to say it.** So the issue's second suggestion ("have the gate emit an explicit did-not-evaluate line") needs no code; only the first one does.

## Fix

Split the chain into three named steps, so the UI names the failing one and the gate runs whatever vitest did.

**`package.json`** — three scripts where there was one. The vitest half keeps its flags byte-for-byte:

- `"test:coverage": "cross-env TANDEM_COVERAGE=1 vitest run --coverage --coverage.reporter=text --coverage.reporter=json-summary --coverage.reporter=html --testTimeout=120000 --hookTimeout=300000"`
- `"coverage:manifest": "node scripts/ci/coverage-manifest.mjs"`
- `"coverage:gate": "node scripts/ci/coverage-gate.mjs"`

**`.github/workflows/ci.yml`**, `coverage` job:

```yaml
      - name: Coverage baseline
        run: npm run test:coverage
        timeout-minutes: 30

      - name: Coverage manifest
        if: ${{ !cancelled() }}
        run: npm run coverage:manifest

      - name: Coverage floors
        if: ${{ !cancelled() }}
        run: npm run coverage:gate
```

`${{ !cancelled() }}`, never `always()` and never `success()`. `success()` is the present behaviour written as YAML — the whole bug. `always()` would also run the gate on a cancelled job, producing a cannot-evaluate red for a run nobody asked to finish. Both later steps stay blocking: no `continue-on-error`, no `|| true`. The job comment block above `coverage:` (`ci.yml:183-227`) must be updated where it says the chain runs as one step, and must state the new invariant: **a red `Coverage floors` step means the gate evaluated; a red `Coverage baseline` with a green `Coverage floors` means the measurement flaked and no floor moved.**

No change to `coverage-gate.mjs`, `coverage-manifest.mjs` or `coverage-policy.json`. Adding a v8-ignore hint anywhere here is forbidden (CLAUDE.md, Testing & E2E), as is `|| true`.

**ADR-051 half.** `coverage` is advisory and not a required status check (#1728, dated), so the guarantee this fix adds — *the gate runs even when the measurement is red* — is disarmable by editing one YAML line and must be pinned from inside `check`. Both existing wiring tests currently pin the old shape and will fail; updating them **is** the ADR-051 work, not extra scope:

- `tests/scripts/coverage-gate-wiring.test.ts:280-308`. Its `toBe(...)` exact-equality pin on `test:coverage` (ADR-051 rule 1 — never `toContain`, because `|| true` leaves `ci.yml` byte-identical) becomes three exact-equality pins, one per script. Its "the job and the measurement step carry no `if:`" assertion keeps the measurement half and gains: the step whose `run` includes `coverage:gate` exists, its parsed `if` is **exactly** the string `${{ !cancelled() }}`, and its `continue-on-error` is falsy. Pin the `if` by literal equality, not by "is truthy" or "contains cancelled" — `success()` and `always()` must both fail it, and only a literal does that.
- `tests/scripts/coverage-manifest-wiring.test.ts:123-131`. Its three substring assertions over `test:coverage` (`toContain("&& node scripts/ci/coverage-manifest.mjs")`, `not.toContain("|| …")`, `not.toContain("; …")`) were checking that a chain could not be weakened; there is no chain now. Replace with an exact-equality pin on `coverage:manifest` plus the same step-shape assertions against the `Coverage manifest` step. Its `TANDEM_COVERAGE` sweep (`:213-222`) asserts the variable is set **only** by `test:coverage` — that still holds, and must keep holding: do not move `cross-env TANDEM_COVERAGE=1` onto the new scripts.
- Read YAML attributes as **parsed fields**, never as substrings of the file (ADR-051 rule 2 — `continue-on-error` is a sibling of `run:` and never appears in a shell line; both these files have already shipped that mistake once each). Both already parse the workflow; keep it that way.

**`docs/cli.md:181`** — the `npm run test:coverage` row now describes vitest alone; add rows for `coverage:manifest` and `coverage:gate` naming the exit-3 convention.

## Tests

The wiring tests above are the tests, and each edit is stated as a mutant it kills:

1. `if: success()` on the `Coverage floors` step → the literal-equality assertion fails. This is the exact regression under fix; a `toBeTruthy()` or a `toContain("cancelled")` check would pass `always()` and a `toBeDefined()` would pass `success()`.
2. `if: always()` → same assertion fails (a cancelled run must not manufacture a cannot-evaluate red).
3. `|| true` appended to `coverage:gate` in `package.json` → the exact-equality pin fails while `ci.yml` stays byte-identical. This is ADR-051 rule 1's whole reason and the only check that catches it.
4. The `Coverage floors` step deleted → the "a step runs `coverage:gate`" assertion fails.
5. `continue-on-error: true` on either new step → the parsed-field assertion fails (a substring check over the `run:` line would not).
6. `cross-env TANDEM_COVERAGE=1` copied onto `coverage:gate` → the existing `TANDEM_COVERAGE`-setters sweep fails.

Add one behavioural spec to `tests/scripts/coverage-gate-wiring.test.ts` alongside its existing temp-tree spec: with `coverage/coverage-summary.json` absent, the shipped `coverage:gate` **script name** resolves to a process that exits 3 and prints `[coverage-gate]`. The existing spec pins the `.mjs` path; this one pins that the npm script the workflow now calls reaches it, which is the new indirection the split introduces.

## Done when

Three steps in the `coverage` job; a vitest exit no longer prevents the gate from reporting; the two wiring tests pin the `if` literal and the three scripts by exact equality; `docs/cli.md` updated; `npm run typecheck:tests` and the suite green. The observable outcome: a run that flakes at teardown shows `Coverage baseline` red and `Coverage floors` green, and the reader needs no artifact download.

## Not in scope

**Part 1 of the issue — the `EnvironmentTeardownError` flake — is not fixed here, and the issue's own hypothesis is refuted.** The issue proposes stubbing `console` in `tests/client/useTauriTheme.svelte.test.ts`; the 2026-09-09 instance originated in `tests/server/snapshot-truncation-reload.test.ts`, a different file in the other project. Two distinct originating files means the class is `onUserConsoleLog` still in flight at environment teardown, not one noisy spec, so silencing one file buys nothing and would read as a fix. It gets its own issue at ship time rather than a "tracked separately" with no number. Also out: making `coverage` a required check (#1728 carries that decision, dated); any change to the floors, the policy, or `vitest.config.ts`.
