# I-release — #1831 `claude-code-review.yml` has been dead since 2026-05-27 and would skip Dependabot PRs anyway

Branch `fix/release-and-ci-hygiene-1856` (one branch for the group). **Closes #1831.** Ledger:
`areas/ci-build.md` has no row — the finding was raised inside #1745's work and filed
separately (`tracks/I-supply-chain.md` §"Three exposures").
Probe: `gh run list --workflow=claude-code-review.yml`, `gh secret list`.

## Problem

Measured on 2026-09-10, not carried from the issue body:

- `gh run list --workflow=claude-code-review.yml --limit 8` — eight most recent runs, **every one
  `failure`**, the newest `2026-05-27T00:33:59Z`. Nothing has run in 3.5 months.
- `gh secret list` — **`ANTHROPIC_API_KEY` does not exist.** `claude-code-review.yml:36` passes
  `${{ secrets.ANTHROPIC_API_KEY }}`, which expands to the empty string. `CLAUDE_CODE_OAUTH_TOKEN`
  exists (created 2026-03-24) and is referenced by nothing in the repo.
- `:25` — `github.event.pull_request.user.type != 'Bot'` excludes every Dependabot PR, so even
  repaired it would not cover the human SHA check `CONTRIBUTING.md:255-265` relies on.

The cost is not the failed runs; it is that `.github/workflows/` advertises an automated reviewer
the repo does not have, and `CONTRIBUTING.md:264` writes a sentence about that reviewer's
behaviour as though it reviews anything.

## Fix

**Delete the workflow.** Decision recorded here rather than deferred, per the group's brief ("a
workflow that has not run in three months is a candidate for deletion, not for a fix nobody asked
for"); the keep-or-restore call is Bryan's and goes in the PR body's For-Bryan list with the
`CLAUDE_CODE_OAUTH_TOKEN` recipe, because turning an LLM loose to comment on every PR is a cost and
policy choice this PR must not make unilaterally. Deleting enables nothing and reverts in one
commit; repairing enables something nobody asked for.

Four files, and the last two are what make the deletion honest rather than a dangling reference:

- `rm .github/workflows/claude-code-review.yml`.
- `tests/scripts/workflow-action-pin.test.ts:49-55` — remove `"claude-code-review.yml"` from
  `WORKFLOW_FILES`. **This is required in the same commit**: `:152-157` asserts the on-disk `.yml`
  set equals that list, so the deletion turns `check` red until the list matches. That test is the
  ADR-051 anchor for the pin set and must keep failing closed on a *new* file.
- Same file, `:61-72` — remove `"anthropics/claude-code-action"` from `ALLOWED_ACTIONS`. Verified:
  that action appears in no other workflow (`grep -rn claude-code-action .github/`), and the list's
  own comment says editing it means adding or removing a dependency that runs with repository
  secrets — removing one is exactly that. `actions/checkout` stays; four other files use it.
- `CONTRIBUTING.md:262-265` — the sentence "Note also that `.github/workflows/claude-code-review.yml`
  skips PRs authored by a bot, so the automated reviewer never looks at these." becomes a statement
  that **there is no automated reviewer**, so the SHA provenance check above it is human-only. Do
  not simply delete the sentence: it exists to stop a reader assuming the bumps are covered, and
  that reason survives the workflow.

## Tests

**No new test.** The guard already exists and is load-bearing: `workflow-action-pin.test.ts:152-157`
pins the workflow-file set by exact equality and `:202-209` pins the action set, both inside
`check`. Editing those two lists in the same commit *is* the review gate — a later re-add of an
unpinned or unlisted workflow fails there.

Discriminating check the implementer must actually run, because two failure shapes look identical
in a diff: `npx vitest run tests/scripts/workflow-action-pin.test.ts` must be green, and re-adding
the file locally (`git stash` the deletion) must turn it **red** — if it stays green the set
assertion is not doing what this spec claims and the deletion has no anchor.

## Done when

Workflow deleted; both lists in `workflow-action-pin.test.ts` updated in the same commit;
`CONTRIBUTING.md` no longer describes a reviewer that does not exist; `npm test` green; the
PR body carries the measured evidence (eight failures, last run 2026-05-27, secret absent) and
puts restore-vs-stay-deleted to Bryan with the `CLAUDE_CODE_OAUTH_TOKEN` wiring named.

## Not in scope

Wiring any replacement automated review. Changing the Dependabot `github-actions` grouping (#1745
decided it stays ungrouped). Deleting `CLAUDE_CODE_OAUTH_TOKEN` from repo secrets — a secret
deletion is Bryan's, and leaving it costs nothing.
