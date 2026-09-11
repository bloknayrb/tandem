# K-tests — #1599 config-mutation lost-update race (accepted, no work)

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
**Refs #1599, NOT Closes. No fix in this PR.** Ledger:
`docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe: none.

## Problem

#1599 is the tracked record of an ACCEPTED security finding — decided 2026-08-24 by Bryan, revisit
2027-02-24 (tracked separately in #1671). The config-writer read-modify-write race in
`src/server/integrations/apply.ts` is a known, bounded risk, not something this PR is scoped to
fix. Its scope is pinned by `tests/docs/config-writer-set-claims.test.ts`, and the issue's own body
is explicit: **"adding a config writer is what widens it."**

## Fix

None. Per the wave-table note: if anything in this group's other five specs would add a config
writer, stop and say so rather than widening the accepted bound silently. Checked at PR time (see
Tests below): none of the six writers #1599 names (`applyConfig`, `removeConfigEntries`,
`refreshMcpEntryBinary`, `refreshAllMcpEntryBinaries`, `installSkill`,
`refreshExistingSkillIfStale`, plus `applyConfigWithToken`/`atomicWriteConfigFile`) is touched,
called, or gains a new caller anywhere in this group's diff.

## Tests

At PR time, run `git diff origin/master...HEAD -- src/server/integrations/apply.ts
src/server/integrations/storage.ts src/cli/uninstall-scrub.ts` and confirm it is empty — this is
the actual verification, re-run against the final diff rather than trusted from a planning-time
read.

## Done when

The final diff for this group's PR touches none of `src/server/integrations/apply.ts`,
`src/server/integrations/storage.ts`, or `src/cli/uninstall-scrub.ts`; the PR body states plainly
that #1599 is Refs-only with no code change, and why.

## Not in scope

Everything in #1599's own "Follow-up work" checklist (amending `docs/security.md`, a guard test
deriving the config-writer set from source, annotating
`tests/server/integrations/apply-malformed.test.ts:245`) — #1599's own tracked follow-up, not
something this group's issues ask for. If Bryan wants that work done, it is its own group against
#1599/#1671 directly.

## Review corrections (scope cut)

No finding targeted this spec directly. Removed the round-1 per-sibling file-by-file summary
(which re-derived and restated every other spec's touched-file list) in favor of the single
`git diff` check above, which is the actual verification and does not go stale as the sibling specs
are edited.
