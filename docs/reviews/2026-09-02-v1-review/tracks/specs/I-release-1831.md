# I-release — #1831 `claude-code-review.yml` has been dead since 2026-05-27 and would skip Dependabot PRs anyway

Branch `fix/release-and-ci-hygiene-1856` (one branch for the group). **REFS, NOT CLOSES, unless
Bryan approves the deletion in-session before the PR body is written** — see "The Closes/Refs
split" below; the deletion of a tracked workflow file is a policy act the group brief and the
ledger both assign to him. Ledger:
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

## The Closes/Refs split — the deletion is Bryan's, the doc correction is not

The group brief names this issue's disposition explicitly in its POLICY HALVES section: *"whether
to delete #1831's workflow"* is Bryan's, alongside whether to publish RCs at all and the NPM_TOKEN
cadence. `docs/plans/2026-09-06-open-issues-sweep.md:54` says the same, putting "#1831/#1832 policy
half" in the DECIDE bucket, whose handling is "Rounds of 4 to Bryan when their wave is next". The
earlier draft of this spec decided it on its own authority, deleted the file and kept `Closes
#1831` — which is the wave-6 failure this group's brief was written to prevent, dressed as a
framing argument ("the question is whether the repo should have a reviewer at all, not whether to
delete this file"). The act being taken is the deletion, and the deletion is the thing the brief
lists as his.

So the issue splits, the way #1832 does:

1. **Ship now, uncontroversially: the `CONTRIBUTING.md` correction.** It is a documentation fix —
   the file currently describes an automated reviewer's behaviour as live fact, and it is not — and
   it is true whether the workflow is later deleted or repaired.
2. **Hold the deletion** (the workflow file *and* the two `workflow-action-pin.test.ts` list edits,
   which only exist to serve it) behind Bryan's answer.
3. **#1831 goes under `## Refs (partial — issue stays open)`** naming the measured evidence and the
   recommendation. **Unless** Bryan approves the deletion in this session *before* the PR body is
   written — in which case the deletion lands in this PR, `Closes #1831` becomes defensible, and
   the PR body records his approval verbatim. The ship stage does not get to make that call on its
   own reading; absent a recorded approval it is `Refs`.

There is **no unfiled deferral here**: #1831 itself stays open and is the tracked home for the
delete-vs-repair decision, so nothing needs a new number. Do not write "tracked separately".

## Fix

### Ships in this PR

- `CONTRIBUTING.md:262-265` — the sentence "Note also that
  `.github/workflows/claude-code-review.yml` skips PRs authored by a bot, so the automated reviewer
  never looks at these." It states a live behaviour that does not happen. Rewrite it to say what is
  measured and true today: the workflow has not completed a run since 2026-05-27 (its
  `ANTHROPIC_API_KEY` secret does not exist), and it excludes bot-authored PRs in any case
  (`:25`), **so the SHA provenance check above it is human-only.** Do not simply delete the
  sentence: it exists to stop a reader assuming the Dependabot bumps are covered by something, and
  that reason survives both possible outcomes of the decision. Phrase it so it stays correct if the
  workflow is later deleted — describe the absence of coverage, not the file.

### Held for Bryan's answer (do NOT land unless he approves in-session)

These three edits are one unit; landing any of them without the decision is landing the decision.

- `rm .github/workflows/claude-code-review.yml`.
- `tests/scripts/workflow-action-pin.test.ts:49-55` — remove `"claude-code-review.yml"` from
  `WORKFLOW_FILES`. **Required in the same commit as the deletion**: `:152-157` asserts the on-disk
  `.yml` set equals that list, so the deletion turns `check` red until the list matches. That test
  is the ADR-051 anchor for the pin set and must keep failing closed on a *new* file.
- Same file, `:61-72` — remove `"anthropics/claude-code-action"` from `ALLOWED_ACTIONS`. Verified:
  that action appears in no other workflow (`grep -rn claude-code-action .github/`), and the list's
  own comment says editing it means adding or removing a dependency that runs with repository
  secrets — removing one is exactly that. `actions/checkout` stays; four other files use it.
  **This edit is NOT test-forced and nothing will tell you if you skip it.** `:202-209` asserts
  `expect(ALLOWED_ACTIONS, …).toContain(owner)` inside a per-file loop — *containment*, not set
  equality — so a stale entry for an action no workflow uses changes no test outcome in either
  direction. It is a reviewed narrowing of the inventory, and "the tests are green" is not evidence
  it was done.

**Optional, and only if the deletion lands: make that last edit forced.** One top-level `it` in
`workflow-action-pin.test.ts` asserting
`new Set(WORKFLOW_FILES.flatMap(walkUses).map(ownerOf))` equals `new Set(ALLOWED_ACTIONS)` turns an
entry for an action no workflow uses into a red `check`, while keeping the fail-closed-on-a-new-action
property the containment check already has. It costs one assertion and removes the only unguarded
edit in this spec. If it is not adopted, the PR body must say the removal was verified by reading
the diff, not by a green suite.

### The For-Bryan item

State it in the PR body's For-Bryan list as the delete-vs-repair decision it is, with the measured
evidence (eight consecutive `failure` runs, newest 2026-05-27, `ANTHROPIC_API_KEY` absent, `:25`
excludes bots, `CLAUDE_CODE_OAUTH_TOKEN` exists since 2026-03-24 and is referenced by nothing) and
**a recommendation: delete.** A workflow that has not run in 3.5 months is a candidate for deletion,
not for a repair nobody asked for; deleting enables nothing and reverts in one commit, while
repairing turns an LLM loose to comment on every PR — a capability the repo has never had and a
recurring cost. Name the exact edits the deletion would take (the three above), so approving it is
a one-word answer rather than a new planning round.

## Tests

**Nothing new for the half that ships.** The `CONTRIBUTING.md` correction is prose; no test reads
it, and inventing one for a sentence about an absent capability is a mechanism the issue did not ask
for.

Everything below applies **only if Bryan approves the deletion** and it lands in this PR.

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

**Default path (no in-session approval).** `CONTRIBUTING.md` no longer describes a reviewer that
does not exist, and its replacement sentence stays true under either outcome; `npm test` green
(nothing it asserts changes — the workflow file and both lists are untouched); the PR body carries
the measured evidence (eight failures, last run 2026-05-27, `ANTHROPIC_API_KEY` absent, `:25`
excludes bots), puts delete-vs-repair to Bryan **with a recommendation to delete** and the three
exact edits named, and lists **#1831 under `## Refs (partial — issue stays open)`**, naming the
doc bullet as done and the deletion as the remaining half.

**Approved path (Bryan says delete, in-session, before the PR body is written).** All of the above,
plus: workflow deleted; both lists in `workflow-action-pin.test.ts` updated in the same commit (the
`ALLOWED_ACTIONS` one confirmed by reading the diff unless the set-equality `it` was added, since
no existing test reports it); the re-add discriminating check below run; the PR body records his
approval verbatim and states that only the workflow-file set is test-pinned; `Closes #1831`.

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

## Review corrections (round 2)

**Adopted.**

- **BLOCKING — the spec shipped an irreversible repo change and `Closes #1831` over a decision the
  brief and the ledger both assign to Bryan.** Verified: the group brief's POLICY HALVES section
  names "whether to delete #1831's workflow" among Bryan's, and
  `docs/plans/2026-09-06-open-issues-sweep.md:54` puts "#1831/#1832 policy half" in the DECIDE
  bucket ("Rounds of 4 to Bryan when their wave is next"). The round-1 defence — that the For-Bryan
  item was "new work, not a residual" — reframed the question while still performing the act the
  brief reserves. It also made the residual's filing conditional, the shape its sibling spec
  `I-release-1832.md` explicitly rejects. Split adopted, in the `## The Closes/Refs split` section:
  the `CONTRIBUTING.md` correction ships (a documentation fix, true under either outcome); the
  deletion and the two `workflow-action-pin.test.ts` list edits are held as one unit behind Bryan's
  answer; #1831 goes under `## Refs (partial — issue stays open)` with the measured evidence and a
  delete recommendation, becoming `Closes` **only** on a recorded in-session approval. No new issue
  is filed and none is needed — #1831 stays open as the decision's own tracked home, so rule 2 is
  satisfied without a number.
- **The `ALLOWED_ACTIONS` removal can be made test-forced for one line.** Adopted as an explicit
  option on the approved path: one top-level `it` asserting
  `new Set(WORKFLOW_FILES.flatMap(walkUses).map(ownerOf))` equals `new Set(ALLOWED_ACTIONS)` turns a
  stale entry red while keeping the fail-closed-on-a-new-action property of the existing
  containment check (`:202-209`, verified as `toContain` inside a per-file loop). If not adopted,
  the PR body must say the removal was verified by reading the diff, not by a green suite.

**Not adopted.** None.

**File set changed** — the default path touches **`CONTRIBUTING.md` only**. `.github/workflows/claude-code-review.yml`
(deleted) and `tests/scripts/workflow-action-pin.test.ts` move to a conditional set that lands only
on a recorded in-session approval from Bryan.
