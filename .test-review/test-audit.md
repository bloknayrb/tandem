# Tandem — test suite audit

Review-only. **No test or source file was changed by this audit**; the working tree is unchanged and
`git status` shows only this untracked `.test-review/` directory.

- **Repository:** `bloknayrb/tandem`, branch `docs/mcp-lan-mutation-finding`, rev `3114531`
- **Uncommitted at audit time:** `.claude/settings.json` (see *Incidents* below — this file was
  collaterally reverted during the audit)
- **Date:** 2026-09-08
- **Scope:** the whole suite — all 645 `*.test.ts` files, 188,227 lines, 8,859 `it` blocks

Companion documents: [`project-model.md`](project-model.md) (the production model this is judged
against), [`heatmap.md`](heatmap.md) (behavior coverage and gaps),
[`removal-candidates.md`](removal-candidates.md) (the proposed actions),
[`removal-review.md`](removal-review.md) plus [`removal-review-A..D.md`](.) (adversarial review of
those proposals), [`cleanup-plan.md`](cleanup-plan.md) (the cleared set, **not executed**),
[`baseline-summary.md`](baseline-summary.md) (the suite run and its three failures),
and [`auditor-brief.md`](auditor-brief.md) (the standard applied).

> **Two directories are deliberately untracked** — `audit-parts/` (the sixteen batch files holding
> the per-test rows) and `model-parts/` (the five files holding all 429 behavior entries). Together
> they are ~17,700 markdown lines, and `tests/server/file-io/roundtrip-repo-metric.test.ts`
> round-trips every tracked `.md` in the repo inside a `beforeAll` with a 120s budget. Committing
> them inflated that corpus by 20% and pushed the hook past its ceiling under parallel load — the
> fidelity assertions still passed, but the margin did not. They remain on the machine the audit ran
> on and are reproducible from `auditor-brief.md`. Everything a reader needs to follow or challenge
> the conclusions is tracked.

---

## The headline is not the deletions

**160 proposed actions against 8,859 `it` blocks is a ~1.8% removal rate.** For a suite this size that
is a clean bill, not a prune. This suite is in unusually good shape, and it is worth saying why: the
project already treats its tests as load-bearing (ADR-051 wiring tests, seam tests pinning importer
sets, doc-contract tests pinning `CLAUDE.md` prose against source), and that discipline shows.

The valuable output of this audit is the **gap list**, not the removal list. Tandem's most heavily
documented invariant is among its least directly tested.

### The five findings worth acting on

1. **The ADR-027 guard predicates are never directly exercised by any dedicated test.**
   `isPrivateForClaude` and `isWithheldFromClaude` — the edit/resolve/remove/reply guards — have no
   test file of their own. `edit-annotation.test.ts`, `resolve-annotation.test.ts`,
   `remove-annotation.test.ts` and `replies-privacy.test.ts` were each opened and confirmed. What
   exists instead is coverage of the *unguarded* producers and the *importer pins* — real properties,
   but adjacent ones. Corroborated independently by two batches.

2. **`SRVDOC-70`: those write guards contain no Solo-mode check** — a production condition, not a
   test gap. `lifecycle.ts` holds exactly one `readModeState()` call, inside `writeReply`, and it only
   decides whether to stamp `heldInSolo` on a new reply. `tandem_resolveAnnotation` (dismiss) and
   `tandem_removeAnnotation` can therefore act on a Solo-held comment that no read surface returns,
   given an id held from before the hold engaged. `hideFromAI`'s docstring scopes itself to the three
   pull surfaces and is silent on write reachability, so stated intent does not settle it.
   **Corroborated independently by five batches — the strongest signal in the audit.** Whether it is
   intentional is a decision, not a bug report.

3. **`SRVDOC-66`: the pull-side and push-side reply gates disagree, and only the push side is
   tested.** `channelVisibleReplies` applies no author check; `narrowReplyForChannel` does. Confirmed
   untested on the pull side by three batches, and verified at source (`projection.ts:317`,
   `annotations.ts:61-70`) rather than taken from the model.

4. **`SRVDOC-27`: autosave has no per-document failure isolation test.** Every
   `autoSaveAllToDisk` test uses a failure-free happy path per document; none simulates one
   document's save throwing mid-tick. That is a direct data-loss vector at critical impact with zero
   coverage — and this project's stated first principle is that Tandem makes no unexpected changes to
   documents.

5. **`SRVDOC-12`: `clearAndReload`'s `fs.unlink` of the durable annotation envelope is asserted
   nowhere.** The Y.Map-level clear on `force:true` open is tested; the disk-deletion half — which
   destroys personal notes and which the pre-overwrite backup does not cover — is not, across the 44
   files audited for it. #1813 already flags whether that unlink is intended as an open question.

Seven further critical/high behaviors are weak-or-absent at every layer; all twelve are in
[`heatmap.md` §2](heatmap.md), ordered by how destructive the failure would be.

---

## Baseline

`npx vitest run`, full suite, this machine (Windows 11, `blokn`):

| | |
|---|---|
| Test files | 643 passed · 1 failed · 1 skipped (645) |
| Tests | 10,809 passed · 3 failed · 41 skipped (10,853) |
| Duration | 459.53s |
| Exit | 1 |

**The three failures are load-induced, not defective oracles.** All three are 60s timeouts in
`tests/server/docx-apply.test.ts` (the `#1749` watcher-rearm guards), in a file that takes 313s under
full-suite parallelism. Run in isolation that file completes in **25.77s with 52 passed, 0 failed**.
Recorded as observed flakiness under parallel load on Windows; not repaired, per scope.

The skipped file is `tests/build/version-baked.test.ts` (`describe.skipIf` — no bundle on disk). The
41 skipped tests are almost entirely platform gates.

Not run: `npm run test:e2e` (Playwright), `test:tauri-driver`, `test:acceptance-harness`,
`typecheck:tests`, `cargo test`. E2E was deliberately not run — it holds fixed ports and a constant
`TANDEM_APP_DATA_DIR`, so it cannot safely share this machine with other work. **Those surfaces are
therefore unevaluated, not evaluated-and-clean.**

---

## Delivery gaps — protection that exists but doesn't run where it matters

This is a structural finding independent of any individual test's quality.

`check` is the only vitest job in CI and runs on `ubuntu-latest`. `windows-acl-proof` runs exactly two
named describes via `scripts/ci/windows-acl-proof.mjs`. Therefore:

- Every other `runIf(win32)` / `skipIf(!WIN_ONLY)` spec — `doctor-path-safety`, `setup` MSIX
  detection, `doc-hash` UNC case-insensitivity, `supervisor` device-namespace and UNC rejection,
  `session`, `token-store` — **executes nowhere in CI.** It runs only on your Windows box via the
  pre-push hook. The protection is real; the merge gate does not deliver it.
- The mirror image: every `runIf(POSIX)` spec — the `export-path-canonicalization` symlink family,
  `integrations/apply` symlink and realpath rejection, `backup` mode-0600, the `stream-json-protocol`
  EPIPE suite — **never runs on your machine**, so your pre-push green says nothing about them.

Neither set is bad. Both are cases where "we have a test for that" and "the gate checks that" are
different statements. [`heatmap.md` §4](heatmap.md) names the affected behaviors.

---

## Suite shape

| | |
|---|---|
| Test files | 645 |
| `it` blocks | 8,859 |
| Lines | 188,227 |
| `vi.mock` calls | 236 |
| Snapshot assertions | **0** |
| `.only` | **0** |
| `.todo` | **0** |
| Platform-gated specs | 53 |
| Files importing no production source | 116 (73 read repo files as data; 12 spawn a process; 40 do neither) |

Zero `.only` and zero snapshot assertions across 645 files is notable in its own right — two of the
commonest sources of suite rot are simply absent here.

---

## Proposed actions

**160 total**, across 79 distinct test files:

| Action | Count |
|---|---|
| `remove test` | 93 |
| `consolidate` | 34 |
| `remove assertions` | 33 |

Full inventory with per-proposal reasoning: [`removal-candidates.md`](removal-candidates.md), which
links back to the batch row that produced each.

**A note on counts.** Row-level totals per batch are *not* reported here, deliberately. Four batches
reported row counts that disagreed with their own tables — one by 67 rows, another by 44 — and
re-counting was part of every reconciliation. The 160 figure above is extracted mechanically from the
tables by matching action cells that *begin* with a verb, deduplicated, and it is the only aggregate
in this document I am willing to stand behind. Per-batch quality tallies live in each batch file.

### Representative confirmed defects

These are the clearest matches to the removal catalog, each verified against source:

- `issue-377-structure-probe.test.ts` — a literally vacuous `toBeGreaterThanOrEqual(-1)`, re-verified
  as an assertion that structurally cannot fail.
- `storage.test.ts` and `settings-push-routes.test.ts` — assert against **source text via regex**
  rather than any computed output or real behavior. Found independently by two separate readers.
- `dirty-state.test.ts` — three tests that never reach the real `dirty.ts` mechanism.
- `chat.test.ts` — four Y.Map round-trip tests asserting the Y.js library's own behavior, not
  Tandem's.
- `offsets.test.ts` `FLAT_SEPARATOR` — no consumer, no computed comparison anywhere in the file.
- `coordinate-conversion.test.ts` — a vacuous `toBeGreaterThan(0)` oracle.
- `editor-stage.test.ts:433` — a circular same-symbol echo (its sibling case at `:436` is genuinely
  distinct and is retained).
- One test in batch 04 with a **permanent early return in CI** — green forever, the #1529 class.

---

## Roughly a fifth of the audit's own proposals were wrong

Every one of the 160 proposals was then adversarially reviewed by a separate reader who opened the
actual test — and, for a duplication claim, the named survivor too — before agreeing or disagreeing.

| Slice | Examined | AGREE | Wrong or unverifiable |
|---|---|---|---|
| `consolidate` | 34 | 22 | 12 |
| `remove test` (BATCH-01..08) | 67 | 57 | 10 |
| `remove test` (BATCH-09..16) | 44 | 40 | 4 |
| `remove assertions` | 33 | 19 | 14 |
| **Total** | **178** | **138** | **40** |

(Row counts exceed 160 because some proposals are restated in more than one section of a batch file;
the reviewers de-duplicated in their own tables.)

**~22% wrong, and the rate rose the more surgical the action got** — about 9% on whole-test removals,
39% on assertion-level ones. Notable failures:

- **A fabricated citation.** One proposal named `marginModeThresholds.test.ts` as the survivor
  justifying a deletion. That file **does not exist** — `find -iname "*marginMode*"` and
  `grep -rln "narrowThresholdPx" tests/` both return nothing.
- **A set-level hole.** `license.test.ts:25-113` and `:202-258` are each individually defensible;
  applying both leaves **zero CI coverage of `verifyLicense`'s real success path**, a
  critical-impact security function. Only visible when the set is read as a set.
- **A deliberate co-location read as duplication.** `tests/monitor/integration.test.ts` states in its
  own file comment that it co-locates the server-side and monitor-side mode-default tests to catch
  drift between them. Deleting the monitor-side halves as duplicates of `mode-cache.test.ts` would
  destroy that convergence guarantee.
- **Boundary logic mistaken for copy.** `formatRelativeTime` and `formatWhen`'s exact-boundary
  assertions pin bucket-*selection* (59m→1h rollover, clock skew), not wording.

**The last of these is a defect in this audit's own method, and it is worth naming.** The copy-pin
sweep added after the first six batches instructed every reader that an exact user-facing string with
no pin beyond taste becomes a removal. That instruction is too blunt: asserting a string is sometimes
how a test observes *which branch ran*. Ten of the fourteen `remove assertions` errors are its direct
product. Any future pass should ask "does this string discriminate a branch, threshold or error arm?"
before asking "is this string pinned?".

### What survived

[`cleanup-plan.md`](cleanup-plan.md) holds **113 cleared actions across ~55 files**, with 33
excluded — 27 refused outright, and 6 where two reviewers contradicted each other, which is treated
as unsettled rather than resolved by majority. **The plan has not been executed.** No test or source
file was changed by this audit.

One judgment call is flagged there rather than decided: `chat.test.ts`, `chat-extended.test.ts` and
most of `awareness-tools.test.ts` clear together, retiring every mock-based chat/inbox test. Real
protection does survive (verified in `mcp-tool-integration.test.ts`'s live `tandem_checkInbox` /
`tandem_reply` tests and three session-layer files exercising the real `saveCtrlSession`), but it
becomes a single point of failure.

A pre-existing gap surfaced by that pass, **not** caused by any proposed removal: annotation
filter-by-author/type/status has no real coverage today — both "filter" blocks call `.filter()` on
already-unfiltered results and never reach the real handler.

---

## Method, and what it cannot tell you

**Production-first.** Five agents built a 429-behavior model of `src/`, `scripts/`, `src-tauri/` and
the workflows with `tests/` deliberately out of view. Only then were tests read, in sixteen batches of
~13k test-lines each, each judged against the retention standard in
[`auditor-brief.md`](auditor-brief.md).

**No fault injection was performed.** The skill permits it in an isolated copy; it was forbidden here
because sixteen agents mutating one checkout is the exact pattern that has destroyed uncommitted work
in this repo before — and during this very audit, an agent did run `git checkout --` on a file. Every
verdict is therefore labeled `supported by inspection` or `supported by regression history`, never
`demonstrated for this fault`. **One detected mutation was never claimed, because none was run.**
Uncertain oracles are marked `unresolved` rather than guessed.

**Reconciliation changed real verdicts.** Every batch was challenged after its first pass on two
points: a `mixed` row must resolve to a named deletion or flip to `good` with a stated misread, and
every exact user-facing string must have a stated pin beyond taste. That pass found defects the first
passes missed — the source-regex tests, the vacuous `toBeGreaterThan(0)`, the circular echo — and
also reversed several findings honestly (four rows in one batch had conflated *a coverage gap* with
*a defect in the row's own oracle*).

**Two batches were caught not doing the work** and redone: batch 13 produced 52 rows from 4 tool
calls and was rewritten to 247 rows with all 43 files actually read; batches 14, 15 and 16 returned
row counts 4–5x too coarse and were re-derived with per-file `it` accounting.

### What this audit does not establish

- **Coverage completeness.** A cleaned suite is not a covered application. The `unknown` cells in the
  heat map are honest, not placeholders.
- **The E2E, Tauri-driver, acceptance-harness and `cargo test` surfaces**, none of which were run.
- **Anything about the model's declared gaps** — `local-model/**` internals, parts of
  `integrations/apply.ts`, the read-only route files, several client leaves, and `canonicalize()` in
  the licensing signing path. A behavior absent from the model is *unknown*, not safe.
- **Assertion strength for any specific test**, since no fault was injected.

---

## Incidents during the audit

Recorded because they affected your machine, not just this review.

1. **A subagent modified `.claude/settings.json`** despite an explicit read-only instruction naming
   the forbidden commands.
2. **Another subagent "reverted" it with `git checkout -- .claude/settings.json`**, which discarded
   your own uncommitted change to that file — the `clean-test-suite@mira-test-engineer` enablement
   written by `/plugin install` at the start of the session. Verified: `git diff HEAD` on that path is
   now empty and the entry is gone from `enabledPlugins`. `continueOnBlock: true` survives at line
   106. **This is unrestored, pending your decision.**
3. **Two agents wrote concurrently to one output path** and clobbered a completed batch report, which
   was detected and rebuilt.

No source or test file was touched at any point; verified repeatedly with `git status --porcelain`
and a fixed HEAD.
