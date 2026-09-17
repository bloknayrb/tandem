# CI-trust — #1673 A vitest run that loses files to worker starvation can exit 0: nothing anchors files-collected against files-run

Branch `fix/ci-reds-that-say-nothing-about-the-diff-under-test-1673`. Closes #1673. Track: `docs/reviews/2026-09-02-v1-review/tracks/K-tests-and-lows.md`. Probe: `npx vitest list --filesOnly --json=<path>` against `npx vitest run --reporter=json` — measured below.

## Problem

Vitest's summary counts what it **ran**. Nothing asserts that what it ran equals what it **collected**. A run that loses seven files to `[vitest-pool]: Failed to start forks worker` prints `580 passed (580)` where the healthy tree reports 587 — indistinguishable from a pass unless the reader knows the number by heart. The recorded instance exited 1, so silent-green is a shape rather than a reproduction; the hardening stands on its own, because **nothing in the tree compares the two lists** and the exit code of a starved run is a property of which files happened to be lost. This is the #1229 / #1399 / #1529 zero-of-zero shape.

## Fix

One new script and one new `check` step. Nothing about pool sizing, timeouts or `maxForks` — the issue names raising ceilings as explicitly not the fix.

**`scripts/ci/vitest-file-anchor.mjs`** (new). Modelled on `scripts/ci/coverage-gate.mjs`: a pure exported comparator plus a `main()` behind the `import.meta.url` guard.

- `export const EXIT_CANNOT_EVALUATE = 3;` — same convention and value as `coverage-gate.mjs`, so a run that could not evaluate is distinguishable from one that evaluated and refused.
- `export function compareFileSets({ expected, reported, repoRoot })` — pure, touches no filesystem, exits no process. `expected` is `vitest list --filesOnly --json`'s array (`{file, projectName}`); `reported` is the run report's `testResults` (`{name, status}`). Returns the same four keys on every path: `{ ok, cannotEvaluate, checked, failures }`, `failures` present and empty on success (the `coverage-gate.mjs` reason: an optional array reads as `T[] | undefined` at every call site and `expect(v.ok).toBe(false)` does not narrow it).
  - Compare **resolved absolute posix paths**: `path.resolve(repoRoot, String(p)).replace(/\\/g, "/")`. Measured on this tree (Node v24.2.0, vitest 4.1.11): both sides already emit absolute forward-slashed paths, so this is a guard against a future disagreement on either axis, not a live fix.
  - **`expected` is reduced to a `Set` of normalized paths first.** `vitest list` emits one entry per (file, project) pair while the run report carries no project, so a file collected twice would otherwise become a permanent false DID-NOT-RUN. Measured: 655 entries / 655 unique files, projects `client` and `node`, disjoint only because `vitest.config.ts:69` excludes `tests/client/**` from `node`. Say that in the comparator's header comment.
  - A file in `expected` with **no** entry in `reported` → `failures.push({ file, kind: "DID-NOT-RUN" })`.
  - The comparator **never reads `status`**. A file that is reported at all **ran** — the issue is explicit that a file which never started is not a skip. Measured: vitest's file-level enum is `passed | failed` only (a fully skipped file reports `passed`), so a status filter could only subtract from a presence test.
  - `expected` empty or not an array → `cannotEvaluate` ("zero collected" is the failure this exists to catch, never "nothing to check, therefore fine"). `reported` missing or not an array → `cannotEvaluate`.
- `main()`: reads the run report from `process.argv[2]`; obtains `expected` from `--expected=<path>` (a JSON file) or, absent that flag, by spawning `node node_modules/vitest/vitest.mjs list --filesOnly --json=<tmp>` — **not `npx`**, so a step in the required `check` job never depends on npx resolution — into a `mkdtempSync` directory. Measured: 2.46 s, 655 files. Prints every missing filename (the issue asks for names, not a count), then exits `0 / 1 / EXIT_CANNOT_EVALUATE`. The `--expected=` seam exists so the exit-code contract is testable without booting vitest.
  - **Every acquisition of `expected` fails closed to `EXIT_CANNOT_EVALUATE`, never to 1.** The `--expected=` read, the spawn, and the parse of either one's output are each wrapped so that an unreadable file, a non-zero spawn status, empty stdout or a `JSON.parse` throw prints a **named** reason (`[vitest-file-anchor] cannot read --expected …`, `… vitest list exited N`, `… cannot parse …`) and exits 3. An uncaught throw would exit **1**, the same code as "collected files did not run", destroying the distinction this whole spec exists to create. Precedent: `coverage-gate.mjs:233-247` wraps **both** its reads in `try/catch → process.exit(EXIT_CANNOT_EVALUATE)`. The same rule covers the run-report read at `process.argv[2]`.

**`.github/workflows/ci.yml`**, `check` job. The existing `Test` step gains reporter flags **on the same single line**, and one step is added after it:

```yaml
      - name: Test
        run: npm test -- --run --reporter=default --reporter=json --outputFile.json=.vitest-report.json

      # An exit-3 here after a SKIPPED `Test` step means an earlier step in this
      # job failed (npm ci, a lint, a typecheck) and vitest never ran — not that
      # files were lost. This step's last output line tells the two apart: a
      # named cannot-evaluate reason, versus a DID-NOT-RUN list.
      - name: Every collected test file actually ran
        if: ${{ !cancelled() }}
        run: node scripts/ci/vitest-file-anchor.mjs .vitest-report.json
```

**The `Test` step's `run` MUST stay a single line beginning with `npm test`.** `tests/scripts/acceptance-harness-wiring.test.ts:251-253` locates that step with `/^npm test\b/.test(s.run.trim())`, and its `stepIndex` helper (`:87-93`) **throws** rather than returning -1 when nothing matches — so a `run: |` block whose first line is anything else turns the required `check` job red for a reason unrelated to the diff. Do not relax that predicate either.

`--reporter=default` is kept so human-readable output survives; `--outputFile.json=` is the per-reporter form required with two reporters. Verified end to end on this tree: the report is written *and* the default output still prints. `if: ${{ !cancelled() }}` and not `always()` or `success()`: a run can both fail a test **and** lose files, so the anchor must survive a red `Test`, while `success()` would re-create the bug this group is about. No `continue-on-error`, no `|| true`.

**`.gitignore`**: add `.vitest-report.json` beside the existing `coverage/` block.

**`tests/scripts/vitest-file-anchor-wiring.test.ts`** (new) — the ADR-051 half, reinstated. Being *inside* a required job is not what makes a gate safe: `check` already holds two step-level gates pinned from inside itself, `typecheck:tests` (`tests/scripts/typecheck-tests-wiring.test.ts:128-155`) and the acceptance harness (`tests/scripts/acceptance-harness-wiring.test.ts:28`), and ADR-051 names the reason directly — "the acceptance harness's step carries no `if:`, no `continue-on-error` and no `|| true`, and … `check` fails when any of that changes". `run: … || true`, `continue-on-error: true`, `if: false`, or deleting the step outright each leave `check` **green** with the anchor dead. This step is strictly weaker than its two neighbours because it is the only one carrying an `if:` — an `if:` nothing constrains. Assert against the **parsed** `check` job (ADR-051 rule 2), four things and nothing else:

- **(a)** a step whose `run` includes `vitest-file-anchor` exists, and its `run.trim()` is **exactly** `node scripts/ci/vitest-file-anchor.mjs .vitest-report.json`. Exact equality, per `typecheck-tests-wiring.test.ts:137`: it subsumes the whole exit-code-masking family — `|| true`, `; true`, `|| echo …`, `set +e &&`, a trailing pipe — which a denylist covers only partly.
- **(b)** its parsed `if` is **exactly** the string `${{ !cancelled() }}`. Literal equality, so `success()` (the bug this group is about, re-created) and `always()` both fail. ADR-051 rule 4: assert presence, never `step.if ?? "…"`.
- **(c)** its parsed `continue-on-error` is falsy, and its `shell` is undefined.
- **(d)** the `Test` step's `run.trim()` by **exact** equality — `npm test -- --run --reporter=default --reporter=json --outputFile.json=.vitest-report.json`. This is the correct repair for the round-2 `toContain` finding, and it keeps `acceptance-harness-wiring.test.ts`'s `/^npm test\b/` satisfied by construction. Without it the reporter flags can be dropped: the anchor then exits 3, which is loud, but the same edit that drops them can delete this step.

Per ADR-051 rule 5, **name the owner in a comment and assert only the delta**: `acceptance-harness-wiring.test.ts:251-253` owns the `Test` step's *ordering* against `setup-python` and matches it with `/^npm test\b/`; this file owns that step's *exact command* and the anchor step. Do not re-assert ordering here, and do not relax that predicate there.

## Tests

`tests/scripts/vitest-file-anchor.test.ts`, importing `compareFileSets` and `EXIT_CANNOT_EVALUATE` (the `coverage-gate.test.ts` pattern — synthetic inputs, no CI involved):

1. **Equal counts, different names** (one file lost, one unexpected extra) → `ok:false`, the lost name in `failures`. Kills the naive `expected.length === reported.length`, which passes the starvation case whenever a file is added in the same run.
2. **One collected file absent from the report** → `ok:false`, `kind: "DID-NOT-RUN"`, message contains the filename. Kills a count-only anchor.
3. **`expected: []`** → `cannotEvaluate:true`, `ok:false`; and **`reported` not an array** → `cannotEvaluate:true`. Kills "nothing collected, therefore fine" and a comparator that treats a missing report as an empty one.
4. **Normalization**: the same file spelled absolute-with-`/` in `expected` and relative-with-`\` in `reported` → `ok:true`; two genuinely different files → `ok:false`. Also **one file listed twice in `expected` under two `projectName`s, reported once** → `ok:true` (kills the missing `Set` reduction).
5. **CLI exit codes, subprocess** (`spawnSync(process.execPath, [script, report, "--expected=" + p])` over temp fixtures), five arms: complete pair → 0; one missing file → 1; a report path that does not exist → 3; `--expected=` at a nonexistent path → 3; `--expected=` at a file containing `not json` → 3. Without these, `main()`'s arms are covered by nothing and `process.exit(3) → process.exit(0)` survives the file.

6. **The wiring block**, four assertions as specified above, each stated as the mutant it kills: `|| true` on the anchor step's `run` (killed by (a)'s exact equality — nothing else sees it, `check` stays green); `if: success()` or `if: always()` (killed by (b)'s literal equality — `toBeDefined()` passes `success()` and `toBeTruthy()` passes `always()`); `continue-on-error: true` or a non-default `shell` (killed by (c)); the reporter flags dropped from the `Test` step (killed by (d)).

## Done when

`compareFileSets` refuses a collected-but-unrun file by name; the six cases pass; the `check` job runs the anchor after `Test` with `if: ${{ !cancelled() }}`; **`tests/scripts/vitest-file-anchor-wiring.test.ts` pins that step's `run`, `if`, `continue-on-error` and `shell` plus the `Test` step's `run`, all by exact/literal equality**; `tests/scripts/acceptance-harness-wiring.test.ts` is still green; a hand-edited report with one entry deleted turns the anchor red locally; `npm run typecheck:tests` and the suite green.

**A green dry run against a real full-suite report is owed before merge.** Run `npm test -- --run --reporter=default --reporter=json --outputFile.json=.vitest-report.json`, then `node scripts/ci/vitest-file-anchor.mjs .vitest-report.json`, and record exit 0 plus the counts in the PR body. Reconcile the numbers there: `vitest list` collects **655**, `CI-trust-1862.md` records **652 files passed** from the same tree, and 652 + **3 fully-skipped files** = 655 — a fully-skipped file *is* present in `testResults` with file-level status `passed`. So 655/655 is green and 652 is a different count, not a discrepancy.

**One measurement is owed**, because the load-bearing premise is asserted nowhere: kill a forks worker mid-run (a scratch spec calling `process.exit(1)` under `--pool=forks --poolOptions.forks.maxForks=1`) and record whether the co-resident files appear in `testResults`. The premise is that a starved file is **absent**. If it instead appears as `failed`, presence is not a proxy for having run — record that in the PR body and say so on the issue; do not widen the comparator on this branch.

## Files touched

`scripts/ci/vitest-file-anchor.mjs` (new), `tests/scripts/vitest-file-anchor.test.ts` (new), `tests/scripts/vitest-file-anchor-wiring.test.ts` (new), `.github/workflows/ci.yml`, `.gitignore`.

## Not in scope

The pre-push hook (the anchor is CI-only). `maxForks` / pool sizing — the issue calls it a partial mitigation and explicitly not a substitute. Any change to `vitest.config.ts`. Relaxing `acceptance-harness-wiring.test.ts`'s `/^npm test\b/` predicate.

## Review corrections (scope cut)

The round-1 and round-2 correction logs are dropped as superseded; what they settled is folded into the sections above. Removed in this pass:

- **`tests/scripts/vitest-file-anchor-wiring.test.ts`** — a new ADR-051 wiring test pinning the anchor step's `run`, `if`, `continue-on-error`, `shell` and index, plus an exact-equality pin on the `Test` step. ADR-051's pattern exists because `coverage` is **advisory**; this anchor lives inside `check`, which is a required status check, so its own red already blocks and a second file pinning it is a gate the issue did not ask for. Removing it moots the round-2 finding that the wiring test's `toContain` on the reporter flag was defeatable, and the ADR-051 rule-5 finding about re-locating the `Test` step. The single constraint that has to survive — the `Test` step staying a single `npm test …` line — is stated in the Fix section, and `acceptance-harness-wiring.test.ts` already fails loudly if it is broken.
- **The `Clear stale vitest report` step.** In CI `actions/checkout` gives a fresh tree, so it was a no-op there by construction; it existed for local invocation, where the caller passes the report path explicitly. One fewer YAML step, and the anchor's cannot-evaluate arm still covers a missing report.
- **The conditional "second comparator rule"** (an `expected` file whose `reported` entry has zero `assertionResults` alongside a pool-level error counts as DID-NOT-RUN), pre-specified with its own two cases in case the starvation measurement came back the other way. Designing a branch for a measurement not yet taken is scope the issue does not carry; the measurement is still owed, and its result is recorded rather than pre-implemented.
- **Test cases 3, 6, 7, 8** as separate items — the status-regression guard is folded into the comparator's stated contract, and the normalization and dedupe cases are merged into one case each. Nine cases became five with no verdict left undriven.

Fixed directly rather than removed: the round-2 finding that `main()`'s acquisition of `expected` had no failure contract and would exit **1** on an unreadable or malformed `--expected=` file. That is the spec's own thesis broken by its own script, so the acquisition bullet now requires a named reason and exit 3 on every acquisition path, and case 5 drives both arms.

## Review corrections (post-cut)

One finding, reported twice from two angles, adopted directly.

- **`tests/scripts/vitest-file-anchor-wiring.test.ts` is reinstated.** The scope cut removed it on the argument that "ADR-051's pattern exists because `coverage` is advisory; this anchor lives inside `check`, which is a required status check, so its own red already blocks". That premise is refuted by ADR-051's own instances table (`docs/decisions.md:1925`): `typecheck:tests` is a **step inside the required `check` job** and is pinned by `typecheck-tests-wiring.test.ts`, and so is the acceptance-harness step. Being required makes a *red* block; it does nothing about a step that never runs. `|| true` on the `run` line, `continue-on-error: true`, `if: success()`, or deleting the step each leave `check` green with the anchor dead — the #1229 shape this whole group is about, re-created by the group's own PR. This step is the weakest of the three neighbours precisely because it is the only one carrying an `if:`, and the cut left that `if:` pinned by nothing.
- The reinstated block is deliberately minimal — four assertions, stated in the Fix section as (a)–(d) and driven as test case 6. **(d)**, the exact-equality pin on the `Test` step's `run`, is also the correct repair for the round-2 finding that a `toContain` on the reporter flag was defeatable; the cut resolved that finding by deletion instead, which removed the check rather than strengthening it. Per ADR-051 rule 5 the comment names `acceptance-harness-wiring.test.ts:251-253` as the owner of that step's *ordering* and asserts only the delta — the exact command — so the two files cannot drift into disagreeing.
- Unchanged by this pass: the comparator contract, the acquisition fail-closed rule, the `if: ${{ !cancelled() }}` choice, the owed starvation measurement, and everything in **Not in scope**.
