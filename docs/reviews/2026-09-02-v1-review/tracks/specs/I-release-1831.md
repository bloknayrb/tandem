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
for"). Deleting enables nothing and reverts in one commit; repairing enables something nobody asked
for.

**Why `Closes #1831` is defensible even though there is a For-Bryan item.** #1831's finding is
"this workflow is dead and would skip Dependabot PRs anyway". Deletion resolves that finding
**completely and in code** — there is no half of the issue left running. The For-Bryan item is
**new work, not a residual of #1831**: whether Tandem should have an automated PR reviewer at all
is a cost-and-policy choice about a capability the repo has never had, and turning an LLM loose to
comment on every PR is not something this PR may decide unilaterally. State it in the PR body's
For-Bryan list in exactly that framing, with the `CLAUDE_CODE_OAUTH_TOKEN` wiring named, and add
one sentence: **if Bryan wants it as work rather than a standing option, the ship stage files a
numbered issue for it before the PR merges.** Do not write "tracked separately" without a number,
and do not make the `Closes` contingent on his reply — the issue is resolved by the deletion
either way.

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
  **This edit is NOT test-forced and nothing will tell you if you skip it.** `:202-209` asserts
  `expect(ALLOWED_ACTIONS).toContain(owner)` — *containment*, not set equality — so a stale entry
  for an action no workflow uses changes no test outcome in either direction. It is a reviewed
  narrowing of the inventory, and "the tests are green" is not evidence it was done. Verified safe:
  after the deletion the only remaining tracked references to `claude-code-action` are
  `CONTRIBUTING.md:264` (rewritten in the next bullet) and archived plan/review docs.
- `CONTRIBUTING.md:262-265` — the sentence "Note also that `.github/workflows/claude-code-review.yml`
  skips PRs authored by a bot, so the automated reviewer never looks at these." becomes a statement
  that **there is no automated reviewer**, so the SHA provenance check above it is human-only. Do
  not simply delete the sentence: it exists to stop a reader assuming the bumps are covered, and
  that reason survives the workflow.

## Tests

**No new test.** One guard already exists and is load-bearing, and it is the *file-set* one only:
`workflow-action-pin.test.ts:152-157` pins the on-disk workflow set by **exact equality**
(`expect(found).toEqual([...WORKFLOW_FILES].sort())`), inside `check`. Editing that list in the
same commit *is* the review gate — a later re-add of an unpinned or unlisted workflow fails there.

**The `ALLOWED_ACTIONS` edit has no such anchor.** `:202-209` is a containment check, so removing
the entry is pinned by nothing and leaving it in is caught by nothing. Say that plainly in the PR
body rather than describing "both lists" as pinned.

**No experiment in `docs/reviews/2026-09-02-v1-review/experiments/` covers this issue**; there is
no still-broken-when output to convert into an assertion.

Discriminating check the implementer must actually run, because two failure shapes look identical
in a diff: `npx vitest run tests/scripts/workflow-action-pin.test.ts` must be green, and re-adding
the file locally (`git stash` the deletion) must turn it **red** — if it stays green the set
assertion is not doing what this spec claims and the deletion has no anchor. **This check exercises
the `WORKFLOW_FILES` half only**; it says nothing about `ALLOWED_ACTIONS`, which is why the bullet
above flags that edit as unguarded.

## Done when

Workflow deleted; both lists in `workflow-action-pin.test.ts` updated in the same commit (the
`ALLOWED_ACTIONS` one confirmed by reading the diff, since no test will report it);
`CONTRIBUTING.md` no longer describes a reviewer that does not exist; `npm test` green; the
PR body carries the measured evidence (eight failures, last run 2026-05-27, secret absent), states
that only the workflow-file set is test-pinned, and puts "should this repo have an automated PR
reviewer at all" to Bryan as **new work** with the `CLAUDE_CODE_OAUTH_TOKEN` wiring named — with a
numbered issue filed before merge if he wants it as work. `Closes #1831` stands regardless: the
deletion resolves the whole finding.

## Not in scope

Wiring any replacement automated review. Changing the Dependabot `github-actions` grouping (#1745
decided it stays ungrouped). Deleting `CLAUDE_CODE_OAUTH_TOKEN` from repo secrets — a secret
deletion is Bryan's, and leaving it costs nothing.

## Review corrections (round 1)

**Adopted.**

- **`Closes #1831` alongside a Bryan decision with no tracked home** (wave-6 rule 1 / rule 2). The
  split is now decided up front and stated in `## Fix`: deletion resolves #1831's finding
  completely in code, so `Closes` is defensible; the For-Bryan item is **new work** (should the
  repo have an automated PR reviewer at all), not a residual, and the filing is unconditional —
  a numbered issue before merge if Bryan wants it as work, never "say the word".
- **The `ALLOWED_ACTIONS` edit was presented as though a test forced it.** `:202-209` is
  `expect(ALLOWED_ACTIONS).toContain(owner)` — containment, not set equality — so the removal is
  pinned by nothing in either direction, and the spec's discriminating check exercises the
  `WORKFLOW_FILES` half alone. Both the Fix bullet and the Tests paragraph now say so, so the edit
  cannot be dropped as "the tests are green". (Two review findings raised this; both are addressed
  by the same rewrite.)
- **No experiment covers this issue** — stated in `## Tests`.

**Not adopted.** None.

**File set:** unchanged (`.github/workflows/claude-code-review.yml` deleted,
`tests/scripts/workflow-action-pin.test.ts`, `CONTRIBUTING.md`).
