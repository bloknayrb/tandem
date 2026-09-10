# I-release — #1831 `claude-code-review.yml` has been dead since 2026-05-27 and would skip Dependabot PRs anyway

Branch `fix/release-and-ci-hygiene-1856`. **REFS, NOT CLOSES — #1831 stays open**, because the act
the issue asks for (delete the workflow) is a policy decision the group brief and the ledger both
assign to Bryan. Track home: `tracks/I-supply-chain.md` §"Three exposures" (no `areas/ci-build.md`
row — the finding was raised inside #1745's work and filed separately).
Probe: `gh run list --workflow=claude-code-review.yml`, `gh secret list`.

## Problem — measured 2026-09-10, not carried from the issue body

- `gh run list --workflow=claude-code-review.yml --limit 8` — eight most recent runs, **every one
  `failure`**, newest `2026-05-27T00:33:59Z`. Nothing has run in 3.5 months.
- `gh secret list` — **`ANTHROPIC_API_KEY` does not exist.** `claude-code-review.yml:36` passes
  `${{ secrets.ANTHROPIC_API_KEY }}`, which expands to the empty string. `CLAUDE_CODE_OAUTH_TOKEN`
  exists (2026-03-24) and is referenced by nothing in the repo.
- `:25` — `github.event.pull_request.user.type != 'Bot'` excludes every Dependabot PR, so even
  repaired it would not cover the human SHA check `CONTRIBUTING.md:255-265` leans on.

The cost is not the failed runs; it is that `.github/workflows/` advertises an automated reviewer
the repo does not have, and `CONTRIBUTING.md:264` writes about that reviewer's behaviour as live
fact.

## The Closes/Refs split

The brief's POLICY HALVES section names *"whether to delete #1831's workflow"* as Bryan's, and
`docs/plans/2026-09-06-open-issues-sweep.md:54` puts "#1831/#1832 policy half" in the DECIDE bucket.
So:

1. **Ships now:** the `CONTRIBUTING.md` correction — a documentation fix that is true whether the
   workflow is later deleted or repaired.
2. **Held for Bryan:** deleting the workflow (and the `workflow-action-pin.test.ts` list edits that
   deletion would force). Named in the PR body's For-Bryan list with the measured evidence and a
   **recommendation to delete**.
3. **#1831 goes under `## Refs (partial — issue stays open)`.** It becomes `Closes` **only** if
   Bryan approves the deletion in-session before the PR body is written, in which case the PR body
   records his approval verbatim. The ship stage does not make that call on its own reading.

There is **no unfiled deferral**: #1831 itself stays open and is the decision's tracked home, so no
new number is needed. Do not write "tracked separately".

## Fix

### Ships in this PR

- `CONTRIBUTING.md:262-265` — the sentence "Note also that
  `.github/workflows/claude-code-review.yml` skips PRs authored by a bot, so the automated reviewer
  never looks at these." It states a behaviour that does not happen. Rewrite it to what is measured
  and true: the workflow has not completed a run since 2026-05-27 (its `ANTHROPIC_API_KEY` secret
  does not exist) and it excludes bot-authored PRs in any case (`:25`), **so the SHA provenance
  check above it is human-only.** Do not just delete the sentence — it exists to stop a reader
  assuming Dependabot bumps are covered by something, and that reason survives either outcome.
  Phrase it so it stays correct if the workflow is later deleted: describe the absence of coverage,
  not the file.

### Held for Bryan's answer (do NOT land without a recorded in-session approval)

One unit; landing any part of it is landing the decision.

- `rm .github/workflows/claude-code-review.yml`.
- `tests/scripts/workflow-action-pin.test.ts:49-55` — remove `"claude-code-review.yml"` from
  `WORKFLOW_FILES`, **in the same commit**: `:152-157` asserts the on-disk `.yml` set equals that
  list by exact equality, so the deletion turns `check` red until the list matches.
- Same file, `:61-72` — remove `"anthropics/claude-code-action"` from `ALLOWED_ACTIONS` (verified:
  it appears in no other workflow). **Not test-forced** — `:202-209` is
  `expect(ALLOWED_ACTIONS).toContain(owner)` inside a per-file loop, containment rather than set
  equality — so if the deletion lands, the PR body must say this removal was verified by reading the
  diff, not by a green suite.

## Tests

**None.** The half that ships is prose; no test reads it, and inventing one for a sentence about an
absent capability is a mechanism the issue did not ask for. If the deletion later lands, its anchor
already exists (`workflow-action-pin.test.ts:152-157`, exact-equality file set) and editing that
list in the same commit *is* the review gate. No experiment in
`docs/reviews/2026-09-02-v1-review/experiments/` covers this issue.

## Done when

`CONTRIBUTING.md` no longer describes a reviewer that does not exist, and its replacement sentence
stays true under either outcome; `npm test` green (nothing it asserts changes — the workflow file
and both lists are untouched on the default path); the PR body carries the measured evidence, puts
delete-vs-repair to Bryan **with a recommendation to delete** and the three exact edits named, and
lists **#1831 under `## Refs (partial — issue stays open)`** naming the doc bullet as done and the
deletion as the remaining half.

If Bryan approves in-session first: the three edits land in the same commit, the PR body records the
approval and states that only the workflow-file set is test-pinned, and `Closes #1831`.

## Not in scope

Wiring any replacement automated review. Changing the Dependabot `github-actions` grouping (#1745
decided it stays ungrouped). Deleting `CLAUDE_CODE_OAUTH_TOKEN` — a secret deletion is Bryan's and
leaving it costs nothing.

## Review corrections (scope cut)

**Removed.** The optional new set-equality `it` for `ALLOWED_ACTIONS` — a new gate the issue did not
ask for, on a list this PR may not even touch; the `git stash` re-add discriminating check, which
exercised a guard that already exists and is only reachable on the held path; the round-1/round-2
correction logs, folded into the body.

**Finding addressed.** *"#1831 ships an irreversible repo change and `Closes #1831` over a decision
the brief and the ledger assign to Bryan."* Adopted in full: only the `CONTRIBUTING.md` correction
ships, the deletion moves behind a recorded approval, and #1831 is `Refs (partial)` by default. The
conditional-filing shape flagged as inconsistent with `I-release-1832.md` is gone — nothing is filed
here because #1831 itself is the tracked home.

**File set:** default path is **`CONTRIBUTING.md` only**. `.github/workflows/claude-code-review.yml`
(deleted) and `tests/scripts/workflow-action-pin.test.ts` land only on a recorded in-session
approval.
