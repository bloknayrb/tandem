# K-tests — #1599 config-mutation lost-update race (accepted, no work)

Branch `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861`.
**Refs #1599, NOT Closes. No fix in this PR.** Ledger:
`docs/plans/2026-09-06-open-issues-sweep.md:459`. Probe: none — this spec exists to record that
K-tests looked at #1599 and deliberately did nothing, per the wave-table note.

## Problem

#1599 is not a defect to fix. It is the tracked record of an ACCEPTED security finding — decided
2026-08-24 by Bryan, revisit 2027-02-24 (tracked separately in #1671; #1599 itself is closed as a
PR reference but stays open as the finding's tracked home per `docs/security.md#open-findings`).
The config-writer read-modify-write race in `src/server/integrations/apply.ts` is a known, bounded
risk, not something this PR is scoped to fix. Its scope is pinned by
`tests/docs/config-writer-set-claims.test.ts`, and the issue's own body is explicit: **"adding a
config writer is what widens it."**

Checked whether anything in this PR group's other five specs (#1861, #1855, #1734, #1584, #1825)
touches `src/server/integrations/apply.ts`, `src/server/integrations/storage.ts`, or adds any new
caller of a config writer:

- #1861 — `tests/docs/rust-sources.ts`, `tests/docs/rust-sources.test.ts` (new) only.
- #1855 — `tests/server/export-path-canonicalization.test.ts`,
  `tests/server/mcp-tool-integration.test.ts` only (annotation-export sidecar paths, unrelated to
  MCP-client config files).
- #1734 — `tests/perf/performance.spec.ts`, `docs/perf-gate-results.md` only.
- #1584 (round-1 scope grew slightly, re-checked) — comment/doc-string edits in
  `src/server/license/*.ts` (license-state.ts, license.ts, kv-store.ts),
  `src/server/annotations/sync.ts`, `docs/licensing-operations.md`, and
  `tests/client/*`/`src/client/panels/cardDensity.ts` (also comment-only); none of these write
  `.claude.json` / MCP client config, and `sync.ts`'s edit is a docblock comment on the annotation
  merge algorithm, unrelated to any config writer.
- #1825 (round-1 correction: the fixture is NO LONGER deleted — bullet 5 was refuted, it has a real
  Rust-test reader) — `tests/server/launcher/cwd-preview.test.ts`,
  `tests/server/annotation-remove-seam.test.ts` only; `tests/fixtures/mcp-config-sample.json` is
  now untouched rather than removed.

**None of the six writers named in #1599's "Writers covered by this acceptance" list
(`applyConfig`, `removeConfigEntries`, `refreshMcpEntryBinary`, `refreshAllMcpEntryBinaries`,
`installSkill`, `refreshExistingSkillIfStale`, plus `applyConfigWithToken` and
`atomicWriteConfigFile`) is touched, called, or gains a new caller anywhere in this group's diff.**
The accepted bound is not widened.

## Fix

None. Per the wave-table note: "if anything in this group would add [a config writer], stop and
say so rather than widening an accepted bound silently." Nothing does.

## Tests

None. The verification here is the negative-grep above, re-run at PR time against the final diff
(not just this planning-time read) before the PR is opened: `git diff origin/master...HEAD --
src/server/integrations/apply.ts src/server/integrations/storage.ts src/cli/` must be empty.

## Done when

The final diff for this group's PR touches none of `src/server/integrations/apply.ts`,
`src/server/integrations/storage.ts`, or `src/cli/uninstall-scrub.ts`; the PR body states plainly
that #1599 is Refs-only with no code change, and why (accepted finding, no widening).

## Not in scope

Everything in #1599's own "Follow-up work" checklist (amending `docs/security.md`, adding the
guard test deriving the config-writer set from source, annotating
`tests/server/integrations/apply-malformed.test.ts:245`) — that is #1599's own tracked follow-up
work, not something this group's issues ask for, and doing it here would be exactly the kind of
unrequested scope-widening this spec exists to refuse. If Bryan wants that follow-up work done, it
is its own group against #1599/#1671 directly, not folded into K-tests.

## Review corrections (round 1)

No blocking or non-blocking finding targeted this spec directly. **Adopted (housekeeping):**
updated the per-sibling file-list summary to match the round-1 changes made to the #1584 and #1825
specs (a new `sync.ts`/`docs/licensing-operations.md` touch on #1584; #1825's fixture is no longer
deleted since bullet 5 was refuted) — the negative-grep conclusion (none of #1599's six named
config writers is touched, called, or gains a new caller anywhere in this group's diff) is
unchanged by either update, since none of the added/removed files is a config writer or a config
writer caller. Re-verify with the same negative-grep command at PR time against the final diff, per
this spec's own "Tests" section.

**Not adopted:** none — no findings targeted this spec.
