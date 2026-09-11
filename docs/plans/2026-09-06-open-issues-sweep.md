# Open-issues sweep — 2026-09-06

**What this is.** The tracked home for the orchestrated sweep of every open issue: the decisions
Bryan took on 2026-09-06, the wave/PR-group table, the per-stage workflow contract, and the
**ledger** (the authoritative status of each group, updated after every wave). A new session
resumes from the ledger. The v1-review folder (`docs/reviews/2026-09-02-v1-review/`) holds the
evidence and per-track detail; each track's `## Status` points here.

**How it runs.** One `Workflow` invocation per group with
`docs/plans/2026-09-06-open-issues-sweep.workflow.js` (`scriptPath`), args from the group's row.
Stages: plan → adversarial review loop → implement (worktree under `.claude/worktrees/`) →
simplify → verify → e2e → manual probes → PR-review loop → ship → post-ship review. Specs land in
`docs/reviews/2026-09-02-v1-review/tracks/specs/`.

## Decisions taken in this session (recorded in wave 0)

| Q | Answer |
|---|---|
| Branches | One `fix/<slug>-<first-issue>` branch + one PR per group. The designated branch `claude/workflow-open-issues-plan-2bv1nv` carries only the sweep's own artefacts. |
| Merge | Auto-merge (merge commit) once required checks are green and every finding is fixed. **Caveat found in review:** `docs/lessons-learned.md` #64 records auto-merge as *not allowed* on this repo. Wave 0 asks Bryan to flip *Settings → Allow auto-merge*; until then the check-in loop merges via `merge_pull_request` (`merge_method: "merge"`, `expectedHeadSha`) when green — the same outcome he accepted as the API option. |
| Rust-touching groups | Included; CI's three `rust-test` legs verify if local `cargo test` cannot run. Bryan approved (2026-09-06) the CONTRIBUTING-named `HUSKY=0 git push` for that case, only after biome + `typecheck:tests` + vitest passed by hand; recorded in the ledger as `cargo: CI-only (Bryan 2026-09-06)`. |
| #1827 A | Obsidian vaults **out of scope** for v1: README says so, warn once on `[[`; still fix escape-stripping (#1753). |
| #1827 B | `tandem_applyChanges` ships **marked experimental**; cheap walker fixes (tab/br/sym) now. **No new issue** — #1754 stays open with a comment listing what landed and what decision B deferred. |
| #1827 C | Force-open / source-view commit **clear only the in-memory map**; next open re-anchors from `textSnapshot` (#1813). |
| #1827 D | Desktop **refuses to share its data dir with an older server** (version stamp); plus the `TANDEM_DATA_DIR`/`TANDEM_APP_DATA_DIR` fix (#1787). |
| #1827 E | Unknown; README unchanged; the Cowork VM check joins the smoke lines. |
| #1827 F | Restricted mode is **symmetric read-only**: `tandem_resolveAnnotation` plus the other annotation mutators (enumerated in H's spec) move from `UNGATED` to `GATED` in `tests/server/license-gate-coverage.test.ts` (rewrite its "needlessly block triage" justification), join **both** lists in `docs/licensing-explained.md`, and `POST /api/mode/release` joins the `/api` list. Behind the dark flag; byte-identical while dark (#1788). |
| #1827 G | Release skill **refuses a tag containing `-` unless prerelease**; `tauri-release.yml` marks such tags prerelease (#1748). |
| #1827 H | **Document orchestrator-only polling**; the shipped skill forbids sub-agent `tandem_checkInbox` (version bump) (#1820 item 4). |
| Other ~30 DECIDE issues | Batched to Bryan in rounds of 4 as their wave approaches; product-scope and security-policy items always go to him. |

## Environment facts that shape the design (verified)

| Fact | Consequence |
|---|---|
| `node_modules` absent; Node 22.22.2; cargo present; GTK/webkit2gtk/libxdo missing; root with `apt-get`; Chromium preinstalled at `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH` set) | Wave 0: `npm ci`, the CI apt recipe, the sidecar stubs, a warm `cargo test` on master. No Playwright install. |
| Husky hooks inactive until `npm ci`; **a fresh worktree has no `.husky/_`, so zero hooks run there** (CONTRIBUTING.md:187) | Every worktree runs `npx husky` after creation and the ship stage asserts `.husky/_/pre-push` exists before pushing. |
| `tauri_build` checks `src-tauri/binaries/*` and `dist/*` per checkout (gitignored); no cargo registry cache; a cold Tauri build is tens of minutes and GBs | Rust-touching worktrees re-run the stub `touch`; every cargo invocation exports `CARGO_TARGET_DIR=/home/user/tandem/src-tauri/target` so groups share one warm target and cargo's lock serialises them. |
| PostToolUse hooks (`typecheck-on-edit`, `svelte-check-on-edit`, `related-test`, `format-on-edit`) run against `$CLAUDE_PROJECT_DIR`, not the worktree | Wave 0 adds a path guard to those four scripts (`case "$FILE_PATH" in "$CLAUDE_PROJECT_DIR"/*) ;; *) exit 0;; esac`) on the designated branch; implement agents run `npx biome format --write <files>` before each commit. |
| No `gh`, no `dev-tools` plugin | GitHub MCP tools; in-session `simplify` and `code-review` skills — **whether workflow subagents carry the `Skill` tool is unverified**; wave 0 probes it and, if absent, the simplify/review prompts carry the criteria inline. No `gh stack` → dependent groups land in later waves. |
| 4 CPUs, 15 GB RAM, ~30 GB disk | Concurrency cap 2. **One group per `Workflow` invocation** (a pair only when file-disjoint); CPU-heavy stages serialised by a JS gate inside the script; E2E one at a time on the reserved ports. |
| Required checks: `check`, `rust-test`×3, `windows-acl-proof`; `strict` + `enforce_admins` | Every merge stales its siblings; the loop runs `update_pull_request_branch` then waits for CI again. Calendar time, not CPU. |
| CI `check` runs more than the hook: `npm run lint`, `biome check .`, `npm run build`, harness-stripped check, stdio/monitor smokes, acceptance harness, E2E | The verify stage mirrors that list, not just typecheck + vitest. |
| `docs/plans/YYYY-MM-DD-<slug>.md` is the tracked plan convention; `.claude/plans/` and `.claude/worktrees/` are gitignored; biome `includes` covers `scripts/**` but not `docs/` | Ledger at `docs/plans/2026-09-06-open-issues-sweep.md`; script at `docs/plans/2026-09-06-open-issues-sweep.workflow.js` (invoked by `scriptPath`, probed in wave 0); worktrees under `.claude/worktrees/`. |
| Spec precedent `tracks/specs/A8-1796.md` (Problem / Fix / Tests / Done when / Review corrections / Not in scope) | Plan stage writes that shape, committed. |
| `tests/skill-instruction-contract.test.ts:43` pins `version: 14` | Every skill-editing group (J1, C, Gc2a via #1776, D2) bumps to the next integer after `origin/master` at rebase time and updates that literal in the same commit; the ledger tracks the current number. |
| `.husky/pre-push` runs the full suite + cargo on every push | Verify runs only touched suites; the hook is the one full run per push; pushes are gated behind the JS mutex. `TANDEM_APP_DATA_DIR=$(mktemp -d -t tandem-XXXXXX)` prefixes every vitest/hook run — **the `tandem-` in the name is load-bearing, not cosmetic.** A bare `$(mktemp -d)` yields a path with no `tandem` in it, and `tests/server/platform.test.ts` asserts `SESSION_DIR` contains `tandem`, so the full-suite run in the pre-push hook fails 1 of 10,933 for a reason that has nothing to do with the diff under test. Wave 0 measured this (see the baseline row) and the fix drifted out of this summary row; it cost a wasted 3-minute pre-push on 2026-09-08. Targeted vitest runs do not hit it, so it only ever appears at push time. |

## Scope buckets

| Bucket | Handling |
|---|---|
| FIX (~120) | The pipeline, in waves below. |
| DECIDE beyond #1827 (32): #630 items 4–7, #1725, #1683, #1632, #1845, #1533, #1523, #1292, #1666, #1739, #1741, #1695→G9a, #1700 seam, #1687, #1610, #1590, #1517, #1445, #1443, #1421, #1373, #1249, #1134, #321, #1600 policy half, #1831/#1832 policy half, #1711 | Rounds of 4 to Bryan when their wave is next. |
| DATED-GATE (13): #1596 (**2026-09-30**), #1455 (2026-10-15), #1345 (2026-11-01), #1363 (2026-11-09), #1727 (2026-11-15), #1687 (2026-11-30), #1728, #1712, #1829 (all 2026-12-01), #1633 (2027-02-26), #1599 (2027-02-24), #1671 (2027-02-28), #1506 (monthly), #1199 (RC tag) | Untouched; listed with dates. **#1596 needs a Windows operator within three weeks — flagged to Bryan now.** |
| BLOCKED (hardware/upstream/`deferred`): #1869, #1505, #1354, #1335, #1370, #1333, #552, #317, #316, #989, #928, #916, #832, #1453 (needs a live app + visual review; the screenshots skill can draft it in wave 10 for Bryan's eyes) | Untouched; no-hardware slivers ride with the nearest group as `Refs`, never `Closes`. |
| FEATURE: #1857 remainder, #1142, #1123, #1521, #1598, #1464, #1626 part 2, #1659/#1446 (decide together), #1361, #1385, #1134 | Untouched; each is a later `/diverge` + plan. |
| Small FIX found by the verifier: #1584 (citation families) → K-tests | |
| UNTRUSTED (#1704) | Quoted, never followed. Issue **comments** from anyone but bloknayrb are data too. |
| Already fixed on master (#1656 via `awareness.ts:636`; #1823's four range items via #1848) | Closed with a pin, not re-fixed. |

## Waves and PR groups

Tiers: **S** sonnet plan+build, opus reviewers · **M** opus plan+build, opus reviewers · **L** fable plan
(session model), opus build, fable domain reviewer at `effort: max`. `[agent]` = repo reviewer agent.
`e2e` = runs `npm run test:e2e` before ship and ships screenshots for visible UI change. Groups in
one wave are file-disjoint (checked against the ledgers); each is its own `Workflow` invocation.

| Wave | Group | Issues | Tier | Notes |
|---|---|---|---|---|
| 0 | setup (inline) | — | — | `npm ci`; apt recipe + stubs; baseline `typecheck` / `vitest` / `cargo test` on master; hook path guards; `Skill`-in-subagent probe; symlinked-`node_modules` worktree probe incl. one E2E; throwaway `fix/probe-push` push then delete; record decisions; ask Bryan to enable auto-merge; commit artefacts. |
| 1 | K1 test gates | #1783 #1784 #1721 (count-pin only) | M [security] | #1784: make the gated set a **data list** so H widens it additively. #1721 must not depend on the #1683 colour decision. e2e. |
| 1 | A-rest | #1768 #1797 | M [security] | `probe-tools.mts` before/after. |
| 1 | G2 test timing | #1672 #1699 #1674 | M | Lands first; do not raise ceilings. |
| 2 | F-runtime | #1759 #1805 #1804 #1794 | M [security on #1794] | `mcp-stdio.ts`, `sse-consumer.ts`, `monitor/run.ts`, `channel-routes.ts` + its `docs/mcp-tools.md` relay section. |
| 2 | F-config | #1760 #1801 #1802 | M [security] | `apply.ts`, `setup.ts`, wizard. |
| 2 | J1 skill + workflows doc | #1771 #1782 #1820 #1737 (+decision H) | S [annotation-model on #1771/#1820] | Skill version bump. |
| 3 | J2 product copy | #1781 #1814 #1815 #1816 #1817 #1818 | S | After J1 (`docs/troubleshooting.md`). e2e. |
| 3 | F-doctor | #1806 #1807 #1811 #1790 | M | After F-config (same `apply.ts` writer set). |
| 3 | C privacy & authority | #1769 #1733 → #1770 #1779 #1803 (+#1619 #1710 folded into #1803) | **L** [annotation-model, security, svelte] | #1769 race repro first; #1733 scoped to conditional release + provenance field; `heldInSolo` stamp stays on `withBrowser`; reply guard keeps `note OR (comment && audience !== outbound)`; remove guard not on `removeAnnotationRecord`; skill bump. |
| 3 | Gc1 client state Highs | #1772 #1773 | M [svelte] | e2e. |
| 3 | #1821 docs drift | items with no `(#NNNN)` cross-reference, one PR per doc file | S | Cross-referenced items ride with their code PR. |
| 4 | B anchors | #1764 #1765 #1766 #1767 #1622 | **L** [crdt, annotation-model] | Read #1632, #1693, #1737 first; surface `kind` on `getAnnotations` first. |
| 4 | Gc2a position mapping | #1774 #1776 | M [crdt, svelte] | Harness tests → real specs. e2e. |
| 4 | Gc2b keys + a11y | #1775 #1777 #1778 | M [svelte] | Six `isComposing` sites, four focus-trap dialogs. e2e. |
| 4 | G5′ audience remnants | #1698 #1678 #1826 (+pin closing #1656) | M [annotation-model] | After C. |
| 5 | D1 markdown fidelity | #1813 #1751 #1753 #1799 #1852 #1850 + #1823 server-data bullets | M [crdt on #1751] | Decisions A, C. `docs/mcp-tools.md` Errors lines. |
| 5 | E1 desktop core | #1761 → #1763+#1812 → #1758+#1787 (+decision D) | M/L [security] | Rust; shared `CARGO_TARGET_DIR`. Before H (H's #1789 documents the env var #1787 makes real). |
| 6 | D2 docx contract | #1754 (Refs) #1755 | M→L [crdt, security on export refusal] | After D1 (`mdast-ydoc.ts`). Decision B; skill bump; `docs/mcp-tools.md`. |
| 6 | H the flip | #1788 → #1785 → #1793+#1786 (+#1825 infra section, same ledger row; code only, **no deploy**) → #1789 #1819 — three PRs in the ledger | **L** [security, annotation-model on mode/release] | Decision F edits both halves (see decisions); `TANDEM_LICENSE_GATE=1` runs; `server-probes/run.sh`. Worker deploys are Bryan's. |
| 6 | CI-trust | #1862 #1673 #1933 | M | #1933 filed 2026-09-09 during wave 5's closeout; same family. ADR-051 applies. |
| 7 | G8 docx comments | #1693 | L [crdt] | After D2. |
| 7 | I-release | #1748 (+G) #1856 #1830 #1831 #1832 (fix halves; policy halves to Bryan) + #1825 CI section | M [security] | After H (`tauri.conf.json`). `workflow-action-pin.test.ts` and ADR-051 wiring tests apply. |
| 7 | E2-rust | #1762 #1808 #1809 #1810 + #1455 pointer (Refs) + #1825 Tauri section | M [security] | |
| 7 | K-client | #1824 remainder #1713 #1724 #1727-split (Refs) #1709 #1544 | S [svelte] | One testid-snapshot regeneration. e2e. |
| 7 | K-tests | #1825 Tests remainder #1855 #1861 #1734 (e2e) #1584 #1599 checkboxes (Refs) | S | After F-doctor (writer set). |
| 8 | E2-upgrade | #1791 #1792 (+#1722's `updateSettings` boolean, once) + smoke-lines merge | M | After E2-rust (`lib.rs`). |
| 8 | K-sec-server | #1822 items 1,2,3,7,8 #1488 comment (Refs) #1609 | M [security] | `NON_LOOPBACK_ALLOWED` must not grow. After F-doctor and E2-rust (`license.ts`). |
| 8 | K-sec-launcher | #1822 items 4,5,6 #1600 (fix half) | M [security] | After E1 (#1761 keychain) and E2-rust (`sidecar.rs`). |
| 8 | G1 launcher stdin | #1866 #1868 #1867 #1780 | M | Same exit handler; #1867's delivery-proof choice flagged in the spec; #1869 Windows-blocked. |
| 8 | G10 awareness hygiene | #1624 #1702 | M [annotation-model] | |
| 9 | K-server | #1823 MCP-surface remainder #1851; then #1823 runtime as a second PR | S→M | After B, D1 and E2-upgrade (`store.ts`). `docs/mcp-tools.md` + `tests/docs/`. **Re-scope before starting (2026-09-08): the #1823 item `anchor` on `tandem_getAnnotations` ALREADY LANDED in wave 4 group B (#1916, `7989261d`)** — #1764 needed it to make a degraded re-anchor legible on the wire for the first time. Do not plan it twice; check the rest of #1823 against master before sizing this group. |
| 9 | G9a watcher/reload silence | #1662 #1663 #1695 | M | |
| 9 | G9b open/restore | #1863 #1696 + #1700 audit guard (Refs) | M/L | #1696 reproduce first. |
| 9 | #1708 workspace silent failures | #1708 | L [svelte] | Update the two #1707 specs. e2e. |
| 9 | G6 rail seam | #1719 #1716 (+#1722 surfacing if not in E2-upgrade) | M [svelte] | e2e. |
| 9 | G7 editor quick controls | #1705 #1706 #1738 | M [svelte] | e2e. |
| 9 | G14 chat markdown | #1639 → #1626 part 1 (Refs) | L | Escaping tests first. |
| 9 | #1603 transform audit | #1603 | M [security] | |
| 10 | G4 typecheck-tests | #1613 → #1614 → #1615 (alone) | S/M | |
| 10 | G11 process docs | #1602 #1604 #1605 #1606 | S | CLAUDE.md edits — last, to limit conflicts. |
| 10 | D3 docx save override | #1941 | M [security] | **Added 2026-09-11** — was open-by-design out of wave 6 (D2 shipped the refusal; this is the escape hatch) and had no row, so it was scheduled nowhere. Wave 10, not 8/9: it adds a `/api/save` body field (collides with K-sec-server's `api-routes.ts` work) and a `tandem_save` param + `docs/mcp-tools.md` line (collides with K-server). Both surfaces — the flag AND `FidelityReportBanner.svelte`'s "Save anyway" — or a browser user with no Claude attached still has no exit. `e2e` + screenshots. Keep `blockReasonMessage` content-free; do **not** extend the override to `tandem_applyChanges`. |
| 11 | #1689 harness refactor | #1689 | M | After G4. |
| 11 | local-model flip blockers | #1657 | M [security] | **Re-scoped 2026-09-11: #1292 is out — fixed and CLOSED 2026-09-08**, its severity re-decision made rather than still owed, so the "only after Bryan re-decides" gate this row carried is gone and the group is now #1657 alone. |
| 11+ | decision rounds | the ~30 DECIDE issues, 4 at a time | per item | |

## Workflow architecture

Script `docs/plans/2026-09-06-open-issues-sweep.workflow.js`, `args = {group: {id, issues:
[{n, closes}], tier, reviewers[], e2e, rust, skill, order[], notes, known: {branch?, pr?}}}`.
One group per invocation; stages are plain sequential `await`s (no `pipeline` interleaving, so
`resumeFromRunId` replays deterministically). Every stage returns `{ok, ...}` and never throws;
any stage after `review` short-circuits on `parked` or `failed`. Side effects are idempotent:
`git worktree add … || git -C <wt> checkout <branch>`; ship checks `gh pr list --head <branch>`
before creating; `args.known` lets a resumed run skip.

```
plan → reviewLoop(S 1 / M 1 / L 2, + scope cut at every tier) → implement → simplify → verify(+fix ≤2) → [e2e] → manualProbes
     → prReviewLoop(≤2, one batched skeptic) → ship(push, PR, auto-merge-or-record, subscribe)
```

**Budget shape (2026-09-07, wave 3).** Measured on J2 (S) and F-doctor (M): plan refuters were 42–43%
of a group's output tokens and per-finding skeptics another 10–12%, with 170M+ cached-input tokens
riding on the refuters alone; build, verify, e2e, probes, simplify and code-review together were
under 10%. C (L, three domain lenses at `max` every round) had spent more on plan refutation than J2
spent end to end before it reached Build. The script now caps plan rounds by tier, lets the domain
lens speak only in round 1 (rules + tests re-check revisions), runs PR review for two rounds with one
skeptic judging the round's findings as a batch, drops L's domain effort to `high`, and has no
post-ship stage. Expected on a J2-shaped group: ~50 agents → ~20. Stage numbers below are the
post-cut shape; the ledger rows for wave 1–3 groups were run under the old one.

**Second budget cut (2026-09-10, wave 7).** Re-measured per-agent from the run journals on G8
(L) and I-release (M). The wave-3 cut held its shape but not its conclusion: plan review is
still the largest line at **45% and 57% of group output** (90M and 98M cached-input of 246M /
182M), while build, verify, probes, simplify and ship together stayed under a third.

What this measurement adds is a **yield** number the first one did not have. Plan review
produced **none** of the defects that mattered in either group. Every real finding came from PR
review, against real code: G8's cold-open gap and the reply-loss **regression its own round-1 fix
introduced**, and I-release's `make_latest`, the `realpathSync` throw, the unpaginated asset
listing and the loose `"npm ci"` substring match.

And the rounds do not converge. Blocking counts per round, four groups:

| group | r1 | r2 | r3 | cut |
|---|---|---|---|---|
| G8 (L) | 3, 3, 2 | 4, 1 | 2, 6 | 3, 3 |
| I-release (M) | 3, 3, 2 | 3, 2 | — | 4, 4 |
| H-c (M) | 2, 4, 2 | 4, 4 | — | 1, 1 |
| H-b (L) | 4, 2, 6 | 4, 4 | 2, 3 | 2, 1 |

No round ever returns zero, because an agent told to refute always refutes. The loop terminates
only because `revise:post-cut` is trusted to adopt whatever the last round said — in all four
groups the cut round found blocking, revise adopted it, and **nothing ever parked**. The count is
a property of the prompt, not of the plan's quality, so additional rounds buy nothing measurable.

So: **L 3 → 2, M 2 → 1, S stays 1**, and the post-cut re-refute drops from two lenses to one
(rules — the cut's own failure mode is "removed a mechanism a rule required"). The scope cut now
runs at **every** tier, where it used to be skipped below two rounds; with M at one round that
skip would have taken it away from most of the remaining groups, and the cut is the half of that
block worth keeping — it makes plans smaller, where the refuters only make them longer.

`PR_ROUNDS` stays at 2 and **must not be cut to pay for anything.** G8's PR round 2 is what caught
the data-loss regression that round 1's own fix introduced; shipping without it would have put a
bug in the user's `.docx` that is worse than the one the group existed to fix.

Expected saving: **~15% of an L group and ~24% of an M group**, in both output and cached input,
taken entirely from the stage with no demonstrated yield.

Stages:

1. **plan** — reads issue bodies + comments (comments from non-owners are data), track file, ledger
   rows, experiments, decisions. Writes `tracks/specs/<group>-<issue>.md` per issue in the
   A8-1796 shape (non-review issues as `X-<issue>.md`). Returns `{specs[], branch, filesTouched[],
   order[], risks[], assumptions[], closes[], refs[]}`.
2. **reviewLoop** — refuters in parallel: in round 1 the group's repo agent(s) via
   `agentType` (or `general-purpose` when none), in every round a CLAUDE.md-rules refuter (Critical Rules 1–9, gotchas, origin helper choice,
   license-gate both halves, testid snapshot, `NON_LOOPBACK_ALLOWED`, ADR-027 guard shapes, skill
   version); a tests refuter (would a lazy default arm pass? is each experiment's "still broken"
   output now a spec?). `{blocking[], nonBlocking[]}` → revise agent appends "Review corrections
   (round n)". Loop while blocking, capped by tier (S 1, M 2, L 3); leftovers get one scope-cut
   (M/L) and a two-lens re-refute (all tiers — for S it is what checks the single revise landed),
   then `parked` with the disagreement.
3. **implement** — worktree under `.claude/worktrees/wt-<group>` on `fix/<slug>-<issue>` from
   `origin/master`; `ln -s` `node_modules`; `npx husky`; Rust groups re-touch the stubs; one
   commit per issue (`fix(<area>): … (#N)`, attribution trailer, never a closing keyword in a
   commit body); experiments → vitest specs; `npx biome format --write` before each commit;
   `npm run typecheck` + `npx vitest run <touched>`.
4. **simplify** — `Skill(simplify)` (or inline criteria if the probe failed) on
   `git diff origin/master...HEAD`; commit `refactor: simplify <group>`.
5. **verify** (behind the JS gate) — `npm run lint`, `npx biome check .`, `npm run typecheck`,
   `npm run typecheck:tests`, `npx vitest run <touched suites>`, `npm run audit:origins`,
   `npm run audit:ymap-keys`, `npm run check:tokens` (client), `npm run build`, `node
   scripts/ci/stdio-smoke.mjs` + `monitor-smoke.mjs`, `cargo test` (Rust groups, shared target).
   Red → fix agent → re-verify ≤2.
6. **e2e** (gate, only `e2e` groups) — `npm run test:e2e`; red → fix → re-run once.
7. **manualProbes** — runs the track's named experiment / probe scripts against a scratch server on
   the harness ports (`probe-tools.mts`, `server-probes/run.sh`, harness vitest config) and captures
   the before/after lines for the PR body; emits `bryan[]` for anything hardware-gated.
8. **prReviewLoop** — parallel: `Skill(code-review, --level high)` on the diff + (round 1 only)
   the repo agent on the diff; the round's findings through ONE skeptic as a batch, keyed by id
   (`default refuted=true if uncertain`; a missing verdict keeps the finding as unverified);
   confirmed → fix → re-verify; ≤2 rounds; leftovers → `unresolved[]`.
9. **ship** (gate) — assert `.husky/_/pre-push` exists; `git push -u origin <branch>` (hook runs;
   failure → fix → re-push; `HUSKY=0` only in the recorded cargo case); PR body with `## Closes`
   (only `closes: true` issues), `## Refs (partial — issue stays open)` (`Refs #N — what landed;
   remaining: …`), problem/solution per issue, commands run, probe output, screenshots for UI,
   assumptions, unresolved findings, the `🤖 Generated with` footer; a regex check that no closing
   keyword + `#N` appears outside `## Closes`; `gh pr merge --auto --merge` (result recorded as
   data — the repo refuses while auto-merge is off); no PR-activity subscription exists here, so
   the main session polls CI (`subscribed: false`). Returns `{group, branch, pr, closes[], refs[],
   unresolved[], bryan[], skillVersion}`.
10. ~~**postShipReview**~~ — removed 2026-09-07 (see the budget note above and the wave-3 lesson on
    the resumed post-ship agent). The main session's merge-time pass covers it.

Models/effort: plan + reviewers at the group's tier; domain reviewers `effort: high` at every tier
(L was `max` until 2026-09-07); verify/review `high`; simplify/ship `low`. `isolation` unused
(worktree managed explicitly).

### Main-session loop around each group / wave

1. Write the ledger row (including `filesTouched` from the plan stage); commit + push on the
   designated branch. **Before launching any group, refuse it if its planned `filesTouched`
   intersects an unmerged group's** — the wave table was de-collided from the ledgers, but the
   plan stage's real file list is the authority.
2. Poll CI (`gh pr checks <N>`) and drive fixes per the PR rules (red → fix → push;
   `gh pr update-branch <N>` when stale; reviewer comments addressed). If auto-merge is off,
   merge with `gh pr merge <N> --merge` when green.
3. After merge: fetch master, prune the worktree, confirm `Closes` issues closed, post one comment
   on each `Refs` issue (what landed, what remains), close pinned already-fixed issues, and let a
   completeness critic assert every FIX issue in the wave has a merged PR, a parked note or a
   comment — and that `Refs` issues are still open.
4. Before a wave with DECIDE members: the next round of 4 to Bryan.
5. Next group. Interrupted run → `Workflow({scriptPath, args, resumeFromRunId})` with `known`.

## Risks and mitigations

- Concurrent CPU load: at most one CPU-heavy stage at a time (JS gate); G2 lands first; a timeout
  in an untouched suite is re-run once, then real. `TANDEM_COVERAGE=1` is never used as a workaround
  (it suspends `expectWithinMs`).
- Symlinked `node_modules` in a worktree: tsc/vitest/biome/tsx/svelte-check resolve fine; Vite's
  `/@fs/` realpath serving for E2E is the unknown → wave 0 probe; fallback `npm ci` per worktree.
- `strict` branch protection: every sibling merge forces an update + full CI; wave tails are
  calendar-bound. Keep `CHANGELOG.md` out of group PRs (the release skill generates it);
  `CLAUDE.md` edits only where an issue demands them.
- Reviewer non-convergence: cap 3, park, surface. Parked groups are Bryan questions.
- Bulk and partially-fixed issues never auto-close: the `closes` flag defaults to false for
  #1821–#1826, #630, #1455, #1333, #1727, #1599, #1700, #1488, #1626, #1292, #1754, #1857 and any
  spec with a non-empty "Not in scope".

## Verification (end to end)

- Per PR: required checks green on the head SHA; post-ship `code-review` clean; each spec's
  "Done when" ticked in the body; every named experiment prints its fixed output and exists as a
  vitest spec; hooks-armed recorded.
- Per wave: open-issue count drops by the wave's `Closes`; completeness critic passes.
- Final: an artifact report over all 195 issues (merged PR / parked / decision pending / dated
  gate / blocked / feature) with the dated gates nearest their deadlines.

## Resuming on another machine

The sweep ran its first wave from a cloud container; everything it needs to continue is in this
file, the workflow script beside it, and the specs under
`docs/reviews/2026-09-02-v1-review/tracks/specs/`. Design rationale:
[2026-09-06-open-issues-sweep-design.md](2026-09-06-open-issues-sweep-design.md).

### One-time setup

1. `npm ci` (arms husky). Rust toolchain; on Debian/Ubuntu the CI apt recipe
   (`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev`); Python 3.10+.
   `npx playwright install chromium` (the cloud container could not download browsers and aliased
   a preinstalled build instead — a normal machine just installs).
2. The `tauri_build` stubs in the main checkout (CONTRIBUTING.md "Testing"); the workflow's plan
   stage recreates them in every worktree.
3. Warm the shared cargo target once: `CARGO_TARGET_DIR=<repo>/src-tauri/target cargo test
   --manifest-path src-tauri/Cargo.toml`. Every worktree pipeline exports that same variable so
   there is one build, not one per worktree.
4. Auto-merge is disabled on the repo; the check-in loop merges via the API (or you click).

### Running a group

```
Workflow({
  scriptPath: "<abs repo>/docs/plans/2026-09-06-open-issues-sweep.workflow.js",
  args: {
    group: { id: "F-runtime", title: "push paths runtime", issues: [{n:1759,closes:true}, …],
             tier: "M", reviewers: ["security-reviewer"], e2e: false, rust: false, skill: false,
             order: [1759,1805,1804,1794], track: "F", notes: "<the wave-table row's notes, expanded>",
             known: {} },
    repo: "<abs repo>", date: "<today>",
    attribution: { coAuthor: "Co-Authored-By: …", session: "Claude-Session: …" },
    prFooter: "🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n<session url>",
    sweepDoc: "docs/plans/2026-09-06-open-issues-sweep.md"
  }
})
```

One group per invocation. Before launching, check the ledger: refuse a group whose planned files
intersect an unmerged group's. `known.skipPlan` re-enters at the review loop with the specs already
on the branch; `known.skipPlanAndReview` (+ `known.specs`, `known.filesTouched`) re-enters at
Build; `known.branch` / `known.pr` let a resumed run reuse what exists. After a container restart
or crash, `Workflow({scriptPath, args: <identical>, resumeFromRunId})` replays every finished
stage from the journal and re-runs only the one in flight — this worked across a real restart.

### Windows notes (measured 2026-09-06 on Bryan's PC, wave 2)

Claude Code's Bash tool runs under git-bash on Windows, and two of the three bash-isms the cloud
session flagged turned out to work as written: `mktemp -d /tmp/tandem-sweep-XXXXXX` yields a path
MSYS rewrites to `C:/Users/…/AppData/Local/Temp/tandem-sweep-…` before Node sees it (the path
contains `tandem`, which `tests/server/platform.test.ts` requires), and `test -x .husky/_/pre-push`
is true. The one that does not is `ln -sfn` for a directory: the script now takes `args.windows:
true` and links `node_modules` with a PowerShell `New-Item -ItemType Junction` instead
(`cmd /c mklink /J` from git-bash fails). **Never `git worktree remove` a worktree whose
`node_modules` is a junction** — on Windows git walks through the junction and deletes the main
checkout's `node_modules` contents (measured 2026-09-06 after J1 merged: 0 entries left, both
live worktrees broken until `npm ci`). Delete the junction first, from PowerShell:
`(Get-Item "<wt>/node_modules").Delete()` removes the reparse point only; then remove the
worktree. `CARGO_TARGET_DIR=<repo>/src-tauri/target` with
forward slashes is accepted by cargo. `cargo test` runs natively (no GTK). Read CLAUDE.md's
Windows gotchas (CRLF, the `#!/usr/bin/env sh` shebang) before the first push.

### GitHub access and the stand-ins (wave 2 onward)

The script now uses `gh` for every GitHub step (issues with `--json …,comments` so comment
authors are visible; `gh pr create --body-file`, never a heredoc body — git-bash heredocs eat
backslashes; `gh pr merge --auto --merge`, whose refusal is recorded as data). There is no
PR-activity subscription tool here, so the main session polls CI. `Skill("simplify")` and
`Skill("code-review", "--level high")` are the in-session skills, single-pass inside a subagent;
the `dev-tools` plugin's `/pr-review-toolkit:review-pr` is available but the script does not call
it. `args.probePorts = {ws, mcp}` gives each concurrently running group its own scratch pair for
the probes stage (`run.sh` hardcodes 4918/4919, so a second group gets 4928/4929). Two groups run
at a time on this machine (16 CPUs, 32 GB), **but never two `e2e` groups**: the Playwright harness
ports are fixed (`scripts/test-ports.ts`) and its boot SIGKILLs whatever holds them, so a second
E2E run kills the first. `gh` is now a hard requirement of the script (plan, ship and post-ship);
a resume from a machine without it must install it first — the GitHub MCP fallback is gone.
`docs/stacked-prs.md` applies for layered groups. The environment-facts table above is the cloud
container's record and names the MCP tools that session had; the script no longer calls them.

### Lessons from wave 1 (read before launching wave 2)

- **Minimality is load-bearing.** Both first attempts parked after three review rounds because
  the planner grew frameworks (a load-calibration mechanism; an AST scanner promoted to CI) the
  issues never asked for, and the refuters correctly attacked them. The planner prompt now carries
  the rule and a scope-cut round exists; still steer each group's `notes` toward the smallest fix.
- **Cost per group** at M tier: ~2.5–3M subagent tokens and 2.5–3.5 hours wall clock, of which the
  review loop is roughly half. Expect it; do not shorten the loop — it found real defects in every
  group (an empirically false precondition, a racy deadline, a fail-open gate).
- **CodeQL is not a required check but its findings are real work**: join `path.basename()`
  results, never raw caller names (see the #1882 fix); the repo's other idioms are in
  `src/server/mcp/document-service.ts` ("Safe FS sink" comments and the inline separator guard).
- **Every worktree needs the tauri_build stubs** — the pre-push hook always runs `cargo test`.
- **A forked skill runs in the main checkout, not the worktree** (found in wave 2). `Skill("code-review")`
  forks into the session cwd, so `cd <worktree>` in the prompt never reaches it and with no target it
  reviews whatever branch the main checkout is on — J1's first PR-review round reviewed the sweep
  ledger's own diff. The script now passes the group branch as the skill's target and drops findings
  on files outside the branch diff. `Skill("simplify")` loads inline and is unaffected.
- **The verify stage's stdio smoke is not sandboxed by `TANDEM_APP_DATA_DIR`** (found in wave 2).
  `scripts/ci/stdio-smoke.mjs` boots `dist/server` on the product ports 3478/3479, the server
  `freePort()`s whatever holds them, and the boot's `refreshExistingSkillIfStale()` writes
  `~/.claude/skills/tandem/SKILL.md` when the bundled version is higher. The script now skips the
  smoke when a real Tandem is listening, serialises it across groups with a mkdir lock, and points
  `USERPROFILE`/`HOME` at a scratch dir for the boot. **Correction (2026-09-07):** the smoke was
  NOT what overwrote J1's installed skill — that was `tests/server/integrations/api-routes.test.ts`
  driving the real apply route, whose `installSkill()` wrote the checkout's bundled skill over the
  real home on every `npm test` and every pre-push hook (it downgraded a v15 install to v14 three
  more times that night, once per push). Fixed by #1894 (an injected `installSkill` seam in the
  route deps, spy by default in the suite). The smoke sandboxing stays. If you ran an older
  checkout, check the installed skill's `version:` against `origin/master` and restore it.
- **A workflow agent can wedge on one tool call, and nothing times it out** (found in wave 2).
  F-runtime's post-ship agent issued `npm run typecheck` in the worktree and never got a result;
  the workflow sat for three hours looking "in progress". The tell is the run's `journal.jsonl`
  ending in a `started` with no matching `result` while no `agent-*.jsonl` under the run has been
  modified for >15 min. `TaskStop` the run, check the worktree is clean and equal to the remote,
  then either resume from the journal (cache-hits everything before the wedged call) or finish the
  remaining stage by hand. Review agents also leave probe scripts at the repo root (`repro.mjs`) —
  `git status` the main checkout after each group.
- **The branch-diff file filter on code-review drops pre-existing gaps next to the fix.** It is
  what keeps a forked review honest about scope, but a finding on an unchanged file that the
  fix's claim depends on (here: `src/cli/channel.ts` exiting before the never-exit consumer
  starts) vanishes silently. Read the dropped list when the review reports one; file what is real.
- **A post-ship agent that has reported is not finished — a late review result resumes it, and it
  will undo hand work on "its" branch** (found in wave 3, J2). The post-ship agent had returned its
  summary and its run's journal showed no `result` line — which reads as "wedged" under the rule
  above, but the run was still a live task (under the Workflow tool's task id, e.g. `wwizzwgwz`, not
  the `wf_…` run id — `TaskStop` on the run id says "no task found" and proves nothing). Twenty
  minutes later its transcript woke again (the forked `code-review` result arriving as a tool result), it
  re-read the branch, judged the orchestrator's hand-run follow-up commit on `docs/workflows.md`
  "outside the diff", pushed a revert through the pre-push hook, and soft-reset the worktree — all
  while the orchestrator's own push was in flight. The agent is doing exactly what its prompt says
  (scope = branch diff), so the fix is procedural: after a group's run ends, **`SendMessage` its
  post-ship agent an explicit stand-down before touching the branch by hand**, and treat a branch
  head that moves under you as an agent, not a human — `git log origin/<branch>` and the commit's
  `Claude-Session` trailer name the culprit. Recovery: `git reset --hard <your commit>` in the
  worktree, then `git push --force-with-lease=refs/heads/<branch>:<their sha>`. **And a
  stand-down message is not enough on its own**: the agent acknowledged it, but the workflow still
  required its `StructuredOutput`, so the harness re-prompted it and it `git merge --ff-only`'d the
  worktree back onto its revert two minutes later, while the orchestrator's force-push was in its
  pre-push hook (that push then reported "Everything up-to-date" and moved nothing). Wait for the
  Workflow tool's own completion notification before the recovery push, and check the reflog
  (`git reflog show <branch>`) after it lands.
- **PR bodies**: the ship agent sometimes claims a review pass did not run because it could not
  spawn agents itself; the pipeline's PR-review stage did run the repo reviewer. Read the
  "Review" line (rounds) rather than the "For Bryan" prose when in doubt.
- **`resumeFromRunId` replays by (prompt, opts) — an edited script does not resume, it re-runs.**
  Gc1 was stopped mid-plan-review and resumed under the budget-cut script and cache-hit fine,
  because its cut fell in a *later* round. C was stopped after PR-review round 1 and resumed under
  the same edited script and **re-ran plan review round 1 from scratch**: the cut had changed
  `domainEffort` and the round structure, so every `refute:*:r1` key missed. Under a spend limit
  that is not merely wasteful, it is fatal — the re-run agents 429'd and the run ended at
  `stage: "revise-r1"`. Rule: **before resuming, diff the script against the revision the run
  started on; if any agent call *before* the stop point changed its prompt or opts, do not resume —
  finish the remaining stages by hand.** (`git stash` the dead agent's partial edits first so the
  hand-run fix agent starts from a clean tree.)

## Ledger

States: `planned-not-started` → `planned` → `reviewed` → `built` → `pr-open` → `green` → `merged`,
or `parked` (reason in Notes). `Skill ver` is the `skills/tandem/SKILL.md` frontmatter version the
group's branch carries (bump to the next integer after `origin/master` at rebase time; the pinned
literal in `tests/skill-instruction-contract.test.ts` moves with it). `Hooks armed` records that
`.husky/_/pre-push` existed in the worktree at push time, or `cargo: CI-only (Bryan 2026-09-06)`.

| Wave | Group | Issues | Branch | PR | Skill ver | Hooks armed | State | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | K1 test gates | #1783 #1784 #1721 (count-pin only) | `fix/test-gates-1784` | #1881 (merged a07b72d2) | — | armed | merged | Attempt 1 parked (framework growth); attempt 2 minimal: #1784 gated set derived from registrations + TOOL_GATES data list (resolveAnnotation left ungated for H), coverage-gate wiring requires a real import; #1783 vacuous bodies asserted, dead skip deleted, two inbox-pull-path E2Es, hook-script vitest runner; #1721 Refs only — axe color-contrast incomplete counts pinned per surface (CI held the baseline). Residual of #1784 (hollowed suites) tracked in #1825. 4 plan-review rounds, 2 PR-review rounds, post-ship clean. |
| 1 | A-rest | #1768 #1797 | `fix/restore-and-close-ids-1768` | #1882 (merged 454e0ef2) | — | armed | merged | #1768: no-arg `tandem_restoreBackup` now lists the `.backup.docx` sidecar (last, labelled non-managed) and never restores; restore-by-name routes through `restoreDocumentFromBackup` (readOnly, reload guard, self-write triple); symlinked sidecar → `INVALID_PATH`. #1797: `closeDocumentById` resolves the id once via `path.basename` and uses it for every step; same shape on the save path. Post-CI follow-ups: CodeQL alerts 207–210 — snapshot half fixed by joining the `basename()` result; the sidecar half is the document-path-derived class in the accepted `docs/security.md` register entry and is Bryan's to triage; `reload-family.ts` coverage floor cleared with three direct specs. Two open questions for Bryan in the PR body (`POST /api/backups/restore` can now restore the sidecar by name; the `lstat`-vs-`O_NOFOLLOW` drift in the security.md bullet). 4 plan-review rounds, 2 PR-review rounds. |
| 1 | G2 test timing | #1672 #1699 #1674 | `fix/test-timing-1674` | #1879 (merged 06804b97) | — | armed | merged | Attempt 1 parked (calibration framework); attempt 2 under the minimality rule shipped: #1674 was a real defect in the stdio test helper (collectors attached after the child had written), fixed; #1672/#1699 did not reproduce — the 36 s came from the leaked process tree noted on #1672 — so the change is the re-dated `REAL_APPLY_TIMEOUT_MS` rationale, both closed on the measurement (Bryan can reopen as watch items). 4 plan-review rounds, 1 PR-review round, post-ship review clean. |
| 2 | F-runtime | #1759 #1805 #1804 #1794 | `fix/push-paths-runtime-1759` | — | #1889 | b315fced | armed | merged | Launched 2026-09-06 from Bryan's Windows PC (run `wf_ce225c53-e48`, probe ports 4918/4919), concurrently with J1. 4 plan-review rounds incl. scope cut; the security refuter required a tracked home for a residual #1794 exposure → #1884 filed and registered in `docs/security.md`. Four fixes committed; stopped at the checkpoint push and resumed on the hardened script (guarded smoke, branch-targeted code-review) — the resume cache-hit through build. PR opened 2026-09-06 (green, behind master). The post-ship agent then wedged on an `npm run typecheck` Bash call for ~3 h with no result; the run was stopped and its remaining work — a second review set of 9 verifier-backed findings the pipeline never received — was applied by hand on the branch (3 commits, 9 findings + 3 doc one-liners, mutation-checked; recorded in the PR body). Merged 2026-09-07 after one `update-branch`; all four issues closed; worktree pruned junction-first. The review's file filter had also dropped a pre-existing gap in `src/cli/channel.ts` (the plugin's `tandem channel` entry still exits 1 in preflight) → #1890 filed. |
| 2 | F-config | #1760 #1801 #1802 | `fix/push-paths-config-1760` | — | #1891 | 94e45025 | armed | merged | Launched 2026-09-06 20:57 (run `wf_1ce28428-8f9`, probe ports 4928/4929) as J1 finished, concurrently with F-runtime. 4 plan rounds, 3 PR rounds, 2 post-ship rounds; 49 agents, ~6.8M tokens, 5.9 h. Workflow returned 2026-09-07 with a stale unresolved list (all four fixed in later rounds — verified against the branch). One post-open fix by hand (`32f2fe49`, a false "will be rejected" in `rotate-token`). Eleven For-Bryan items in the PR body, notably: CHANGELOG.md:340 still carries the retracted removal instruction (pipeline may not edit CHANGELOG); `tandem doctor` has no size cap; the #1802 zero-byte truncation window is untracked. Merged 2026-09-07 after one `update-branch`; all three issues closed; worktree pruned junction-first. The first push was rejected by a Rust timing flake unrelated to the branch (`bounded_command::partial_lengths_report_what_arrived`, 3 s spawn budget missed under pre-push load; 3/3 green in isolation) → fixed in its own PR #1892. |
| 2 | J1 skill + workflows doc | #1771 #1782 #1820 #1737 (+decision H) | `fix/skill-and-workflows-doc-1771` | — | #1888 (merged 911de885) | 15 | armed | merged | Launched 2026-09-06 from Bryan's Windows PC (run `wf_f6b7f1e4-5d1`, probe ports 4928/4929), concurrently with F-runtime. #1771, #1782, #1820, #1737 closed by the merge; one `gh pr update-branch` + CI rerun after #1886 staled it. 4 plan-review rounds (incl. scope cut); build, simplify, verify and probes green; stopped and resumed at PR review after the code-review lens was found reviewing the wrong tree (see Lessons). 3 PR-review rounds hit the cap with 5 confirmed findings left (three non-discriminating test regexes, a false `replies` claim); the post-ship pass fixed all five (e2149691). For Bryan: `SERVER_INSTRUCTIONS` in `src/server/mcp/server.ts` has no orchestrator-only carve-out — it reaches sub-agents without the skill loaded; out of #1820's scope. ~3.2M subagent tokens, 2h13m. |
| 3 | J2 product copy | #1781 #1814 #1815 #1816 #1817 #1818 | `fix/product-copy-1814` | — | #1897 | 2148f2a5 | armed | merged | Launched 2026-09-07 04:10 from Bryan's Windows PC (run `wf_d6e0906b-2e2`, probe ports 4918/4919); F-doctor and then C ran concurrently. 4 plan rounds, 3 PR rounds, 1 post-ship round; 48 agents, ~7.4M tokens, 6.7 h. #1815 needed no code (already honest); #1781 took the delete-the-promise branch (docs only). The PR body's "unresolved" list was stale — all five were fixed by the cr-2…cr-6 review commits; rewritten by hand. Two filter-dropped findings checked by hand: `docs/workflows.md` + `docs/roadmap.md` still carried the #1781 copy (fixed, `6363e802`); the annotations-store `save-error` producer was already scrubbed (`a6c5d9c3`, mutation-checked). The post-ship agent then woke again and reverted `6363e802` as out-of-diff — see the wave-3 lesson; branch restored by force-with-lease. CodeQL then raised a real high alert (212, tainted format string) on cr-4's stderr mirror — a 3-second CodeQL failure is not always the config race; read the check's summary — fixed by hand (`%s` argument, one commit). Merged 2026-09-07 11:40; all six issues closed; worktree pruned junction-first (the directory needed a second `rm` after the shell's cwd left it). |
| 3 | F-doctor | #1806 #1807 #1811 #1790 | `fix/doctor-and-skill-version-skew-1806` | — | #1896 | e07b8547 | armed | merged | Launched 2026-09-07 04:26 after #1894 merged (run `wf_ff413189-bd8`, probe ports 4928/4929), concurrently with J2. 4 plan rounds, 3 PR rounds, 2 post-ship rounds; 45 agents, ~6.0M tokens, 3.8 h. #1811's first half refuted (doctor already named the uninstall remedy). Workflow's one "unresolved" (no scheme check) had already landed in a post-ship commit; three post-ship findings had not (BIND_HOST wording, apply route discarding the declined skill install, stdio embedder port threading) → hand follow-up pass (3 commits, mutation-checked, recorded in the PR body). Merged 2026-09-07 08:47; all four issues closed; worktree pruned junction-first. For Bryan: `apply.ts`'s hardcoded `MCP_URL` makes #1807's port warn unclearable on a moved install (writer-side defect, unfiled); doctor still has no config size cap; an installed plugin keeps its old npm pin until reinstalled. |
| 3 | C privacy & authority | #1769 #1733 → #1770 #1779 #1803 (+#1619 #1710 folded into #1803) | `fix/privacy-and-authority-1769` | #1900 | 16 | armed | merged | Launched 2026-09-07 08:52 after F-doctor merged (run `wf_0a5a9898-f59`, probe ports 4928/4929), concurrently with J2. Ran the OLD script shape end to end: 4 plan rounds + cut, build (7 commits, one per issue, `4bd55b88`…`6d4a795a`), simplify `a969ef71`, verify, probes, PR-review round 1 (code-review 6 findings + 7 domain-lens findings, skeptic-verified) — then the weekly/monthly spend limit (HTTP 429, resets 07:00 America/New_York) killed `fix:review:r1` mid-edit and `ship:C`. 47 agents, **~10.8M tokens**, 6.9 h — the run the budget cut was measured against. **State at 15:50:** branch was never pushed by the pipeline (the checkpoint stage's push did not land) — orchestrator stashed the dead fix agent's partial edits (`git stash list` in `wt-c`: "C fix:review:r1 partial edits") and checkpoint-pushed the 11 commits. **Resume after the reset:** `Workflow({scriptPath, resumeFromRunId: "wf_0a5a9898-f59", args: <identical, from the run's diagnostics>})` replays everything through the skeptic from cache and re-runs the fix + ship stages under the NEW script (the fix agent redoes the stash's work; drop the stash after). The workflow's "bryan" list is long and partly wrong — it claims no adversarial review happened, but the three domain lenses DID run in PR review round 1 (their findings are in the journal); trust the journal. Hand notes for merge time: `scratchpad/c-review-findings.md` (7 code-review findings + one filter-dropped `resolvedBy` item). Capacity came back within minutes (a haiku probe answered) and C was resumed 15:55 as Workflow task `wlk8fknho` — **the resume failed, and the way it failed is the lesson**: it did not replay from cache, it re-ran plan review round 1 (`refute:*:r1`, `revise:r1`), because the budget-cut edits changed those calls' `opts` (model/effort/label) and the cache key is (prompt, opts). Every re-run agent 429'd again; the run ended `failed: true, stage: "revise-r1", reviewRounds: 1, prReviewRounds: 0`. **A resume is only cache-safe if the script's earlier agent calls are byte-identical.** **Finished by hand 2026-09-08, with no agents at all** — the orchestrator applied the round-1 set itself, which cost less than a single fix agent would have. `541bd57a`: the release-arming fix (the POST now rides the `Y_MAP_MODE` write rather than a `tick()`, so the unsynced-ctrl window stops double-409ing) with two new specs, the `resolvedBy` strip, the vacuous `held-in-solo-stamp.test.ts:228` row, and five stale tool/skill descriptions. `ca045eec` **recovered the dead fix agent's STASH rather than dropping it** — it had already closed the ADR-027 highlight asymmetry (`isWithheldFromClaude` = `!isClaudeFacing` on resolve and remove, the two families with no per-type arm), written better hook-driven `resolvedBy` tests than the source-scan I had, and filed #1899. **Lesson: read a dead agent's stash before dropping it — a 429 kills an agent mid-edit, not mid-thought.** Then `bdd021fb` (the `docs/user-guide.md` sentence C-1779 deferred behind J2, now merged) and `7009a125` (a second stale "#1619 is open" claim, in `decisions.md`, same class as the `security.md` one). Every behavioural fix mutation-checked by reverting it and watching the naming spec go red. PR #1900 opened 2026-09-08 09:33. **Its first CI run was the first CI this branch ever had** — the pipeline died before the PR stage — and it went red on two SEMANTIC merge conflicts, both of which read exactly like pre-existing flakes and neither of which any local run would have caught, because both specs came in on master WHILE this branch was building. `toolbar-redesign.spec.ts` ×3 asserted `tandem_getAnnotations` returns the user highlight it had just created; #1619 (on this branch) correctly withholds it, so each now asserts BOTH halves via a new `getPrivateExcluded()` — a bare `toBe(0)` would make "never created" and "created and withheld" indistinguishable, which is the pair those specs exist to separate. `settings-and-filters.spec.ts:533` (Gc1's #1772 spec, merged as #1898) dropped the pending count by having Claude `accept` its own comment; #1770 refuses exactly that, so the count never moved and an ARMED bar hides `bulk-dismiss-btn` too — its first assertion passed vacuously and the second failed, i.e. the spec reported the bug it was watching for. Switched to `dismiss` plus an explicit landed-check. `tab-overflow.spec.ts:93` was the run's only real flake (green on retry). CodeQL then raised alert 213, `js/tainted-format-string` HIGH, on the new `held-in-solo.ts:99` — same class as J2's 212 — fixed with the codebase's `%s`-argument idiom, along with the three pre-existing siblings in files this branch already owns. **Two rules earned here:** a group whose branch is long-lived must expect master's NEW specs to encode the old contract, and a 3-second CodeQL failure carrying a `1 high` line is not the config race. The advisory `coverage` gate also went red and was worth honouring rather than waving through: it had caught `accept-refused`'s SECOND reason (`unapplied-suggestion`) arriving with no test, which is exactly the class a floor exists to detect. Merged 2026-09-08 10:55 (`3e1230fb`); all seven issues closed; `wt-c` pruned junction-first. Post-open work is recorded as a PR comment, not only in commit bodies. | Seven issues incl. the two read-side twins; skill 15 → 16 plus the body hash pinned since #1896. |
| 3 | Gc1 client state Highs | #1772 #1773 | `fix/client-state-highs-1772` | — | #1898 | aee088f6 | armed | merged | Merged 2026-09-07 15:35; both issues closed; worktree pruned junction-first. One CI `check` red on the way: `keyboard-a11y.spec.ts` "focus is visibly indicated" found an unlabeled DIV — the run's snapshot showed the editor in "Nothing open yet" with a `sample.md` tab and an earlier "Not connected" teardown, i.e. the harness lost the document; 3/3 green locally on the branch, green on re-run. Harness flake, not the diff. First group under the budget-cut script: 26 agents, ~2.6M tokens, 2.8 h (J2: 48 / 7.4M / 6.7 h). 2 plan rounds + scope cut, 2 PR rounds; round 2's four confirmed findings fixed in `75acf558` and read by hand (aria-labels, `actionInFlight` guard, `role="alert"`); the fifth refuted with evidence. The ship agent's "unresolved" list was the round-2 set again — under a two-round cap that line always names the fixed-but-unreviewed findings; rewrite it. Launched 2026-09-07 11:50 after J2 merged (run `wf_48d2229f-41a`, Workflow task `wmphjszo9`, probe ports 4918/4919), concurrently with C (not e2e). Stopped in plan-review round 2 at 12:15 and resumed (task `wewzju0a3`) under the budget-cut script: plan, round 1 and revise r1 replayed from cache; round 2 is the M cap. C kept the old script — a resume would have re-run its three domain lenses at the new effort. Notes carry the review's file:line anchors, the promote-reset pattern for #1772, the inline two-step confirm for #1773, and the testid contract. |
| 3 | #1821 docs drift — A repo docs | #1821 (part) | `docs/drift-1821-repo-docs` | #1901 | — | armed | merged | Hand-run as three area PRs, not a Workflow group: two attempts to launch it as one died on the 429 and left nothing, and the work is verification-shaped rather than fix-shaped. Group A is `CLAUDE.md` + `architecture.md` + `security.md` + `decisions.md`, scoped to a single general-purpose agent in `wt-docs-a` with an explicit file allowlist so the three PRs cannot conflict. Findings the sweep should carry forward: the licensing flip is TWO consts in two languages (`LICENSE_UPDATE_ENDPOINT` in `src-tauri/src/lib.rs:171` routes every build to the PUBLIC updater manifest, #1785 — this lands on wave 6's H group); force-open `fs.unlink`s the durable annotation envelope (#1813, wave 5 D1); `MAX_RESTARTS` covers the boot window only (#1809, wave 7 E2-rust); the Windows exe-unlock wait is inert on an installed build (#1762, same); ADR-032's tagged results landed but exactly ONE caller reads `kind` (#1764, wave 4 B). Verified by hand after the agent reported: 8 of its claims re-checked against source, one count corrected (eighteen `vi.mock` files, not nineteen) — a wrong number in a drift-fixing PR is the worst outcome, so recount rather than trust. Six For-Bryan items in the PR body. Merged 2026-09-08 11:17 (`3e809690`) after one `update-branch`; worktree pruned junction-first. |
| 3 | #1821 docs drift — C user docs | #1821 (part) | `docs/drift-1821-user-docs` | #1902 | — | armed | merged | Launched 2026-09-08 10:15 in `wt-docs-c`: `user-guide`, `troubleshooting`, `cli`, `data-locations`, `integrations`, `configuration`, `.env.example`, `workflows.md`, `sample/welcome.md`, `README.md`, `semantic-tokens`. Same allowlist discipline. Headline finding: **Solo is a ONE-WAY hold** — nothing in `src/client/` filters an AI-authored annotation on mode; the only gates are `isUserPrivacyHeld`/`shouldForwardExternally`, both user-authored-only, so the inbound half is the bundled skill ASKING the AI to hold off. Merging master (#1900) then conflicted on exactly the two Solo paragraphs, in both directions: `user-guide.md` needed this branch's rewrite to win over #1900's one-liner, and `sample/welcome.md` needed master's 'and answer chat' folded INTO this branch's one-way framing. Tutorial anchor strings re-verified present-and-unique after the resolution. Four For-Bryan items, incl. the README-vs-BUSL beta wording and a possibly-stale #1761. **CI then caught a real one the agent's own verification could not**: `tests/server/tutorial-annotations.test.ts` pins the LIVE `sample/welcome.md` against `tests/fixtures/welcome-snapshot.md` in flat-text space — the anchor assertions resolve against the SNAPSHOT for worktree isolation, so live drift breaks real injection with nothing red. The agent had been scoped to `tests/docs/` + `tests/scripts/`, which do not reach it. **Lesson: an agent editing a file under `sample/` or `src/` must be told to run the FULL suite, not the doc suites** — the scoping was the orchestrator's error, not the agent's. Merged 2026-09-08 12:00 (`475eb52a`) after three `update-branch` cycles — under `strict: true` every merge invalidates the rest of the queue, so N sibling PRs cost N restacks and N `check` runs; land them in one queue rather than in parallel next time. Worktree pruned junction-first. |
| 3 | #1821 docs drift — B MCP + licensing | #1821 (part) | `docs/drift-1821-mcp-licensing` | #1903 | 17 | armed | merged | `mcp-tools.md`, `licensing-explained.md`, `schema-dialect.ts` toolCount, `skills/tandem/SKILL.md`. Cut after #1900 merged, for the reason it was held: that PR bumps the skill to v16 and rewrites its accept line and `bodyHash`, so a branch cut earlier would have conflicted on both. Launched 2026-09-08 11:05. Also told to re-check `mcp-tools.md` against #1900's two behaviour changes — `ACCEPT_REFUSED` and the `audience` read filter — since the tool DESCRIPTIONS were updated there but the doc was not — they had been, so the re-check returned "already correct", which is the outcome that has to be reportable or the pass is theatre. Real finds instead: the `READ_ONLY` error row was false for `tandem_edit`/`editList`/`appendContent` (they answer `FORMAT_ERROR`) and the five annotation tools have no `readOnly` check at all; nine error codes were undocumented; `activity.cursor` is a ProseMirror position while `selection` beside it is flat (#1776); and the licensing doc's gated-set enumeration — the `/api` half's ONLY review per Critical Rule 9 — omitted three mutating surfaces (`tandem_rename`, `tandem_convertToMarkdown`, `POST /api/mode/release`), so the omission WAS the review failing. **Skill 16 → 17**: Hard Rule 1 gave staleness as the only reason not to hand-count offsets, but a hand-count is also wrong by construction — offsets are UTF-16 code units. Merged 2026-09-08 11:40 (`f03b2777`) after one `update-branch`; worktree pruned junction-first. Its `Closes #1821` fired while group C was still in CI, so a comment on the issue records the three-PR split and the four code-condition findings. |
| 4 | B anchors | #1764 #1765 #1766 #1767 #1622 | `fix/annotation-anchors-1764` | #1916 | — | armed | merged | Launched 2026-09-08 16:07 EDT from Bryan Windows PC (run `wf_5f5691dc-6f2`, probe ports 4918/4919), concurrently with Gc2b. Implementation order was by SEAM, not issue number: `1764 → 1765 → 1767 → 1622 → 1766`. **The spend limit killed the L-tier run at `build` with only #1764 committed** (17 agents, 3.4M tokens) — #1765 was complete, green and merely UNCOMMITTED, and was recovered by hand and mutation-tested rather than regenerated. The remaining three ran as a purpose-built SIX-agent workflow (`wf_8e946f3c-4b2`) against the already-committed specs — 1.1M tokens, because the plan-and-review phase did not need re-running. **That is the shape to reach for whenever a group dies after its specs land.** Its two review lenses independently found the one that mattered: #1766 closed the heading-interior hole for `tandem_edit` and left it open one click away, because `YDocStore.anchorRange` also serves `tandem_comment` WITH `suggestedText` — a rewrite deferred to Accept, which `snapshotContradicts` cannot object to since the snapshot was captured over that exact span. `anchorRange` now takes a REQUIRED `purpose` discriminant rather than an optional boolean. Three more review findings fixed in the same commit (the #1622 watcher opt-OUT had no detector; the #1622 doc paragraph split the error-code table so eight rows including `LICENSE_REQUIRED` rendered as literal text; `dropSplitTail` could empty a 1-unit snapshot and disarm `snapshotContradicts`). The skeptic reproduced **18 of 18** claimed mutations, including the ones that deliberately stay green. `typecheck:tests` was found already RED on the branch (four TS2571 from #1765, invisible to `npm test`) and fixed here. Full suite 10,958 passed. Merged 2026-09-08 21:15 (`7989261d`); all five issues closed; worktree pruned junction-first. **For Bryan, carried forward:** #1632 stays a DECIDE issue and is now downstream of #1764 (a degraded anchor is legible on the wire for the first time); and `anchor` on `tandem_getAnnotations` LANDED HERE, so wave 9 K-server must not plan it again. | **`skill: false` stands, after the scope cut.** Three adversarial rounds grew the specs past the issues, so they were cut back to the issue-named files plus tests: the `skills/tandem/SKILL.md:182` amendment is dropped (with it the `version` bump, both `tests/skill-instruction-contract.test.ts` pins and the `filesTouched` collision with wave 4's **Gc2a**, which is now the only skill-editing group in the wave), as are `AGENTS.md`, `docs/decisions.md`, the three `experiments/` rows and B-1764's `HoistTag`/`refreshAllRanges` options widening. `filesTouched`: `src/server/positions.ts`, `src/server/mcp/{document,annotations,document-store,navigation,output-schemas}.ts`, `src/server/documents/watcher.ts` (comments), `src/shared/snapshot.ts`, `src/shared/positions/ydoc.ts`, `CLAUDE.md` (Critical Rule 6 for #1766, the Y.js/CRDT `relRange` gotcha for #1764), `docs/architecture.md` (#1766), `docs/mcp-tools.md` (the `anchor` field, the snapshot-normalization line), plus the test files each spec names. || 4 | Gc2a position mapping | #1774 #1776 | — | — | — | — | planned-not-started | |
| 4 | Gc2b keys + a11y | #1775 #1777 #1778 | `fix/keyboard-and-a11y-1777` | #1915 | — | armed | merged | Launched 2026-09-08 16:12 EDT from Bryan Windows PC (run `wf_694303e1-def`, probe ports 4928/4929), concurrently with B — paired with B because they are file-disjoint (server anchors vs client Svelte) and only ONE of the two needs the reserved E2E ports, which is why Gc2a could not be the partner. The first launch attempt was refused by the auto-mode permission classifier; relaunched on Bryan explicit approval. Order `1777 → 1775 → 1778`. **The spend limit killed the run at `build`, but four of the five implementation commits were already on the branch and the fifth was complete, green and merely UNCOMMITTED** — recovered by hand rather than regenerated (13 agents, 2.6M tokens before the stop). 2 plan-review rounds plus a scope cut. Shipped decisions: Ctrl+Enter fixed with a blanket `defaultPrevented` guard at the TOP of the window listener, not inside the accept-or-dismiss handler; the AltGr gate is branch-by-branch across eleven `e.code` chords so the three deliberate Ctrl+Alt chords survive; the six IME guards go through ONE shared `isImeComposing` predicate; `capturedRange` is demoted from `$state` to a plain `let` rather than bridged through `createCoalescingTick` (nothing reactive reads it, and this retires the same latent hazard in the existing `selectionUpdate` subscriber); the slash-menu guard sits in `resolveActiveSlashCommand` so the menu never OPENS inside a code block, and is deliberately blind to inline `code` MARKS; focus traps use the window-listener-in-`$effect` form (SettingsModal precedent) because only that form reaches trapTab recover-focus branch after a click on the dialog own padding drops focus to `<body>`; ALL FOUR aria-modal dialogs fixed, including the two that ship dark behind `BYO_MODELS_ENABLED`. Held out of scope: the #1722 half named in the #1778 body (it is #1824, with its own row). Verified 99 client tests, E2E 409 passed / 10 skipped / 0 failed, typecheck clean, full suite 10,889. Merged 2026-09-08 19:49 (`e7606afb`); all three issues closed; worktree pruned junction-first. **For Bryan:** the AltGr fix makes Ctrl+Alt+S/N/O/W/F/G/Enter/comma/slash/1-9 inert as app shortcuts on EVERY platform (macOS Option is `altKey` too) — he confirmed on 2026-09-08 that none are muscle memory, so the simple gate shipped rather than a `getModifierState(AltGraph)` check; and **the IME and AltGr changes are not verifiable from this machine** (they need a CJK IME in the chat composer and the link editor, and a Polish or German layout), so they rest on reading the fix rather than running it. |
| 4 | G5′ audience remnants | #1698 #1826 (#1678 already closed; +pin confirming #1656) | `fix/audience-remnants-1698` | #1921 | — | armed | merged | Launched 2026-09-08 as the wave's last group, alone (Gc2a had merged as #1919, so the one-e2e-group-at-a-time constraint no longer bound). **Taken over by hand after ~4.5 h**: the M-tier run was past its two-round PR-review cap and its review loop had begun chasing findings its own fixes introduced, with hours lost to `/code-review` fork deliveries that reached `completed` without their message ever entering the requesting agent's context (one agent: two forks never returned over ~2 h and two status pings; only the third delivered). `TaskStop`, then the six outstanding low findings applied directly — everything was already committed, so nothing was lost. **The general rule this confirms: stop a review loop the moment it starts reviewing its own fixes past the cap; the findings are cheaper to apply by hand than to schedule.**  Two of the six were real defects and both were fail-CLOSED bugs of the same shape — a check written so that an input it did not anticipate produces silence rather than noise:  - **The status gate made an unrecognized status permanently invisible.** `Annotation.status`   types as the three-value enum but the STORED value is a bare `string` — `sanitizeAnnotation`   passes it through unnormalized and the annotations Y.Map is writable by any connected client.   Both spellings of the `"pending"` test then compound: the gate's `=== "pending"` never admits   the record to `tandem_checkInbox`, and the candidates-filter mirror's `!== "pending"` calls it   settled, so it is dropped from range refresh too. No ledger entry is written, so no later poll   and no restart recovers it. Fixed by enumerating the two real end states in one shared   `isSettledStatus` — shared because the gate and its mirror have to agree and nothing else   keeps them in step. - **The `!editor` decline told the user their text had changed.** Both apply failures shared one   callback and one message. The missing-editor arm's reachable route is SOURCE VIEW, which   unmounts Tiptap while the annotations rail stays mounted by design — so Accept is a live button   with no editor behind it, and the message sends the user hunting for an edit nobody made.   `onApplyFailed` now carries `"range" | "no-editor"`, the shape `onUndoFailed` already used.  Two more were corrected as comments, and the correction is the interesting part: the presence sanitizer's docblock justified its narrow scope by saying `lifecycle.reply` had **already** refused a private comment or a highlight. It had not — `withTypingPresence` calls `setPresenceOn` BEFORE invoking the handler, so the marker is broadcast while the seam has refused nothing. The bound still holds on the other half of the argument (the id is caller-supplied, which is order-independent), but the consequence had been stated backwards: at broadcast time `sanitizeAnnotationIdForPresence` is the ONLY ADR-027 check on that path, so the docblock inviting a reader to treat it as belt-and-suspenders was an invitation to reopen #1698. **A safety argument that names the wrong guarantor reads as reassurance and is worse than none.**  Two findings were ANSWERED rather than fixed, which under a self-driving review loop is the outcome that needs a human to hold: the restart residual is the bound the spec deliberately chose (widening it reproduces the storm the gate closed, and it is a duplicate not a loss), and the idempotency window is not widened by the apply-before-accept reorder because `applySuggestion` is synchronous — nothing awaits between the check and the write. The loop would have "fixed" the first one straight back into the defect.  Also recorded on the PR: the status gate is an INTENTIONAL narrowing versus master. A user comment resolved before Claude's first poll used to be returned once (verified — `git show origin/master:src/server/mcp/awareness.ts:674` carries no status term); it is now filtered, so `annotation:created` has no pull counterpart for that record. Accepted, since the push already carried the content. Three of #1826's five items were refuted with evidence rather than fixed, and item 3 — concurrent `map.set` resolving by clientID — got the tracked home its spec required before `Closes #1826` could fire: **#1920**. The issue's own proposed fix (a `version` field with compare-and-set) cannot hold in a CRDT and would report a false guarantee; the real fix is server-serialized annotation writes, an authority change rather than a Low. #1656 was re-checked and is already correct — **no test added, because "already correct" has to be a reportable outcome or the pass is theatre.**  All three behavioural changes mutation-tested red (gate reverted, mirror reverted, reason hardcoded), restoring from file copies rather than `git checkout`. Full suite 650 files / 10,984 passed; typecheck, typecheck:tests and biome clean. One discounted flake: the pre-push `cargo test` failed `bounded_command::times_out_and_actually_kills_the_child` under concurrent vitest load and passed clean in isolation — the same timing class as F-config's, and no Rust was touched here. |
| 5 | D1 markdown fidelity | #1813 #1751 #1753 #1799 #1852 #1850 + #1823 server-data bullets | `fix/markdown-fidelity-1753` | #1924 | — | armed | merged | Launched 2026-09-09 in `wt-d1`; 25 agents / 4.34M subagent tokens / ~4.7 h, 3 review rounds + 2 PR-review rounds, 52 files. Six issues closed, #1823 Refs-only (four items named and left to wave 9 K-server). **Two of the six shipped as ANSWERS, not code**: #1852 gets a real-file spec and no serializer change, because hand-authored delimiter geometry is unreproducible — mdast carries no source markers for it — and #1753 half B's own example is *refuted* (`\*not emphasis\*` round-trips byte-identical; the corrupting shape is `\[label]`, via reference definitions arriving as raw-carrier `html` nodes). #1813's fix reverses a CLAUDE.md gotcha: force-open now clears only the in-memory map and flushes the envelope, so durable notes survive, and the Y.js/CRDT bullet is rewritten in-branch. Merged 2026-09-09 13:31 (`818e9c3d`) after one `update-branch`; worktree pruned junction-first. **CodeQL went red and it was NOT the usual timing race** — 3 new HIGH `js/path-injection` at `file-io/index.ts:421-424`, which are the same condition already dismissed as won't-fix three times on that file (#50/#51/#52), relocated because #1850 consolidated `atomicWrite` + `atomicWriteBuffer` into one `writeTempThenRename`. Dismissed as won't-fix on Bryan's explicit authorisation once the wave had closed (see the wave narrative for the wording, and why #50/#51/#52's text was not reused). **The For-Bryan reflow bullet in the PR body was wrong and was corrected in place before merge** — see the wave narrative and #1926. |
| 5 | E1 desktop core | #1761 → #1763+#1812 → #1758+#1787 (+decision D) | `fix/desktop-core-1761` | #1925 | — | armed | merged | Launched 2026-09-09 in `wt-e1`; re-scoped before planning per this row's own warning — #1761 had shrunk to a round-trip test plus `Entry::store_status()`, and **#1455 is NOT resolved by it** (its own dated gate, 2026-10-15). Five issues closed. **The group STALLED in the `/code-review` fork-delivery failure and was finished by hand** — diagnosed by comparing journals (D1's fresh at 12:34 and progressing; E1's frozen at 12:06 with `code-review:r2` last, while three review agents had completed), confirmed at the filesystem level by two of three review `.output` files being **0 bytes**. Recovery was to grep the one 1.1 MB output that landed rather than re-run a ~200k-token review; every recovered finding was re-derived against current source first, which is what caught that two of the six were already fixed in `7d7f5b91` and their line numbers predated it. An orphan agent that had burned ~430k tokens on wait-loop ticks was stopped after it began unprompted scratchpad exploration; both worktrees verified intact after. Round 2's own headline: a single unreadable legacy file silently disabled #1787 **entirely and permanently**, because `fs.cp` is all-or-nothing and its throw reached the catch that returns WITHOUT writing the ownership stamp — so the guard never armed on that launch or any later one. Also carries the **`ci.yml` apt fix** (`fc689a0c`), bundled because it is what unblocked this PR: see the wave narrative. Merged 2026-09-09 14:12 (`717eeff9`) after one `update-branch` plus one rerun; worktree pruned junction-first. **Decision D shipped gated on `flavor`, not on version ordering** — an already-released `tandem-editor` has no code to read a stamp, so a version rule protects nothing the directory separation has not already made impossible; recorded against D's row in `decisions.md`. |
| 6 | D2 docx contract | #1754 (Refs) #1755 | — | — | — | — | planned | Launched 2026-09-09 23:2x (run `wf_e8252052-c98`, probe ports 4918/4919), concurrently with CI-trust. Tier raised to **L** at launch (the wave table said M→L and the crdt + security lenses both apply). #1754 is **Refs-only** under decision B — `tandem_applyChanges` ships marked experimental, only the cheap walker fixes (tab/br/sym) land, and the deferral gets a comment on #1754 rather than a new issue. Security lens is the **export refusal** specifically; crdt lens is that any change to the walker's flat text moves the `.docx` capture and comment-IMPORT offsets, which are two of Critical Rule 4's four `surrogates: "ignore"` callers — no fifth one. Skill bump 18 → 19 with the `tests/skill-instruction-contract.test.ts:87` literal in the same commit. |
| 6 | H the flip | #1788 → #1785 → #1793+#1786 (+#1825 infra section, same ledger row; code only, **no deploy**) → #1789 #1819 — three PRs in the ledger | — | — | — | — | planned-not-started | |
| 6 | CI-trust | #1862 #1673 **#1933** | — | — | — | — | planned | Launched 2026-09-09 23:2x (run `wf_bb1e7e15-280`, probe ports 4928/4929), concurrently with D2. **#1933 joined the group after it was filed on 2026-09-09** — a third shape of the same failure, found by chasing #1932's red. All three are "a CI signal that reads like a finding about the diff and is not": #1673 a green that should be red (files collected vs files run), #1862 a red that evaluated nothing (vitest exits 1 before `coverage-gate.mjs` in the `&&` chain), #1933 a test whose own comment overstates its safety margin by ~20x. ADR-051 governs the design — `coverage` is advisory, so what blocks is a wiring test inside `check`. |
| 7 | G8 docx comments | #1693 | `fix/docx-comments-the-promoted-comment-ghost-and-three-narrower-gaps-1693` | #1956 | — | armed | merged | Merged 2026-09-10 (`54495303`). **Closes nothing, deliberately** — the spec says three times that closing #1693 is "not defensible on this branch", because its own named reproducer still reproduces in the SIDEBAR after a cold open: `reconcileImportCommentIds` repairs `importSource.commentId` but cannot re-key the record, since the map key is a hash of the id it was imported under. Landed finding 1's reload half for all seven ids, its file half on a cold open via the ghost-pair collapse, 1c (`nc:`), 3 (at-cap boundary), 4 (orphaned-reply repair), and two measured in-file census defeats. Three residuals filed: **#1954** (the sidebar half), **#1950** (finding 2's repo-wide write-seam census), **#1951** (the `w:id` reuse residual — `0123` exports as `1`, non-numeric ids can never reuse). |
| 7 | I-release | #1748 (+G) #1856 #1830 #1831 #1832 (fix halves; policy halves to Bryan) + #1825 CI section | `fix/release-and-ci-hygiene-1856` | #1955 | — | armed | merged | Merged 2026-09-10 (`018a434a`); closes #1748 #1856 #1830 #1832. **#1748 item 3 was already done** — the `NPM_TOKEN` expired mid-release and `publish.yml` moved to npm Trusted Publishing out of band on 2026-09-06. **#1831 is Refs and stays Bryan's**: only the `CONTRIBUTING.md` correction landed (it no longer claims an automated reviewer covers non-Dependabot PRs); delete-vs-repair of `claude-code-review.yml` is the decision, and the spec's gate reads "landing any part of it is landing the decision". Also landed five of #1825's CI/build fixes plus four bullets recorded refuted-or-already-done. |
| 7 | E2-rust | #1762 #1808 #1809 #1810 + #1455 pointer (Refs) + #1825 Tauri section | `fix/desktop-sidecar-lifecycle-and-start-at-login-repair-1762` | #1968 | — | armed | merged | Merged 2026-09-11 (`cfcb10e7`); closes #1762 #1808 #1809 #1810. **Broke the ubuntu and macOS `rust-test` legs at COMPILE time on first push** — `SIDECAR_UNLOCK_DEADLINE_SECS` was `#[cfg(target_os = "windows")]` while a deliberately cross-platform test asserts against it; fixed in `7e0fd073` with `#[cfg_attr(not(target_os = "windows"), allow(dead_code))]` and a comment naming why it compiles everywhere. See lesson 2. #1825's Tauri first bullet was re-measured and found **already fixed by #1925** (`sidecar_env_pairs` exports the three vars at the spawn site); #1455 got its dangling ADR-045 pointer repaired and nothing else, so its dated 2026-10-15 gate is un-pre-empted. |
| 7 | K-client | #1824 remainder #1713 #1724 #1727-split (Refs) #1709 #1544 | `fix/client-lows-editor-ui-a11y-and-product-copy-1709` | #1966 | — | armed | merged | Merged 2026-09-11 (`09d304e2`); closes #1713 #1724 #1709 #1544. Ten of #1824's items (B, C, D, E, F, G, H, I, L, N) landed, each re-verified against current master and mutation-tested. **#1824 stays open on six carve-outs** — #1963 (item A), #1964 (item K, also extends #1722), #1965 (item M), #1960, #1961, #1962; A/K/M were cut because each needs a cross-cutting mechanism rather than a same-file fix. **#1960 has since closed *not planned*** — shared chat "seen" state is the more correct behaviour for one user with two windows on one document. The generated body first shipped `Closes #1824`, contradicting its own For-Bryan section twelve lines down; **corrected before merge.** One testid-snapshot regeneration. |
| 7 | K-tests | #1825 Tests remainder #1855 #1861 #1734 (e2e) #1584 #1599 checkboxes (Refs) | `fix/test-suite-integrity-silent-greens-fragile-assertions-and-an-unimplemented-perf-decision-1861` | #1973 | — | armed | merged | Merged 2026-09-11 (`3ab75719`); closes #1855 #1584. Every issue here was *a test that lies*, so the failure mode of fixing them is making a test pass that should fail. #1861's fix exposed a silent mode nobody had characterized: the old stripper truncated `autostart.rs` at len=5334 vs 6562, dropping **8 production symbols** from every `rustSources()` guard, invisible to all seven pre-existing consumers. #1855's 8.3 axis was claimed unreachable in `2411d9a2`'s message and then **reproduced directly** (corrected in `eccc1939`). #1734 implemented #1334's decision — 714ms FAIL old / 311ms PASS new — with a source-scan pin for the CSS-class locator, which carries none of Critical Rule 7's contract. **Refs #1861 (carve-out #1970), #1734 (carve-out #1974), #1825 (bullet 9), #1599 (no work).** The returned `closes[]` named four; the body named two and was right — lesson 1. |
| 8 | E2-upgrade | #1791 #1792 (+#1722's `updateSettings` boolean, once) + smoke-lines merge | — | — | — | — | planned-not-started | |
| 8 | K-sec-server | #1822 items 1,2,3,7,8 #1488 comment (Refs) #1609 | — | — | — | — | planned-not-started | |
| 8 | K-sec-launcher | #1822 items 4,5,6 #1600 (fix half) | — | — | — | — | planned-not-started | |
| 8 | G1 launcher stdin | #1866 #1868 #1867 #1780 | — | — | — | — | planned-not-started | |
| 8 | G10 awareness hygiene | #1624 #1702 | — | — | — | — | planned-not-started | |
| 9 | K-server | #1823 MCP-surface remainder #1851; then #1823 runtime as a second PR | — | — | — | — | planned-not-started | **Re-scope before starting (2026-09-08): the #1823 item `anchor` on `tandem_getAnnotations` ALREADY LANDED in wave 4 group B (#1916, `7989261d`)** — #1764 needed it to make a degraded re-anchor legible on the wire for the first time. Do not plan it twice; check the rest of #1823 against master before sizing this group. |
| 9 | G9a watcher/reload silence | #1662 #1663 #1695 | — | — | — | — | planned-not-started | |
| 9 | G9b open/restore | #1863 #1696 + #1700 audit guard (Refs) | — | — | — | — | planned-not-started | |
| 9 | #1708 workspace silent failures | #1708 | — | — | — | — | planned-not-started | |
| 9 | G6 rail seam | #1719 #1716 (+#1722 surfacing if not in E2-upgrade) | — | — | — | — | planned-not-started | |
| 9 | G7 editor quick controls | #1705 #1706 #1738 | — | — | — | — | planned-not-started | |
| 9 | G14 chat markdown | #1639 → #1626 part 1 (Refs) | — | — | — | — | planned-not-started | |
| 9 | #1603 transform audit | #1603 | — | — | — | — | planned-not-started | |
| 10 | G4 typecheck-tests | #1613 → #1614 → #1615 (alone) | — | — | — | — | planned-not-started | |
| 10 | G11 process docs | #1602 #1604 #1605 #1606 | — | — | — | — | planned-not-started | |
| 10 | D3 docx save override | #1941 | — | — | — | — | planned-not-started | Added 2026-09-11; see the wave table for why wave 10 and not 8/9. |
| 11 | #1689 harness refactor | #1689 | — | — | — | — | planned-not-started | |
| 11 | local-model flip blockers | #1657 | — | — | — | — | planned-not-started | #1292 removed 2026-09-11 — closed as fixed 2026-09-08. |

### Wave 3 closed — 2026-09-08

Seven PRs, all merged: **#1896** F-doctor, **#1897** J2, **#1898** Gc1, **#1900** C,
**#1901** / **#1903** / **#1902** the three #1821 docs-drift groups. Every worktree pruned
junction-first; `.claude/worktrees/` is empty. Wave 4 is B anchors, Gc2a, Gc2b and G5′.

### Wave 4 opened — 2026-09-08
**Both merged the same day: Gc2b as #1915 (`e7606afb`, 19:49) and B as #1916 (`7989261d`, 21:15).**
Eight issues closed. Gc2a and G5′ remain, and they are each other's partner — Gc2a is `e2e: true`,
so its partner must not be, and G5′ is the only non-e2e group left in the wave.

Three things this pair established, all of which change how the next one should be run:

1. **The spend limit is survivable, and the recovery move is to READ THE WORKTREE, not to relaunch.**
   Both groups died at `build` on the monthly limit. Between them they had already committed 5 of 8
   issues, and a 6th (B's #1765) was complete, green and merely uncommitted. Nothing was regenerated:
   the surviving work was verified, mutation-tested and committed by hand. A `git log` plus
   `git status` in each worktree is the whole diagnosis, and it costs nothing. The wave-3 lesson
   generalises — a 429 kills an agent mid-edit, not mid-thought.
2. **When a group dies AFTER its specs land, do not resume the full pipeline — write a small one.**
   B's remaining three issues cost **1.1M tokens across six agents**; the L-tier pipeline had spent
   **3.4M to get one issue committed**. The difference is not model or effort, it is that plan and
   adversarial review were already committed as specs and did not need re-running. A resume via
   `resumeFromRunId` would have replayed them at L tier. The replacement was three sequential build
   agents (sequential because all three touched `positions.ts` in one worktree), two parallel review
   lenses and one fix pass. It found MORE than the pipeline's own review stage would have been
   scheduled to: both lenses independently caught that #1766 left the heading hole open on the
   suggestion arm.
3. **A review agent's own probe files can poison a concurrent agent's full-suite run.** During B's
   review one lens created `zz-probe-crdt-review.test.ts` and `zz-probe2.test.ts`, the latter ending
   its only `it` with a deliberate `throw` as a data-dump device. The other lens's first full-suite
   run reported 3 failed files including a spurious `snapshot-truncation-reload` failure; the
   identical run after the probes vanished reported only the known `platform.test.ts` artifact. Both
   were gone by the time the run ended and `git status` was clean, but a full-suite red during a
   review window should be re-run before it is believed.

Also settled here, and worth not re-deriving: **this repository cannot have a merge queue.** GitHub
merge queues require an ORGANISATION-owned repository and `bloknayrb/tandem` is user-owned, so the
feature is absent from classic branch protection, from the ruleset rule list (verified in the UI on
both surfaces), and from both REST and GraphQL. The `merge_group` CI trigger from #1914 is correct,
inert and pre-positioned should the repo ever move to an org. The sibling-staling cost of
`strict: true` is therefore permanent unless `strict` is turned off, which is Bryan's call and was
still open when wave 4 closed.

**B anchors** (`wf_5f5691dc-6f2`) and **Gc2b keys + a11y** (`wf_694303e1-def`) launched
concurrently 2026-09-08 16:07 and 16:12 EDT; per-group detail is in their ledger rows.
**Wave 4 is CLOSED — all four groups merged, 2026-09-08/09.** B anchors (#1916), Gc2b keys +
a11y (#1915), Gc2a position mapping (#1919) and G5′ audience remnants (#1921): twelve issues,
and #1656 confirmed-already-correct with no test added. Two constraints decided the pairing
while it ran, and they bind the next wave too:

- **Only one group at a time may hold the reserved E2E ports.** Gc2a and Gc2b are both
  `e2e: true`, so they can never be partners. Each e2e group must be paired with a
  non-e2e one — B here, G5′ for Gc2a.
- **Gc2a bumps the shipped skill** (via #1776), so it takes the next integer after
  `origin/master` at rebase time and the pinned literal in
  `tests/skill-instruction-contract.test.ts` moves with it in the same commit. Nothing
  else in wave 4 touches the skill, so no wave-4 sibling can collide on that literal.

**The lesson wave 4 actually cost, and it is about the review loop rather than the code.** Two
of the four groups were finished by hand: B after the spend limit, G5′ after its review loop
began reviewing its own fixes past the two-round cap. In both cases everything of value was
already committed and the hand finish was cheaper than the machinery — G5′'s last six findings
took one pass, against ~4.5 h of loop that had stopped converging. **Two of those six were
answered rather than fixed**, and that is the outcome a self-driving loop cannot reach: the
restart residual is a bound the spec deliberately chose, and "fixing" it reproduces the storm
the gate was written to close. A loop with no one holding the spec will fix it.

**A second, cheaper rule fell out of G5′'s comment findings:** a safety argument that names the
wrong guarantor is worse than no comment at all. Two docblocks credited a downstream refusal
that provably runs AFTER the broadcast they were justifying — so the one check actually holding
the line read as redundant belt-and-suspenders, i.e. as safe to delete. Check the ORDER before
believing a comment that says a later gate has you covered.

Repo-state note taken at launch: `master` was `4a8d5394`, still `strict: true` with
`enforce_admins: true`, so each merge in this wave stales its sibling and costs a
`gh pr update-branch` plus a full ~16 min re-run. **That cost is now known to be permanent, not pending a setting.** The
`merge_group` CI trigger landed in **#1914** on the assumption the branch could be switched
to a merge queue; it cannot. **GitHub merge queues require an ORGANIZATION-owned
repository**, and `bloknayrb/tandem` is user-owned (`owner.type: "User"`), so the feature is
absent on every surface: no checkbox in classic branch protection, no `merge_queue` entry in
the ruleset rule list, no field in the REST or GraphQL protection APIs, and a REST ruleset
create that 422s with an empty reason. Verified in the UI 2026-09-08. The #1914 trigger is
harmless and stays — it is correct, costs nothing while no merge group is ever created, and
is pre-positioned if the repo ever moves to an org — but do not plan around a queue arriving.
The only lever on the sibling-staling cost is turning `strict` off, which is Bryan decision
and was open when this wave launched.

Four things this wave established that change how the next one should be run:

1. **The budget cut holds.** Gc1 under the new script: 26 agents / 2.6M tokens / 2.8 h. J2 under the old one: 48 / 7.4M / 6.7 h. Same wave, comparable size. Do not re-widen the plan-review rounds or the per-finding skeptics without a new measurement.
2. **A resume is only cache-safe if the earlier `agent()` calls are byte-identical.** C's resume re-ran plan review round 1 and 429'd again, because the budget cut had changed `opts` on calls *before* the stop point. Diff the script against the revision a run started on before passing `resumeFromRunId`; if anything before the stop point moved, finish by hand.
3. **A long-lived branch must expect master's NEW specs to encode the OLD contract.** C's first CI run went red on two specs that did not exist when it branched, each pinning behaviour C deliberately changed. Neither was catchable locally before the merge. Budget a reconciliation pass at PR time for any group that runs more than a day.
4. **Verification scope is the orchestrator's job.** Group C's agent ran the doc suites it was told to and still shipped a red `check`, because the guard that caught it lives in `tests/server/`. An agent editing anything outside `docs/` gets told to run the full suite.

One process cost to avoid repeating: three sibling docs PRs merged serially cost three
`update-branch` cycles and three ~20-minute `check` runs, because `strict: true` invalidates
the rest of the queue on every merge. Sibling PRs with disjoint files are still worth splitting
for reviewability, but land them in one queue rather than opening them in parallel.

### Wave 5 opened — 2026-09-09

D1 markdown fidelity and E1 desktop core, launched concurrently. **D1 merged as #1924
(`818e9c3d`, 13:31); E1 is #1925 and still in flight.** Neither is `e2e: true`, so the
one-e2e-group-at-a-time constraint did not bind this pair.

**E1 stalled in the same failure mode as G5′, and the diagnosis was a journal comparison.**
D1's journal was fresh at 12:34 and had progressed `code-review:r2` → `skeptic:r2` →
`fix:review:r2`; E1's was frozen at 12:06 with `code-review:r2` last, while *three* code-review
agents had completed on that branch. The filesystem confirmed it: two of the three review
`.output` files were **0 bytes**. That is the `/code-review` fork-delivery failure — a fork
reaches `completed`, its output file is empty, the requesting agent never receives the payload,
and the stage silently retries at ~200k tokens each. **Recovery is to grep the one output that
DID land, not to re-run the review.** Every recovered finding was then re-derived against
current source before being touched, which is what caught that two of the six were already
fixed in the r1 commit — their line numbers predated it. An orphan agent burning ~430k tokens
on wait-loop ticks was stopped once it began unprompted scratchpad exploration; both worktrees
were verified intact afterward.

**The wave's real lesson is about a measurement, not a mechanism.** D1's PR body carried a
For-Bryan bullet reporting that saving a hard-wrapped markdown document *"reflows every
soft-wrapped paragraph onto one line"*, with three figures: 1503 differing lines in
`docs/mcp-tools.md`, 432 in the sweep plan, 131 in `CONTRIBUTING.md`. Filing that as an issue
meant measuring it first, and **all three numbers reproduce exactly while the conclusion drawn
from them is false.** They come from a *positional* line-index comparison, where one blank line
inserted near the top of a file marks every line after it as differing. The true diff for
`docs/mcp-tools.md` is **+126 / −39**; `CONTRIBUTING.md` is **+4 / −3**. There is no paragraph
reflow at all — hard wraps survive the round trip intact.

What is actually there, measured identically on `master` and on D1's branch: **27 of 30** repo
`.md` files are rewritten, **all idempotent**, in four rendering-neutral classes — table
delimiter rows (122 rows, so #1852's class is repo-wide rather than the one README it names),
a blank line inserted before a fence or list (294), lazy-continuation structure made explicit
(~207 lines, mostly `docs/decisions.md`), and escape/marker normalization. Filed as **#1926**,
which also carries the retraction; the PR body was corrected in place before it merged.

Two rules fall out, and they generalise past markdown:

- **A line-index diff is not a diff.** Any count of "differing lines" taken by position is an
  upper bound dominated by the first insertion, and it will overstate a small change by an
  order of magnitude. Use `git diff --no-index --numstat`, or classify hunks.
- **The third class read as corruption on first inspection and is not.** Paragraphs written
  flush against a preceding blockquote or list item come back *inside* it — but per CommonMark
  **lazy continuation** they already were, so the serializer is writing what the document
  meant. Check the spec before filing a round-trip difference as data loss.

**A CodeQL red that was not the timing race.** #1924's CodeQL failure reported 3 new HIGH
`js/path-injection` alerts, and the memory-rule that a ~3s CodeQL failure is the
default-setup/rust config race did not apply — the run was 3s AND the finding was real-shaped.
They resolve to the same condition dismissed as won't-fix three times already on that file
(#50/#51/#52, "atomicWrite is an internal helper; path validation is caller responsibility"),
relocated because #1850's fix consolidated `atomicWrite` and `atomicWriteBuffer` into one
`writeTempThenRename` helper. Not a new vulnerability, CodeQL is not a required check, and the
alerts were left open at merge time rather than dismissed, because dismissing a security alert
is Bryan's call — **he gave that authorisation later the same day and they are now dismissed as
won't-fix; see the wave narrative for the wording.** Checked while there: CLAUDE.md's rule that alert 16 must not be dismissed *as a false
positive* is intact; it was dismissed 2026-08-28 as "True positive, not false … won't fix per
#1654", which honours the rule.

**Also: not every red is a semantic conflict.** E1's post-restack `check` and
`rust-test (ubuntu)` both failed in their dependency-install step, before any Tandem code ran —
`apt-get update` hit a `Hash Sum mismatch` on Google's Chrome repo. The other two rust legs
were *cancelled* by fail-fast, not failed. Read the failing STEP before reading the diff.

**Wave 5 is CLOSED — both groups merged 2026-09-09.** D1 markdown fidelity (#1924,
`818e9c3d`, 13:31) and E1 desktop core (#1925, `717eeff9`, 14:12): eleven issues, plus
#1823 carried forward as Refs. Both worktrees pruned junction-first; `.claude/worktrees/`
is empty.

**The reflow retraction did not stay a documentation fix — it turned into an experiment
that refuted my own follow-up too.** Having established there was no reflow, the remaining
open half was #1852's: `autoSaveAllToDisk` skips non-dirty documents, so the README it
reported *was* dirty, and the named suspect was a Tiptap schema normalization on first
sync. I had written that this "needs a live browser and is not decidable from the server."
It was decidable, by running it: a Playwright spec that opens a file, attaches a real
client, waits past first sync and the tab's 500 ms arm window, then asserts no unsaved dot
and unchanged bytes. Clean — for a fixture carrying all three residual shapes **and for
#1852's actual README**. Mutation-tested: a real `tandem_edit` before the attach turns it
red, so it is not passing vacuously. Lands as `tests/e2e/open-does-not-dirty.spec.ts`.

So **the residual is latent, not live**: opening a repo doc costs nothing until a real edit
provokes a save. That also killed the one fix I had guessed was cheap — class 2's
blank-line insertion needs a `join` handler that knows the pair was tight in the source,
and `mdastToYDoc` drops mdast's source positions, so there is nothing to consult at
serialize time. Same root cause as #1852's delimiter geometry, same answer.

**The rule worth carrying: "not decidable from here" is a claim about the tools you reached
for, not about the question.** Twice in one wave a deferral was written into a PR body and
then dissolved in under an hour by actually measuring — once for the reflow numbers, once
for the browser repro that the deferral itself had specified. Both deferrals were mine, and
both were cheaper to settle than to hand over.

**Two housekeeping outcomes.** The three CodeQL alerts from #1924's relocated `atomicWrite`
sinks (#214–216) are **dismissed as won't-fix**, on Bryan's explicit authorisation
2026-09-09 19:48 — the auto-mode classifier refuses security-alert writes by default, so
this needed a turn of its own rather than being folded into the merge. The wording
deliberately does NOT inherit #50/#51/#52's text verbatim: that said callers "validate at
the MCP tool boundary", which is now incomplete, because `mcp/annotations.ts` and
`mcp/convert.ts` are the caller-named destinations *accepted* under #1654 rather than
validated. So the comment reads "won't fix", never "false positive", matching alert 16's
own framing — and alert 16 itself was left untouched. `file-io/index.ts` now carries zero
open alerts; the six that remain repo-wide (five in `reload-family.ts`, one in `convert.ts`)
are pre-existing and unrelated. And **#1926 is CLOSED as accepted** — Bryan took option A
(accept the residual) on 2026-09-09 over option B (a tree-wide normalization pass). The
measurement stands as filed: 27 of 30 files, all idempotent, +633/−345, four classes with a
per-class disposition. The reasoning for A over B was not risk — B is low-risk, the
doc-parsing tests are the guard — but that a normalization pass decays on the next hand-edit
and trades a hand-authored source format for a serializer's. The disposition is recorded in
`docs/gotchas.md` under *Files, Sessions & Lifecycle*, including an explicit do-not on
tree-wide normalization and the note that class 3 is CommonMark lazy continuation rather than
corruption, so nobody re-files it as data loss.

### Wave 5 coda — the #1596 smoke run, and a test that was measuring nothing

Two things landed after wave 5's groups closed, neither belonging to either group.

**#1596 is closed as *keep — row executed*.** Bryan's PC was the hardware, so the §1 Windows
updater row ran for the first time since it was written: **v0.24.1 → v0.25.0, PASS, no
"Tandem may not have finished updating" banner.** That is the first hardware exercise of
#1118's false-positive mode. Recorded in `docs/release-smoke-checklist.md` under *What the
v0.25.0 run settled* (#1932, `7ee66a5c`), which is where the issue's criterion said the
evidence had to live.

The run produced two findings the issue did not anticipate. First, **an operator cannot
confirm this row from the log and must watch the window**: `evaluate_pending_update_marker`
logs `MayHaveFailed` as `warn!` but `Completed` as `info!`, and the release build's floor is
`LevelFilter::Warn` (`src-tauri/src/lib.rs:1166-1169`), so a *successful* update writes
nothing — and the marker is cleared unconditionally on both paths, so its absence proves
nothing either. §1's updater row now says so in place. Second, **#1762 was caught live**: a
code-reading claim became an observation, with `tandem.log` recording `Sidecar exe not on disk
at ...node-sidecar-x86_64-pc-windows-msvc.exe — skipping unlock wait (packaging bug?)`.
Bounded — the NSIS PREINSTALL hook held and the sidecar's mtime moved — but
`wait_for_sidecar_unlock` returns `true` on a missing file, so the guard is inert on every
Windows install. It is wave 7's E2-rust group. The half-installed path, the `MayHaveFailed`
arm that *should* show the banner, remains untested.

**#1933: a test whose stated margin does not exist.** #1932's `check` went red on a docs-only
diff at `tests/server/search-worker.test.ts:93` — `expected undefined to be 'timeout'`.
Green on re-run, and `coverage` passed the same commit first try, so it is a flake. But the
comment above it claims the blowup `exec` "spins for 20-35 s — far past any deadline check",
and measured on Node v24.2.0 it **returns on its own in ~3.07 s** against a 2000 ms
main-thread hard timer. The margin is ~1.07 s, not ~20 s. Its two siblings in the same file
measure 21.9 s and 78.3 s and are genuinely safe; the `x|` alternation prefix is what makes
this one ~7x cheaper to exhaust. The obvious hypothesis — V8 bailing into its linear-time
experimental engine — is **refuted**: `--regexp-backtracks-before-fallback=100` changes the
timing not at all.

That matters beyond one flake, because if the `exec` ever drops under 2000 ms the test fails
*deterministically* and reads like a `truncated` regression. It joins #1862 and #1673 in wave
6's CI-trust group as a third shape of "a red that says nothing about the diff" — but unlike
those two it is a wrong assumption inside a test, so it is a fix rather than a gate.

**The rule: a comment stating a safety margin is a measurement claim, and it expires.** Nobody
would look at this test, because its comment says the margin is an order of magnitude wider
than it is.

Wave 6 is the H group, which #1787 has now made real — #1789 documents the env var this
wave introduced, and it was deliberately sequenced after E1 — plus D2 docx contract and
CI-trust (#1862 #1673, now #1933).

### Wave 6 opened — 2026-09-09

Two groups launched together, file-disjoint by inspection: **D2 docx contract**
(`wf_e8252052-c98`, ports 4918/4919) and **CI-trust** (`wf_bb1e7e15-280`, ports 4928/4929).
D2 owns the `.docx` / mdast paths, `docs/mcp-tools.md` and `skills/`; CI-trust owns
`scripts/ci/`, `tests/scripts/`, `ci.yml` and `tests/server/search-worker.test.ts`. Neither
is an `e2e` group, so the fixed Playwright harness ports are not contended.

**H is deliberately NOT running with them.** It is the wave's L-tier group and the only one
whose subject is a live-code gate, so it gets the machine to itself after one of these
merges. Two things about it that a reader will otherwise get wrong:

- **H does not flip anything.** The wave-table row says *code only, no deploy*, and the
  point of the group is to make the **armed** gate correct — exercised under
  `TANDEM_LICENSE_GATE=1` — while `LICENSE_GATE_ENABLED` stays `false` and
  `LICENSE_UPDATE_ENDPOINT` stays `""`. CLAUDE.md's rule that the gate must remain
  byte-identical while dark is a constraint on this group, not a thing it relaxes. Worker
  deploys are Bryan's.
- **#1785 is why the flip is two consts, not one.** `LICENSE_UPDATE_ENDPOINT` at
  `src-tauri/src/lib.rs:178` is the second, in a different language, with nothing linking
  it to the first. While it is empty, `entitled_license_id` returns `None` on its first
  line — before it reads anything — and `build_updater` (`:2342`) takes its `None` arm,
  which is `app.updater()`, the **public** manifest from `tauri.conf.json`. So arming
  the tsup const alone leaves the update window inert — which is exactly the
  "You're up to date forever" silence #1786 says has no detector.

#1933 joined CI-trust after the group was named. It came out of chasing #1932's red rather
than out of the review, which is the second time this sweep that following a CI failure to
its floor produced a tracked defect instead of a shrug.

### Wave 6 closed — 2026-09-10

Five PRs closing eight issues, with eight more left open by design, and #1596 and #1788 closed
alongside them (the smoke run and decision F). D2 docx contract merged as **#1939**
(`1aca8bc1`, #1754 #1755), CI-trust as **#1936** (`06403bec`, #1673 #1933), then H's three in
order: **#1940** (`52fa195c`, #1785), **#1944** (`d2cc5e08`, #1793 #1786) and **#1945**
(`fff8e312`, #1789 #1819). #1932 (`7ee66a5c`) and the two ledger PRs #1934 / #1935 sit alongside.

**Open by design, and each has a reason rather than a backlog slot:** #1862 (its coverage-job
half — a red that reads as a floor breach; #1937 carries the vitest exit-1-with-zero-failures
half), #1754 → decision B, #1825 (its Infra section is 2-of-3 and the CI/build `infra/` bullet is
done; the rest of CI/build, all of Tauri and the Tests remainder are wave 7), #1941 (the `.docx`
save override — Bryan's explicit choice of *refuse by default, add an override*, split out rather
than stacked so the safety half shipped first; **scheduled 2026-09-11 as wave 10 group D3** — it
sat here for a day as prose with no wave row, which is a backlog slot by another name),
#1942 (signing-key rotation, dated), #1943 (deactivation policy, Bryan's), #1946 (the desktop
token panel, found while fixing #1789(a)).

Four lessons, and three of them are about the seam between a group and the merge rather than
about code.

**1. A comment stating a safety margin is a measurement claim, and it expires.** #1933 began as a
`check` flake and ended as a wrong test: the comment claimed one `exec` spinning for 20–35 s
against a 2 s hard timeout, and the measurement was 3.07 s. The margin had eroded to ~1.5×
without anyone editing the line that asserted it. Chasing a CI failure to its floor produced a
tracked defect rather than a shrug for the second time this sweep.

**2. "Required" protects against a RED, not against a step that never runs.** The eighth ADR-051
instance (#1673) is the first one *inside* a required job, which is exactly where the pattern
reads as unnecessary. It is not: `run: … || true`, `continue-on-error: true`, an `if:` that stops
matching, or deleting the step each leave `check` green with the anchor dead — the #1229 shape,
re-created inside the very group that exists to fix it.

**3. A ship stage's `Closes` / `Refs` lines need reading before the merge button, every time.**
Three separate failures in one wave, none of which any test could catch. CI-trust wrote
`Closes #1862` against its own buildNotes and three of its own `bryan[]` entries saying #1862 must
NOT be closed. #1944's Refs paragraph said "the Infra section only" and then listed three CI/build
items, omitting two Infra bullets it had actually fixed — and stated the `config-*` alerting rule
backwards (`CONFIG_STAGES` is enumerated, not prefix-matched, and the test asserts a
`config-future` stage is **not** alertable, precisely so a later one must be adopted
deliberately). A `Closes` line is the only artefact that changes issue state, and it is written by
the stage least able to check it.

**4. A handover between two concurrent groups needs an owner at merge time, not at plan time.**
H-c correctly refused to edit `docs/licensing-operations.md` — H-b owned it — and named the
correction in its `bryan[]` list as "needs to land in whichever PR merges second". That phrasing
is right and is also the whole risk: nothing enforces it, and the second PR's author is not the
one who wrote the note. It landed on #1945 (`f48ff671`). The generalisation for wave 7: a
cross-group handover belongs in the *second* group's checklist, not in the first's output.

The same class produced **#1946**. H-c ended a `bryan[]` entry with "say the word and I will file
it", which is an untracked deferral wearing the clothes of a decision. Verifying it before filing
found the panel is wrong in two more ways than reported: `tokenRotatedAt` is loopback-only and the
Tauri WebView is loopback, so the block always renders on desktop, and the `auth-token` file is
npm-location-only by design — so the desktop panel reports "Auth token not yet created" for a
token that exists and is in use, or, on a dual-install machine, shows the npm install's rotation
time inside the desktop app.

### Wave 7 closed — 2026-09-11

Five PRs closing fourteen issues, plus three out-of-group documentation PRs and eleven new issues
filed out of the work. G8 docx comments merged as **#1956** (`54495303`, #1693 Refs only),
I-release as **#1955** (`018a434a`, #1748 #1856 #1830 #1832), E2-rust as **#1968** (`cfcb10e7`,
#1762 #1808 #1809 #1810), K-client as **#1966** (`09d304e2`, #1713 #1724 #1709 #1544) and K-tests
as **#1973** (`3ab75719`, #1855 #1584). **#1969**, **#1972** and **#1975** sit alongside as
documentation corrections belonging to no group — the first two reconciling the security register
against the tracker, the third this ledger.

**Open by design, each with a reason rather than a backlog slot:** #1831 (delete-or-repair
`claude-code-review.yml` — Bryan's, and the I-release spec records the gate in terms that make
landing *any* part of it landing the decision), #1693 (its cold-open **sidebar** half still
reproduces; #1954, #1950 and #1951 carry the three residuals), #1824 (six carve-outs open under
it, of which #1960 has since closed *not planned* — shared "seen" state is the more correct
behaviour for one user with two windows), #1825 (the Tests section's `perf:gate`-has-no-CI-runner
bullet needs an ADR-051 wiring decision, plus the CI/build and Tauri remainders), #1861 (carve-out
#1970), #1734 (carve-out #1974), #1455 (dated 2026-10-15, hardware-gated, Bryan's), #1727
(deferred, Bryan's, revisit 2026-11-15) and #1599 (an accepted finding, no work by design).

Five lessons, and the first is a correction to the fix the last two waves prescribed.

**1. The `Closes` prose held. The machine-readable list did not, and that is the half the loop
reads.** All five wave-7 PR bodies got `Closes`/`Refs` right — the first wave in three where that
is true, and K-client's body was corrected from a wrong `Closes #1824` before merge, so the
cross-check worked. But K-tests's *returned* `closes[]` named four issues (#1861 #1855 #1734
#1584) while its own body named two. **Step 3 of this ledger's loop and the completeness critic
both read the return value, not the body**, so a group can ship a correct PR and still hand the
main session a wrong list. The last two waves' remedy — "cross-check the body before the merge
button" — was aimed at the artifact that has now stopped failing. Derive both from one place, or
check them against each other; do not check either alone.

**2. A Windows-only `cargo test` cannot verify a `cfg`-gated Rust change.** #1968 passed the full
pre-push hook here and broke the ubuntu and macOS `rust-test` legs at **compile** time: a constant
used by a deliberately cross-platform test carried `#[cfg(target_os = "windows")]`. The failure
signature is worth memorising, because it reads as infrastructure: **matrix fail-fast cancels the
siblings, so three legs report `cancelled` — two of them mid-`Swatinem/rust-cache` — while an
unrelated job stays green.** Three simultaneous cancellations with a survivor is fail-fast, not an
outage, and the real error is one `gh run view --job <id> --log` away. Reading job-level
conclusions alone produced a confident wrong diagnosis here before the log was opened.

**3. "No unfiled deferrals" has a second failure mode: the same deferral filed twice.** Two agents
inside one K-tests run filed #1970 (15:16Z) and #1971 (15:22Z) for the same stale `sidecar.rs`
comment, six minutes apart, neither seeing the other. #1971 is closed as a duplicate. Nothing in
the workflow dedupes filings, and nothing can cheaply — the agents run concurrently and neither is
wrong to file. The cheap control is at the ship stage: **list the issues this group filed and look
for two that describe the same site.**

**4. A document can assert the absence of a thing it declined to measure.**
`docs/perf-gate-results.md`'s new Run 3 closes with "no residual over-budget number and no residual
click-dispatch motion coupling to file a follow-up issue for". The first clause is supported. The
second is not: Run 3 records a single total and **no click/settle split**, while runs 1–2 are
analysed almost entirely in terms of that split and the harness prints it on every run. The PR's
own evidence block has the split, and it is ~98% pre-click wait. Filed as #1974. The general shape
— a negative claim resting on a measurement the same document chose not to record — is the one a
green suite can never catch, because there is nothing to assert against.

**5. Step 3 of this ledger's own loop was skipped by four of the five groups.** "Post one comment
on each `Refs` issue (what landed, what remains)" happened for #1825 and for nothing else: #1831,
#1693, #1455, #1824 and #1727 all sat as open issues with a PR freshly landed against them and no
indication of it, and the wave-7 rows below still read `planned-not-started` days after four of
them merged. Backfilled 2026-09-11. This is the same class as the security-register drift #1969
and #1972 corrected in the same wave — a fact that changed and did not propagate to where someone
would read it — and the sweep's own process document was not exempt from it.

### Wave 0 record

| Step | Result |
|---|---|
| `npm ci` | done; husky armed (`core.hooksPath=.husky/_`) |
| apt recipe + tauri_build stubs | done (webkit2gtk-4.1, libxdo present); Python 3.11 |
| Baseline `npm run typecheck` / vitest / `cargo test` on master | typecheck green; vitest 627 files / 10,531 tests green (the one red, `platform.test.ts`, was this harness's `TANDEM_APP_DATA_DIR` lacking `tandem` in its path — the prefix is now `mktemp -d /tmp/tandem-sweep-XXXXXX`); `cargo test` 215/216 with one environment failure: `the_http_client_ignores_an_ambient_proxy` was defeated by this container's ambient `no_proxy=127.0.0.1,…`, which reqwest honours. Fixed in this PR — the test now clears `no_proxy`/`NO_PROXY` for its duration and restores them. 216/216 after. |
| Hook worktree guards | `.claude/hooks/{typecheck-on-edit,svelte-check-on-edit,related-test,format-on-edit}.sh` |
| `Skill`-in-subagent probe | Workflow subagents (default and `agentType` ones) have the `Skill` tool. `simplify` loads its instructions inline and runs single-pass (subagents have no `Agent` tool for its 4-way fan-out); `code-review` runs as a forked execution and returns findings as text (no `ReportFindings`). The probe's `code-review` call found a real defect in the first draft of the hook guards (backslash normalisation ordering), now fixed. |
| Worktree + symlinked `node_modules` probe | A worktree under `.claude/worktrees/` with `ln -s` `node_modules`: `npx husky` arms `.husky/_/pre-push`; `tsc`, `svelte-check`, `biome`, `vitest` and `npm run test:e2e` all run. One environment fix was needed for E2E: this container ships Chromium build 1194 under `$PLAYWRIGHT_BROWSERS_PATH` while `@playwright/test@1.58` looks for build 1234 in the newer `chrome-linux64` / `chrome-headless-shell-linux64` layout, so every launch failed. Aliased in place rather than downloaded; the workflow's E2E stage repeated the alias when needed (removed in wave 2 — the stage now runs `npx playwright install chromium` when a build is missing). |
| Auto-merge repo setting | asked of Bryan; until enabled the loop merges via API when green |
| Decisions recorded | `decisions.md` + comments on #1827, #1753, #1754, #1813, #1787, #1788, #1748, #1820 |
