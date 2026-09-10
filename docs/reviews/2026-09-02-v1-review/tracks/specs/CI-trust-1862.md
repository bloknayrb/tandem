# CI-trust — #1862 coverage job: a red reads as a floor breach when vitest can flake before the gate ever runs

Branch `fix/ci-reds-that-say-nothing-about-the-diff-under-test-1673`. **`Refs #1862`, not `Closes` — #1862 stays open.** This PR fixes part 2 (the part the issue itself calls "the part that matters more"); part 1 is refuted as stated and is left tracked on #1862 itself with a comment, following this sweep's own Decision B precedent rather than filing a new issue — see Not in scope. **This changes the group contract's `closes: #1862` to `refs`.** Track: `docs/reviews/2026-09-02-v1-review/tracks/K-tests-and-lows.md`. Probe: run `node scripts/ci/coverage-gate.mjs` from a temp tree with `coverage/` absent and read its exit code.

## Problem

`package.json:56` — `"test:coverage": "cross-env TANDEM_COVERAGE=1 vitest run --coverage … && node scripts/ci/coverage-manifest.mjs && node scripts/ci/coverage-gate.mjs"` — is one `&&` chain behind one CI step (`ci.yml:240-242`, `run: npm run test:coverage`). **Any** vitest exit short-circuits the chain, so the manifest and the gate never execute, and the job reports the identical red it reports for a genuine floor breach.

Measured 2026-09-09 on PR #1930, a docs-only diff: vitest exited 1 with 652 files passed / 0 failed and one `EnvironmentTeardownError` (`Closing rpc while "onUserConsoleLog" was pending`, originating in `tests/server/snapshot-truncation-reload.test.ts`). No floor was breached; no floor was **evaluated**. Establishing that took reading a whole log for a verdict line that was absent, then downloading the `if: always()` artifact to find `coverage-summary.json` present and `baseline-manifest.json` absent.

The gate already knows how to say this. `coverage-gate.mjs` exports `EXIT_CANNOT_EVALUATE = 3`, prints `The gate could not evaluate. This is not a pass.`, and `coverage-gate-wiring.test.ts` pins exit 3 against a missing summary. **The bug is not that the gate cannot report "I could not evaluate" — it is that the gate is never reached to say it.**

**But the `&&` chain is doing a second job, and round 1 caught the fix destroying it.** Today the chain is also what stops the gate judging a measurement nobody vouched for: a vitest exit or a manifest refusal both prevent the gate from running at all. Decouple the steps naively — `if: ${{ !cancelled() }}` on both, no change to `coverage-gate.mjs` — and a run that *loses test files* (exactly #1673's premise, the sibling issue in this same group) still writes `coverage/coverage-summary.json`; `coverage-manifest.mjs` refuses it and exits 1, and the gate then evaluates it anyway. Under `coverage.include: ["src/**/*.ts", "src/**/*.svelte"]` an unexercised module reports **0%**, so the gate emits specific per-module floor breaches — a red that reads as a precise finding about the diff. That is strictly worse than today: the case is currently ambiguous, and the naive fix makes it actively misleading. `coverage-manifest.mjs`'s own refusals are family/area-level (zero statements measured, a family with no files, an area uniformly zero), so it catches the total wipeout and not the loss of a handful of files.

So the fix has two halves: **run the gate whatever vitest did**, and **never let it reach exit 1 on a measurement that did not complete or that the manifest refused.** That second phrasing is deliberately narrower than "not vouched for", and the difference matters: a vitest run that exits **0** having silently lost a handful of files gives `outcome == success` (arm 1 passes) and a manifest the family/area checks accept (arm 2 passes), so the gate grades it and can emit per-module floor breaches. **That case is not covered here** — it is the vitest file anchor in `check` (#1673, the sibling spec in this group), because catching it requires comparing files-collected against files-run, which nothing in the `coverage` job can do.

## Fix

Split the chain into three named steps, and make the gate fail closed on an incomplete or refused measurement.

**`package.json`** — three scripts where there was one. The vitest half keeps its flags byte-for-byte:

- `"test:coverage": "cross-env TANDEM_COVERAGE=1 vitest run --coverage --coverage.reporter=text --coverage.reporter=json-summary --coverage.reporter=html --testTimeout=120000 --hookTimeout=300000"`
- `"coverage:manifest": "node scripts/ci/coverage-manifest.mjs"`
- `"coverage:gate": "node scripts/ci/coverage-gate.mjs"`

**`.github/workflows/ci.yml`**, `coverage` job:

```yaml
      # Arm 2 of the gate reads the ABSENCE of coverage/baseline-manifest.json
      # as the manifest's refusal. `coverage-manifest.mjs` never unlinks, so a
      # stale one from a previous run would satisfy that check on a measurement
      # nobody vouched for. Fresh checkout makes this a no-op in CI; it is the
      # local invocation the line is for — the same reasoning as the sibling
      # spec's `Clear stale vitest report` step (#1673).
      - name: Clear stale coverage manifest
        run: rm -f coverage/baseline-manifest.json

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

`${{ !cancelled() }}`, never `always()` and never `success()`. `success()` is the present behaviour written as YAML — the whole bug. `always()` would also run the gate on a cancelled job, producing a cannot-evaluate red for a run nobody asked to finish. Both later steps stay blocking: no `continue-on-error`, no `|| true`.

**`Upload coverage baseline` stays LAST**, after `Coverage floors`. It is `if: always()` and its `path:` names `coverage/baseline-manifest.json`; the manifest used to be produced inside the `Coverage baseline` step's `&&` chain, and appending the two new steps after the upload would publish an artifact missing the very file that made the 2026-09-09 diagnosis possible.

**`scripts/ci/coverage-gate.mjs` — two new fail-closed arms.** The earlier draft's "no change to `coverage-gate.mjs`" prohibition is lifted for exactly these, and nothing else. Both exit `EXIT_CANNOT_EVALUATE` (3) — never 1.

**Their placement in `main()` is literal and load-bearing.** The order is: read `coverage-policy.json` (`:233-238`), then read `coverage/coverage-summary.json` (`:240-247`) — both keeping their existing cannot-evaluate messages byte-for-byte — **then** arm 1, **then** arm 2, **then** the `evaluateGate` call at `:249`. Both new arms therefore sit immediately above `evaluateGate` and **after** the summary read, not before it. This order is what keeps `tests/scripts/coverage-gate-wiring.test.ts:357` true: that spec ("exits 3, not 0, when it cannot find a coverage report to judge", `:334-360`) drives the script from a `mkdtempSync` tree holding only `coverage-gate.mjs` + `coverage-policy.json`, so `coverage/baseline-manifest.json` is absent there **too**, and it asserts the *specific* message `cannot read coverage/coverage-summary.json` alongside `status === 3`. Put arm 2 first and that spec goes red on `no baseline manifest` — inside the **required** `check` job, for a reason unrelated to the diff, which is the exact class this group removes. **Do not reorder, and do not relax that assertion to a bare `toContain("[coverage-gate]")`**: its own comment records that `process.exit(EXIT_CANNOT_EVALUATE) → process.exit(0)` survived every other spec in both files, so that message assertion is the only thing pinning that exit, and loosening it is the #1229 shape one level down.

1. **The measurement must have completed.** If `process.env.TANDEM_MEASUREMENT_OUTCOME` is set and is not `"success"`, print `[coverage-gate] the measurement did not complete (outcome: <v>); this is not a pass` and exit 3. **Absent** is not a failure: a local `npm run coverage:gate` sets nothing and must keep taking the normal path. That makes the env line a gate whose deletion disarms it, which is why the wiring test pins its value by exact equality.
2. **The manifest must have accepted the measurement.** If `coverage/baseline-manifest.json` does not exist, print `[coverage-gate] no baseline manifest: the measurement was refused as partial (or coverage:manifest has not run since it)` and exit 3. `coverage-manifest.mjs` writes that file **only** on acceptance (`OUT` at `:47`, and every refusal path goes through `die()` → `process.exit(1)` at `:525` without writing), so its absence is the manifest's refusal carried forward — the ordering guarantee the `&&` used to provide, restated as a precondition the gate checks for itself. **`coverage-manifest.mjs` never unlinks a previous manifest**, so absence is a sound proxy for refusal only on a tree where no manifest survives from an earlier run: CI is safe by fresh checkout plus the `Clear stale coverage manifest` step above, and locally a stale one can mask a refusal. The message's parenthetical is what tells a local reader which of the two they are in.

No change to **`coverage-manifest.mjs`'s refusal logic** or to `coverage-policy.json`. (One unrelated edit to `coverage-manifest.mjs` does land on this branch — adding `tests/server/search-worker.test.ts` to `SUSPENDED_TIMING_SITES` at `:121-125`. That belongs to **#1933** in this group, not here, and touches no refusal path.) Adding a v8-ignore hint anywhere here is forbidden (CLAUDE.md, Testing & E2E), as is `|| true`.

**The job comment block above `coverage:` (`ci.yml:183-227`)** must be updated where it says the chain runs as one step, and must state the outcome as the **three-way** thing it is. The earlier draft's wording — *"a red `Coverage floors` step means the gate evaluated"* — is false in two directions and is itself the defect this group fixes: exit 3 is also a red, and with `!cancelled()` the step runs even after `npm ci` fails. Write it as:

> A red `Coverage floors` means the gate **ran** — read its last line. `[coverage-gate] N failure(s).` is a real floor breach on a measurement that completed and was accepted. `The gate could not evaluate. This is not a pass.` is a measurement that did not happen; read `Coverage baseline` and `Coverage manifest` above it. A red `Coverage baseline` with a **green** `Coverage floors` cannot occur under the two fail-closed arms — that combination would mean the gate judged a measurement nobody vouched for. What is NOT covered here: a measurement that exited 0 but silently lost test files still grades as a real floor breach — that is the vitest file anchor in `check` (#1673), not this job.

**`docs/cli.md:181`** — the `npm run test:coverage` row now describes vitest alone; add rows for `coverage:manifest` and `coverage:gate`. **The three rows must state the ORDER as a precondition** — `test:coverage` → `coverage:manifest` → `coverage:gate` — and the `coverage:gate` row must say it exits 3 with `no baseline manifest` if `coverage:manifest` has not run since the last measurement. Today `docs/cli.md:181` documents `test:coverage` as one command that does all three, so a reader who splits it and types only the first and third gets an exit-3 red on a perfectly good measurement; no spec exercises that order (test 10's fixture always plants a manifest), so the docs row is the only thing that prevents it. **The exit-3 convention belongs to the `coverage:gate` row only**: `coverage-manifest.mjs` exits **1** on every refusal (`process.exit(1)` at `:525` is its only exit call, and `EXIT_CANNOT_EVALUATE` appears nowhere in the file), so its row says it exits 1 when it refuses to publish a manifest and names the three refusals its header lists.

**ADR-051 half.** `coverage` is advisory and not a required status check (#1728, dated), so the guarantee this fix adds — *the gate runs even when the measurement is red, and refuses to grade it when it should not* — is disarmable by editing one YAML line and must be pinned from inside `check`. Both existing wiring tests currently pin the old shape and will fail; updating them **is** the ADR-051 work, not extra scope:

- `tests/scripts/coverage-gate-wiring.test.ts:280-308`. Its `toBe(...)` exact-equality pin on `test:coverage` (ADR-051 rule 1 — never `toContain`, because `|| true` leaves `ci.yml` byte-identical) becomes three exact-equality pins, one per script. Its "the job and the measurement step carry no `if:`" assertion keeps the measurement half and gains: the step whose `run` includes `coverage:gate` exists, its parsed `if` is **exactly** the string `${{ !cancelled() }}`, its `continue-on-error` is falsy, and its parsed `env.TANDEM_MEASUREMENT_OUTCOME` is **exactly** `${{ steps.baseline.outcome }}` against a `Coverage baseline` step whose `id` is exactly `baseline`. Pin the `if` by literal equality, not by "is truthy" or "contains cancelled" — `success()` and `always()` must both fail it, and only a literal does that.
- `tests/scripts/coverage-manifest-wiring.test.ts:123-131`. Its three substring assertions over `test:coverage` (`toContain("&& node scripts/ci/coverage-manifest.mjs")`, `not.toContain("|| …")`, `not.toContain("; …")`) were checking that a chain could not be weakened; there is no chain now. Replace with an exact-equality pin on `coverage:manifest` plus the same step-shape assertions against the `Coverage manifest` step, **and an ordering assertion that the upload step's index is greater than the `Coverage floors` step's** (this file already locates the upload step at `:316`). Its `TANDEM_COVERAGE` sweep (`:213-222`) asserts the variable is set **only** by `test:coverage` — that still holds, and must keep holding: do not move `cross-env TANDEM_COVERAGE=1` onto the new scripts. The new variable is named `TANDEM_MEASUREMENT_OUTCOME`, not `TANDEM_COVERAGE_MEASUREMENT_OUTCOME`, **so that it cannot collide with that sweep by construction** rather than by reading its regex correctly: the matcher is `/TANDEM_COVERAGE\s*[=:]/` (`:210`), which a `TANDEM_COVERAGE_*` name would escape only because `_` is neither whitespace nor `[=:]` — a one-character dependency on someone else's test, and not worth taking.
- Read YAML attributes as **parsed fields**, never as substrings of the file (ADR-051 rule 2 — `continue-on-error` and `env` are siblings of `run:` and never appear in a shell line; both these files have already shipped that mistake once each). Both already parse the workflow; keep it that way.

## Tests

The wiring tests above are most of the tests, and each edit is stated as a mutant it kills:

1. `if: success()` on the `Coverage floors` step → the literal-equality assertion fails. This is the exact regression under fix; a `toBeTruthy()` or a `toContain("cancelled")` check would pass `always()` and a `toBeDefined()` would pass `success()`.
2. `if: always()` → same assertion fails (a cancelled run must not manufacture a cannot-evaluate red).
3. `|| true` appended to `coverage:gate` in `package.json` → the exact-equality pin fails while `ci.yml` stays byte-identical. This is ADR-051 rule 1's whole reason and the only check that catches it.
4. The `Coverage floors` step deleted → the "a step runs `coverage:gate`" assertion fails.
5. `continue-on-error: true` on either new step → the parsed-field assertion fails (a substring check over the `run:` line would not).
6. The `env:` block or the `id: baseline` deleted → the parsed-field assertions fail. Without them the gate silently loses arm 1 and starts grading incomplete measurements again, with no other symptom.
7. `Upload coverage baseline` moved above `Coverage floors` → the ordering assertion fails, and the artifact would otherwise lose `baseline-manifest.json`.
7b. `Clear stale coverage manifest` deleted → no test catches it, and that is stated rather than pinned: in CI the fresh checkout makes the step redundant, so a wiring assertion on it would pin a line whose absence changes nothing there. Its value is local, and the gate's own message carries the local caveat instead.
8. `cross-env TANDEM_COVERAGE=1` copied onto `coverage:gate` → the existing `TANDEM_COVERAGE`-setters sweep fails.

Two behavioural specs in `tests/scripts/coverage-gate.test.ts` (or alongside the existing temp-tree spec in `coverage-gate-wiring.test.ts`, whichever owns the spawned-script fixtures), both driven the way the existing exit-3 spec is — **by copying `coverage-gate.mjs` and `coverage-policy.json` into a `mkdtempSync` tree so `repoRoot` resolves there**, since `main()` resolves `repoRoot` from the script's own directory (`:229-230`):

9. Summary present, `baseline-manifest.json` absent → exit **3**, output contains `no baseline manifest`. Kills arm 2's removal, which is the regression that would let a partial run land as a floor breach.
10. Summary present, manifest present, `TANDEM_MEASUREMENT_OUTCOME=failure` → exit **3**, output names the outcome. With the same fixture and the variable **unset** → not 3 (the local path still works). Kills both an arm-1 removal and an over-eager arm 1 that breaks every local `npm run coverage:gate`.

**Not a spec: "the shipped `coverage:gate` script name resolves to a process that exits 3."** Round 1 refuted it three times and the refutation holds against the source: `coverage-gate.mjs` resolves `repoRoot` from its own directory (`:229-230`) and reads `coverage/coverage-summary.json` beneath it (`:242`); `coverage/` is gitignored (`.gitignore:123`) and persists locally, so on any machine that has ever run `test:coverage` — and in the `coverage` job itself — the shipped script takes the pass/fail path and exits 0 or 1. The existing sibling spec says exactly this in its own comment (`coverage-gate-wiring.test.ts:334-341`) and works around it with the temp tree, which an npm *script name* cannot use without also planting a `package.json` there; and `spawnSync("npm", …)` needs `shell: true` or `npm.cmd` on Windows, where the pre-push hook runs the full suite. As written the spec would be flaky or vacuous — a CI red that says nothing about the diff, one level down. **What the new indirection actually adds is pinned textually instead**, which is all it needs: `expect(pkg.scripts["coverage:gate"]).toBe("node scripts/ci/coverage-gate.mjs")` by exact equality (already required above) plus `existsSync` on that path. The exit-3 proof stays where it already lives, on the temp-tree copy of the `.mjs`.

## Done when

The stale-manifest clear plus three steps in the `coverage` job, the upload last; a vitest exit no longer prevents the gate from reporting; **`tests/scripts/coverage-gate-wiring.test.ts:357`'s `cannot read coverage/coverage-summary.json` assertion is still byte-identical and green** (the two new arms sit after the summary read, and that assertion must not be relaxed to accommodate them); the gate cannot reach exit 1 on a measurement that did not complete or that the manifest refused; the two wiring tests pin the `if` literal, the `env` passthrough, the `id`, the step ordering and the three scripts by exact equality; the two new gate arms are pinned by temp-tree specs; `docs/cli.md` updated with the exit conventions attributed to the right script; `npm run typecheck:tests` and the suite green. The observable outcome: a run that flakes at teardown shows `Coverage baseline` red and `Coverage floors` red **with `The gate could not evaluate. This is not a pass.` as its last line**, and the reader needs no artifact download to tell that apart from a floor breach.

## Files touched

`package.json`, `.github/workflows/ci.yml`, `scripts/ci/coverage-gate.mjs` (added in round 1 — the two fail-closed arms), `tests/scripts/coverage-gate-wiring.test.ts`, `tests/scripts/coverage-manifest-wiring.test.ts`, `tests/scripts/coverage-gate.test.ts` (the two new behavioural specs), `docs/cli.md`.

## Not in scope

**Part 1 of the issue — the `EnvironmentTeardownError` flake — is not fixed here, and the issue's own hypothesis is refuted.** The issue proposes stubbing `console` in `tests/client/useTauriTheme.svelte.test.ts`; the 2026-09-09 instance originated in `tests/server/snapshot-truncation-reload.test.ts`, a different file in the other project. Two distinct originating files means the class is `onUserConsoleLog` still in flight at environment teardown, not one noisy spec, so silencing one file buys nothing and would read as a fix.

**No new issue is filed. This PR says `Refs #1862` and #1862 stays open**, with a comment listing what part 2 landed and stating the refutation by name (the two originating files). That is this sweep's own precedent for the same shape — Decision B in `docs/plans/2026-09-06-open-issues-sweep.md:24` chose "no new issue, the existing one stays open with a comment" — and it is what CLAUDE.md's two-person rule points at: an open issue with an accurate comment tracks the remaining work, while a second issue splits it. The earlier draft made filing a **precondition** of opening this PR; that is inverted. Filing a separate issue remains available if part 1 is later scoped as its own work, but it is an option, not a gate on this PR. What is **not** acceptable is closing #1862 while part 1 stands — "gets its own issue at ship time" with no number is the untracked-deferral shape that has already produced work nobody was on.

Also out: making `coverage` a required check (#1728 carries that decision, dated); any change to the floors, the policy, `coverage-manifest.mjs`, or `vitest.config.ts`.

## Review corrections (round 1)

**Adopted**

- *Running `coverage:gate` unconditionally after a failed measurement makes an INCOMPLETE measurement produce a red shaped exactly like a floor breach* (blocking), and its sibling *the split silently removes the `&&`'s anti-partial-run ordering guarantee, so the gate evaluates a summary the manifest refused* (blocking). Both adopted together, and they are the largest change in this revision: the "No change to `coverage-gate.mjs`" prohibition is lifted for two new fail-closed arms — a measurement-outcome env passthrough (`id: baseline` → `TANDEM_MEASUREMENT_OUTCOME`) and a required `coverage/baseline-manifest.json` — both exiting 3, never 1, both pinned by parsed-field wiring assertions and by temp-tree behavioural specs. Verified against the source: `coverage-manifest.mjs` writes `OUT` only on acceptance (`:47`) and every refusal exits 1 (`:525`), so the file's absence is a sound proxy for refusal.
- *The behavioural spec "the shipped `coverage:gate` script name resolves to a process that exits 3" cannot hold and would be a false red* (blocking, raised three times). Adopted fix (a): the spawn is dropped, the indirection is pinned by exact equality on the package.json script plus `existsSync`, and the exit-3 proof stays on the temp-tree copy. The refutation is written into the Tests section so it is not re-proposed. This also moots the Windows `spawnSync("npm", …)` ENOENT finding — adopted by removal.
- *The ci.yml invariant "a red `Coverage floors` means the gate evaluated" is false* (raised twice). Adopted: replaced with the three-way wording, which also drops the now-impossible "red baseline + green floors" claim, since arms 1 and 2 make that combination mean the gate graded something nobody vouched for.
- *`docs/cli.md` must not attribute the exit-3 convention to `coverage:manifest`.* Adopted, verified: `process.exit(1)` at `:525` is that script's only exit call and `EXIT_CANNOT_EVALUATE` appears nowhere in it.
- *The spec never says where the new steps sit relative to `Upload coverage baseline`.* Adopted: the upload stays last, stated in the Fix section, and pinned by an index-ordering assertion in `coverage-manifest-wiring.test.ts` (mutant 7).
- *Closing #1862 while not fixing part 1 needs the part-1 issue filed first.* Adopted: filing before the PR opens is now a stated precondition, with the downgrade to `Refs #1862` named as the alternative.

**Not adopted**

- None. Every round-1 finding on this spec was adopted; the two npm-spawn findings were resolved by removing the spawn rather than by hardening it.

## Review corrections (round 2)

**Adopted**

- *The two new arms are placed only "before `evaluateGate`"; arm 2 running before the summary read breaks `tests/scripts/coverage-gate-wiring.test.ts:334-360` inside the required `check` job, and the likely repair relaxes the one assertion pinning that `process.exit(EXIT_CANNOT_EVALUATE)`* (blocking, raised twice). Adopted: the Fix section now states the order literally — policy read (`:233-238`) → summary read (`:240-247`) → arm 1 → arm 2 → `evaluateGate` (`:249`) — with the reason, and **Done when** requires `:357`'s `cannot read coverage/coverage-summary.json` assertion to stay byte-identical and green. Verified in the tree: that spec's temp tree holds only `coverage-gate.mjs` + `coverage-policy.json`, so the baseline manifest is absent there too.
- *Arm 2 reads absence as refusal, but nothing deletes a stale manifest — `coverage-manifest.mjs` writes `OUT` only on acceptance and every refusal exits via `die()` without unlinking* (non-blocking). Adopted both halves: a `Clear stale coverage manifest` step (`rm -f coverage/baseline-manifest.json`) before `Coverage baseline`, matching the sibling spec's reasoning for its own clear step, **and** the local caveat written into arm 2's message and its Fix paragraph. Mutant 7b states why the step itself is not wiring-pinned.
- *#1862's "no change to `coverage-manifest.mjs`" prohibition collides with #1933's `SUSPENDED_TIMING_SITES` edit on the same branch* (non-blocking). Adopted: the prohibition is narrowed to the file's **refusal logic** plus `coverage-policy.json`, and the `SUSPENDED_TIMING_SITES` edit is named as belonging to #1933.
- *The stated guarantee ("never let it reach exit 1 on a measurement that was not vouched for") is broader than the two arms deliver, and contradicts the spec's own narrower Done-when* (non-blocking). Adopted: the Problem section now uses the Done-when's phrasing, and both it and the required ci.yml comment block state that a run which exited 0 having silently lost files is **not** covered here — that is #1673's anchor in `check`.
- *After the split, `test:coverage` then `coverage:gate` produces exit 3 on a good measurement, and no spec exercises the order a human will type* (non-blocking). Adopted: the `docs/cli.md` rows must state the order as a precondition and say the gate exits 3 when `coverage:manifest` has not run since the measurement; arm 2's message carries the same parenthetical.
- *Requiring a brand-new issue for part 1 before the PR opens cuts against CLAUDE.md's two-person rule and against this sweep's Decision B precedent* (non-blocking). Adopted, and it changes the PR's own wording: this spec is now `Refs #1862` with #1862 staying open and carrying a comment, rather than `Closes`. **The group contract's `closes: #1862` becomes `refs: #1862` — main should carry that through to the PR body.**

**Not adopted**

- None. Every round-2 finding on this spec was adopted.
