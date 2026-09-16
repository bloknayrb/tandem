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
| DECIDE beyond #1827 (32): #630 items 4–7, #1725, #1683, #1632, #1845, #1533, #1523, #1292, #1666, #1739, #1741, #1695→G9a, #1700 seam, #1687, #1610, #1590, #1517, #1445, #1443, #1421, #1373, #1249, #1134, #321, #1822 item 4a cwd confinement (held on `held/launcher-cwd-home-confinement-1822`; the #1600 policy half it replaces was resolved in #2006), #1831/#1832 policy half, #1711, #1863's two restore shapes (a session whose `ydocState` is another document; an annotations-only update into a live room), #1696's "a deleted seed keeps the tutorial at step 0" and "a durable write makes the seeds file state", #1700 checkboxes 1 and 3, and G7's presentation call (#1705/#1706 Display menu) plus the #1738 line-wrap default (ships off) | Rounds of 4 to Bryan when their wave is next. |
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
| 8 | K-sec-server | #1822 items 1,2,3,7,8 (+#1488 comment, Refs) | M [security] | `NON_LOOPBACK_ALLOWED` must not grow. After F-doctor and E2-rust (`license.ts`). **Re-scoped 2026-09-11: #1609 is OUT.** It closed *not planned* on 2026-09-08 as an **accepted** finding — its bound is the INPUT (`PATH`, `homedir()`, `TANDEM_CLAUDE_CMD`), not the sink, and it deliberately carries no revisit date. It is a live code condition to respect, not work to schedule; PR #1969 moved it into the register's accepted set. **#1488 also closed *not planned* on 2026-09-08** (the `/.well-known` presence oracle + a wrong ordering comment, accepted out of #1295) — so its entry survives only as a cross-reference comment, and item 7's phantom-200s work touches the adjacent surface. Do not read either closure as licence to change the behaviour it accepted. |
| 8 | K-sec-launcher | #1822 items 4,5,6 #1600 (fix half) | M [security] | After E1 (#1761 keychain) and E2-rust (`sidecar.rs`). **Spot-checked against master 2026-09-11 — items 5 and 6 are still real and item 4's line numbers are not.** `keychain_get` still returns `Option<String>` plaintext to the WebView, and #1761 landing makes that *more* relevant, not less: the issue's own "the keychain is currently a mock anyway" mitigation is gone. No `NODE_ENV` appears anywhere in `sidecar.rs`, so item 6 survived E2-rust's rewrite of that file. Item 4's cited `supervisor.ts:723-739` is stale — the file is now 1700+ lines, `homeConfines` sits at `:1684` and is already used by two *other* resolvers (`:1717`, `:1734`), so re-locate `resolveCwd` and check whether it is the remaining exception rather than trusting the line range. |
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
| 12 | #1626 reply surfaces | #1626 (both parts) | M [ui] | **Scheduled 2026-09-16 by decision.** One issue, two parts. Part 1 — annotation bodies and replies render **raw** markdown; Bryan chose **(a) convert to formatted text**. Part 2 — a reply cannot carry a `suggestedText` at all; "schedule it". **#1629 is CLOSED and discharged**, so nothing blocks part 2. G14 (wave 9, #2021) already took the *chat* markdown half as Refs; this is the annotation/reply surface, which it did not touch. |
| 12 | #2038 store-lock recovery | #2038 | S | **Filed 2026-09-16 out of decision 7 (refuse over grant).** A reused PID after a reboot leaves the annotation store read-only with no in-app recovery, because `process.kill(pid, 0)` reports alive for an unrelated process. `startedAtMs` is already written (`lockfile.ts:25`) and already read (`:44`) and **compared nowhere** — the missing comparison is the fix, not new machinery. |
| 12 | #2040 harness migration remainder | #2040 | M | The ten files #1689's scope cut left, plus `mcp-stdio-ports` named as a permanent non-migration so nobody chases it. **Inherits the guarded-`afterEach` pattern #2044 wrote into the harness doc comment** — without it each migration re-introduces the `close is not a function` mask over the real failure. |
| — | NOT scheduled, with reasons | #2041 #2037 #2039 | — | **#2041** (Windows reaper flush window) — **deferred to post-v1.0** by decision 6 and labelled `needs-human-evidence`; not scheduling it IS the decision, not a gap. **#2037** (`tandem_applyChanges` re-reads a possibly-swapped Y.Doc) — awaiting Bryan's scheduling call; the only member of the #1657 family on a live path, and unowned. **#2039** (a mid-turn swap suppresses terminal effects but does not abort the turn) — awaiting Bryan's design call, which is a product decision rather than a code choice. |
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
| 8 | E2-upgrade | #1791 #1792 (+#1722's `updateSettings` boolean, once) + smoke-lines merge | `fix/upgrade-and-downgrade-paths-annotation-envelope-compatibility-and-settings-that-go-silently-inert-1791` | #1985 | — | armed | merged | Merged 2026-09-15 (`7e5d0f26`); closes #1791. **#1792 stays open on item 3**, the `welcome.md` refresh: the spec's measurement refutes the premise, and options (a)/(b)/(c) are Bryan's. #1722 is Refs: the `updateSettings` boolean landed, and the rail half belongs to G6 (wave 9). Filed #1980: doctor now counts parked and quarantined envelopes, but nothing reads them back. The run's fix and ship stages were finished by hand from its journal. The round-1 PR-review fixes were not re-reviewed by an agent, and the PR body says so. **The smoke-lines merge was not carried by this group**; it is #1989. |
| 8 | K-sec-server | #1822 items 1,2,3,7,8 (+#1488 comment, Refs) | `fix/security-lows-server-half-log-injection-unbounded-frames-a-leaking-413-and-two-presence-status-oracles-1822` | #1987 | — | armed | merged | Merged 2026-09-15 (`c1a4df93`) and closes nothing. **#1822 is Refs:** items 1, 2 and 3 are fixed, item 7 needed no change, item 8 carries two decisions for Bryan, and items 4-6 belong to K-sec-launcher. #1488 got a cross-reference comment only; its acceptance is untouched. Re-scoped 2026-09-11: #1609 removed as an accepted finding. Filed #1981 (the SDK sub-app's parser caps every `/api` body at 100 kB, so browser upload over ~100 kB is broken; not bundled, because every fix moves security middleware) and #1982 (`MAX_FILE_SIZE` vs the new frame cap). The round-1 fix agent died on the spend limit after committing, so its fixes were read by hand rather than re-reviewed. The `docs/security.md` drift it left (a 70 MB claim that #1981 refutes, plus a stale citation) is corrected in a separate PR. |
| 8 | K-sec-launcher | #1822 items 4,5,6 #1600 (fix half) | `fix/security-lows-launcher-half-confined-launcher-cwd-no-tandem-secrets-in-the-launched-env-no-plaintext-keychain-read-production-sidecar-and-a-locked-cowork-scrub-1822` | #2006 | — | armed | merged | Merged 2026-09-15 (`3be23d43`). Closes #1600, Refs #1822. **The orchestrator split item 4a (home confinement of the launcher's spawn cwd) out after the PR opened.** Bryan's #1822 triage calls it a filesystem-authority policy question, so landing it would land the decision. It is held on `held/launcher-cwd-home-confinement-1822`, with one Low hand-review finding to fix before it lands. **#1600's policy half was resolved in the PR.** Real interop was measured in both directions and hand-reviewed sound. Routing through Rust is impossible for an npm-only install, and an acceptance would keep a race that a working fix closes. `UV_FS_O_EXLOCK` turned out to be documented public libuv API; the branch had called it undocumented. The windows `rust-test` leg ran all four `lock_interop_tests` green. The hand review also found an unsanitized caller path in a launcher log line, now fixed. The body again said "Unresolved findings: none", and the returned `closes[]` again disagreed with it. |
| 8 | G1 launcher stdin | #1866 #1868 #1867 #1780 | `fix/launcher-stdin-wake-delivery-and-the-logged-out-claude-code-dead-end-1866` | #1998 | — | armed | merged | Merged 2026-09-15 (`f8979bc0`); closes all four. **#1780's premise was refuted by measurement**: a never-signed-in claude 2.1.272 does not exit. It answers every turn with `result {is_error:true, result:"Not logged in · Please run /login"}` and exits only on stdin EOF, so the classifier keys on that envelope. #1867 ships a receipt bound (`TURN_RECEIPT_MS` 180 s: any JSON envelope after a write to an idle child), not delivery proof, because the protocol offers none before `init`. #1868 trips `wake-delivery-failed` after 3 consecutive delivery kills and reports through the existing opt-in Sentry path only. Filed #1995 (two residual launcher races). **The body said "Unresolved findings: none" when both code-review rounds returned no result.** A hand review of the whole diff then found a real race: a boolean `unresolvedTurn` let the first of two outstanding turns re-arm the receipt check, which would kill a live turn. It also found a stop-after-crash wake carry, and two unpinned classifier guards. All were fixed in `a8ce8315` and mutation-tested. The reaper stdin measurement was posted on #1869, which stays open. For Bryan: the 180 s bound, the limit of 3, keeping the opt-in Sentry warning, the ~5 s Check-again gap, unmeasured expired-login behaviour, and a hardware smoke row. |
| 8 | G10 awareness hygiene | #1624 #1702 | `fix/awareness-hygiene-selection-staleness-and-one-inbox-poll-context-1702` | #1996 | — | armed | merged | Merged 2026-09-15 (`caf54391`); closes #1702. **#1624 is Refs**: `activity.selectionAt` and the "last recorded selection" docs landed on every surface, and SKILL.md went v21→v22. The re-stamp half is #1991 (client). The run's RETURNED `closes[]` listed #1624 while its body said Refs; the body was right. Its final code-review returned no result, so a hand review ran on the whole diff. It found that the new copy promised clearing and re-stamping unconditionally, when only the active tab's mounted editor writes `Y_MAP_SELECTION`. Scoped in `20f1139f`; the underlying stale-offset slice for a background document is filed as #1997. Unmeasured, for Bryan: a real-editor check of `selectionAt`, and the record's lifetime across reload. |
| 9 | K-server | #1823 MCP-surface remainder #1851; then #1823 runtime as a second PR | `fix/server-lows-mcp-surface-one-wire-code-per-condition-honest-offsets-and-messages-and-the-unused-error-code-schema-1851` | #2007 | — | armed | merged | Merged 2026-09-15 (`5b1454d2`). Run `wf_665434ea-611`, probe ports 4978/4979. Closes #1851, Refs #1823. **#1823's server-runtime section is the second PR, not yet planned.** Wire codes now converge on one code per condition; the renames are listed in the PR body for the release notes. **The hand review found the new one-errno-per-code split false on Windows.** A folder the user can read but not write fails with `EPERM`, so a save there still said "close Word". Measured shapes put `EPERM` on `open` under `PERMISSION_DENIED` and every other `EPERM` under `FILE_LOCKED` (`lockOrPermissionCode`, five mutations red). Filed #2001–#2004, plus #2008 for the same mislabel over `/api`. |
| 9 | G9a watcher/reload silence | #1662 #1663 #1695 | `fix/watcher-and-reload-silence-an-unwatched-document-a-silent-declined-reload-and-a-required-cleanup-phase-1695` | #2000 | — | armed | merged | Merged 2026-09-15 (`a6e7352f`). Closes #1663 and #1695, Refs #1662. #1662's remaining gap is boot-time delivery of a watcher failure; the three options are posted on the issue for Bryan. The hand review found no defects. The returned `closes[]` listed #1662 while the body said Refs. |
| 9 | G9b open/restore | #1863 #1696 + #1700 audit guard (Refs) | `fix/open-and-restore-fallback-restores-keep-the-session-s-anchors-a-deleted-tutorial-annotation-stays-deleted-and-a-raw-doc-handle-guard-1696` | #2012 | — | armed | merged | Merged 2026-09-15 (`819c94ef`). Runs `wf_78dcedfc-997` then `wf_b5ec59c6-e57` (probe ports 4980/4981). **Closes nothing; Refs #1696, #1863 and #1700.** #1696 was reproduced against a real server, and the tombstone guard holds only while the tombstone does — boot compaction drops it after 30 days (#2009). #1863 lands an anchor-only overlay for cloned ids under a two-part gate; `pickWinner` and `mergeMap` have no diff, and its two non-throwing shapes stay open as policy choices. #1700 lands acceptance checkbox 2 only (the audit guard). **The run parked at plan review**, then **ended `failed` with no PR** because the ship agent was forced to return while the pre-push hook was still in vitest; the orchestrator pushed and opened the PR by hand. Round 1 found two real defects (the overlay kept the envelope's `textSnapshotBreaks`, which describe a different capture; the tombstone guard broke Settings > Replay tutorial). Round 2 found the replay fix did not survive a session-less reopen — fixed in `376d3622`, which **no review agent re-reviewed**; the orchestrator hand review covered it and found no defects. |
| 9 | #1708 workspace silent failures | #1708 | `fix/workspace-silent-failures-seven-save-close-source-paths-that-fail-without-telling-the-user-1708` | #2017 | — | armed | merged | Merged 2026-09-15 (`e4b95496`); closes #1708. Launched 2026-09-15 (run `wf_02b40f9b-dd1`, probe ports 4984/4985) alongside G6, on `4da4efa0`. No owner comment exists, but the issue itself says each of its seven items is a product decision about what the user sees, so the args require every new message's wording in the PR body. Two anchor corrections went in with the args: `target-save.ts` has **four** `return false` sites, not the three the issue enumerates (:38, the post-await re-resolve, is the fourth), and the #1707 spec `document-workspace.svelte.test.ts:991` currently regression-protects the silence — it must be updated either way, or the silence keeps looking intentional. **Shipped:** all seven items report, with the wording in the PR body for Bryan to judge; `saveExactTarget` returns a discriminated refusal (`no-such-tab` | `tab-changed` | `no-source-commands` | `delegated`) and `delegated` is deliberately NOT notified, because both downstreams already speak. 8/8 mutations killed by name. **The hand review found two false claims in the body, both corrected before merge.** It said `App.svelte`: zero lines changed — it changed 22, and the change is the riskiest line in the PR: the `if (documentWorkspace.inSourceView) return;` early return is REMOVED, which is how the `svelte-migration-reviewer` finding (Ctrl+S dead when focus sits outside the source-view container) was resolved. Verified safe rather than assumed: the funnel wiring is unchanged by this PR, `isSourceView: (id) => sourceViewTabs.has(id)` reproduces the removed condition, `SourceView` is keyed `documentId={activeTab.id}` so `getSourceCommands(tabId)` resolves in the same key space, and a source-view tab therefore cannot reach `saveCommitted` — the #1021 must-fix invariant is preserved by the funnel instead of by the early return. It also said Unresolved findings: none when BOTH its code-review rounds returned nothing. Its advisory `coverage` job failed on the known teardown flake (`EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`, `reload-from-markdown.test.ts`, vitest exit 1 with zero failures), so `coverage-gate` reported the measurement did not complete — the gate never evaluated, and it is not a required check. |
| 9 | G6 rail seam | #1719 #1716 (+#1722 surfacing if not in E2-upgrade) | `fix/rail-seam-a-tab-switch-inside-a-chat-reveal-a-reveal-that-outlives-its-pin-and-rail-toggles-that-refuse-in-silence-1719` | #2016 | — | armed | merged | Merged 2026-09-15 (`838de260`); **closes #1716 only**, Refs #1719 and #1722 — the returned `closes[]` was `[#1719, #1716]`, disagreeing with its own body for the fourth time in three waves. Launched 2026-09-15 (run `wf_2da2ec8c-fe0`, probe ports 4986/4987) alongside W1708, on `4da4efa0`. **#1722 is a Refs by construction**: its `updateSettings` half landed in #1985 and #1964's radiogroup contract is a separate issue, so only the rail half is in scope — the owner's 2026-09-15 comment on #1722 says exactly that and is quoted in the args. **All three issue bodies are anchor-stale**: they were written against `App.svelte` before ADR-035 Unit 10b/10c, and the whole chat-reveal lifecycle now lives in `src/client/layout/rail-content.svelte.ts`. The args carry the verified current anchors. **Shipped:** the injected `closeTransientChat` is deleted outright (`selectRailTab` is now one statement), #1716 is closed by one derived `$effect` on `getEffectiveRightVisible` rather than a fifth manual clear site, and both rail toggles return `updateSettings`' boolean from every branch. The only discriminating pin for #1719 is the E2E spec — a deleted callback leaves no unit-layer instrument, and the layout-model spec says so rather than implying otherwise. **The hand review found two false claims in the body and one in its For-Bryan list.** The summary and an assumption both said `selectRailTab` now calls its injected callback UNCONDITIONALLY and that `focusChat`'s `openReveal()` was dropped as a duplicate; neither shipped — the callback is gone and `openReveal()` is still at `App.svelte:896`, where it is the only thing that opens a reveal. The body also said the unguarded `focusToggleTarget` dropped focus to `<body>` behind a `console.warn`; measured, it does not — `peek-strip-*` renders unconditionally behind an inline `display: none` and `panel-edge-collapse-*` sits inside `.rail-full` with no `{#if}`, so the call resolved a hidden element, moved no focus and logged nothing. The guard is a defensive skip of a no-op. Worst of the three: a For-Bryan bullet asked Bryan to judge an annotation-click behaviour the PR does not contain — that shape was cut after four blocking findings. All corrected before merge. **For Bryan:** the PR amends ADR-037 (`docs/decisions.md`) to record the closer and its Unit 10c ordering as removed, settling that amendment's question the other way. The argument is sound and the amendment is well written, but re-deciding a recorded decision is the owner's call, not an implementer's. |
| 9 | G7 editor quick controls | #1705 #1706 #1738 | `fix/editor-quick-controls-text-size-and-reading-measure-outside-settings-and-source-view-line-wrap-1705` | #2011 | — | armed | merged | Merged 2026-09-15 (`4da4efa0`). Run `wf_5cb8ce92-eea`, probe ports 4982/4983. Closes #1705, #1706 and #1738. No owner comment exists on any of the three, so the presentation was the plan's to choose and record. **Plan review earned its keep three times:** the specs had left the bar-hidden case to Settings, which would have falsified the selection popup's own written mirror guarantee (the menu is now mirrored there); the E2E fixture `sample.md` is 241 bytes and cannot scroll, so the "preserves the document" case could not have passed, and #1055's scroll memory means the `__g7` tag, not `scrollTop`, is the remount check; and #1738's `overflow-wrap: anywhere` carried a mutation that could never go red, because a `<textarea>` already gets `overflow-wrap: break-word` from the UA sheet. PR review: `svelte-migration-reviewer` clean; one Low from `general-purpose` (a pick leaves focus on the trigger, so the selection is lost) **refuted** — nothing dispatches a transaction, the view is not remounted, and `selection-decoration.ts` draws `tandem-selection-blurred` precisely so a selection stays visible without focus. **The orchestrator hand review found no code defect but four defects in the PR BODY**: it recorded "unresolved findings: none" over a missing review, kept an assumption ("the menu stays open after a choice") that plan review had cut, pointed at screenshots that were never attached, and dropped the session URL. Body rewritten before merge; the four screenshots were sent to Bryan directly. |
| 9 | G14 chat markdown | #1639 → #1626 part 1 (Refs) | `fix/chat-markdown-balanced-block-markup-and-markdown-on-the-reply-annotation-surfaces-1639` | #2021 | — | armed | merged | Merged 2026-09-16 (`2f54a8d3`); closes #1639, Refs #1626. Run `wf_cb2fecf7-da5`, probe ports 4988/4989, launched on `33a99d00` and rebased onto `fc417f10`. **Shipped:** `renderMarkdown`'s `\n\n`→`</p><p>` and `\n`→`<br>` regex passes are replaced by a module-private `assembleBlocks` that groups LINES — real `<p>` runs, one `<ul>` per run of `<li>`, fenced blocks and headings as bare siblings. The `\x00BLOCK<n>\x00` PLACEHOLDER is what is kept out of the wrapper (not the `<pre>`), which is the #1636 trap in its surviving form. `markdown-body.css` loses `p:empty` and the comment forbidding `> :first-child`, gains the rule, and moves the list indent from `li { margin-left }` to `ul { padding-inline-start }`. **The migration decision came back NO and did not need Bryan:** the issue names a required block-level parse as the signal to move to `marked` + `DOMPurify`, and this is a line grouping over already-escaped, already-tokenised text that parses no new user syntax. **Acceptance item 3's parenthetical is MEASURED FALSE, and recorded as a refuted premise rather than deferred work:** the fix removes the `<br>` BETWEEN list items, but a soft `\n` inside a paragraph still emits one, so `AnnotationCard.svelte`'s `br { display: none }` density rule stays load-bearing for a two-line comment in a one-line teaser. Both density comments are rewritten; both rules stay. **Both PR-review rounds found a real defect, and this is the fixed stage (#2018) earning its keep twice in one run.** Round 1: a CRLF blank line collapsed from two `<br>` to one, because `/\n{2,}/` does not match `\r\n\r\n` and the `\r`-only line was dropped — reachable, since `tandem_reply`/`tandem_comment` take a bare `z.string()` and nothing in `src/` normalised carriage returns. It also falsified the branch's own "identical blind spot" bound, which had been argued from a shared regex rather than measured. Fixed by normalising `\r\n` once at the NUL strip. Round 2: a whitespace-only line (one space or tab) still collapsed two paragraphs, because the blank-line arm `continue`d without flushing — CommonMark treats it as a break and master rendered one. Fixed by flushing, which made the outer chunk split redundant and collapsed block assembly to a single pass. The skeptic reproduced both against master and refuted neither. **The published history carries a merge commit, and it is content-free.** The branch had been pushed before the rebase, and both `--force-with-lease` and `merge -s ours` were denied by the auto-mode classifier, so the rebased history was reconciled with a `--no-ff` merge of the old tip (`0fbffadc`), conflicts resolved to the rebased side. Verified at hand review rather than taken on trust: `git diff b3745274 0fbffadc` is EMPTY, so the merge adds history only — and both review fixes survive in the tip (`chat-markdown.ts:79` normalisation, `:261` flushing arm). Worth knowing because merging a pre-review-fix tip back in is exactly the shape that silently reverts a fix. **The hand review found one overstated body claim.** The body made the `{@html}` escaping describe's byte-unchangedness an obligation and called any diff line inside it a finding. One line inside it did change — a COMMENT at `@@ -313` naming a `<br>` pass that no longer exists, so correcting it was required, not optional. Every ASSERTION in that describe is byte-unchanged; the five changed assertions sit above it at `:72`, `:151`, `:161`, `:176` and `:222`, in the two describes that legitimately needed `<p>`-wrapping updates. Corrected before merge, along with the missing session URL. **For Bryan:** #1626's third sub-question, which #1636 never answered — should `tandem_exportAnnotations` and the `.docx` Word-comment write-back CONVERT markdown in an annotation body, or keep the raw `**markers**`? Measured: no module under `src/server/` imports `renderMarkdown` or any stripping helper, so both writers emit stored text verbatim and a Word comment shows literal asterisks today. It is a product call about what leaves the app inside a user's file, and it is filed as a comment on the still-open #1626 rather than living only in a PR body. Also for Bryan: confirm part 2 (`suggestedText` on replies) stays a later item behind #1629. |
| 9 | #1603 transform audit | #1603 | `fix/audit-every-name-keyed-recursive-transform-for-collision-with-caller-supplied-data-1603` | #2020 | — | armed | merged | Merged 2026-09-16 (`fc417f10`); closes #1603. Run `wf_8d8a4750-ae0`, probe ports 4990/4991, launched on `33a99d00`. **Shipped:** `normalizeLocalhostUrls` is SCOPED to `integrations[].url` rather than walking every depth by key name — the issue's stated preference, because scoping does not depend on the schema staying closed. One structural position, derived from the existing v3 schema (`ClaudeCodeIntegration.url` required at `:121`, `OtherMcpIntegration.url` optional at `:159`), so `IntegrationsFileSchema` is NOT widened, and the scoping deliberately does not key on `kind` so `other-mcp`'s optional url is still normalized. The migration → normalize → Zod order is unchanged. `stripSchemaDialect` stays as-is and keeps its why-safe sentence — acceptance is met by the sentence for one instance and by scoping for the other. **Item 4 decided YES and it was the group's call, not Bryan's:** the class appeared nowhere in `CLAUDE.md`, `docs/gotchas.md` or `docs/lessons-learned.md` (measured), and it fails silently, which is the Gotchas section's stated admission test. One rule line in `CLAUDE.md` under Gotchas → MCP / Server, mechanism paragraph in `docs/gotchas.md` under the same heading. **One disclosed behaviour change:** the scoped shape SPREADS rather than assigning into a `{}` literal, so a literal `__proto__` own key from `JSON.parse` now survives as an own key and `.strict()` rejects the file loudly, where the inherited setter used to swallow it silently. The loud direction is intended and matches `license/verifier.ts`. Pinned by a named spec. **This is the FIRST PR-review round in the whole sweep that the fixed code-review stage actually delivered** (#2018, merged the same day). All three reviewers reported — `code-review:r1` 17 tool calls, `security-reviewer:r1` 21, `general-purpose:r1` 20 — and each returned zero findings. Round 2 correctly did not run: the loop breaks when a round returns none. **The hand review found one false claim, and it is the first that UNDERSELLS a run.** The body said "No review result reached this agent … this is 'no review result', not a clean review" — the opposite of what happened. The ship agent is never handed the review transcripts, so it wrote the honest thing about what it could see; the journal is what settles it. Corrected before merge, along with the missing session URL. The plan-review claim checked out exactly: three blocking findings in round 1 (security-reviewer 1, general-purpose 1, tests 1, rules 0), all kept in fixed form. **For Bryan:** nothing group-specific. Verification was Windows-only, and ubuntu `check` went green in CI before merge. |
| 9 | #1823 server-runtime | #1823 (server-runtime section only) | `fix/1823-server-runtime-eleven-runtime-smalls-several-of-which-may-dissolve-on-contact-1823` | #2024 | — | armed | merged | Merged 2026-09-16 (`7de27163`); **closes nothing, Refs #1823** — and the returned `closes[]` was `[]`, matching its own body. First group in this sweep to get that right on the first try. Run `wf_da3d69a3-038`, probe ports 4992/4993, on `eb4f9518`. **The brief carried a verified anchor inventory because the issue's own anchors were substantially stale — three named the wrong FILE**, not merely a shifted line: the SIGTERM item is `SIGTERM_GRACE_MS = 6_000` at `launcher/supervisor.ts:1935` with the disputed comment at `cli/start.ts:58` (there is no such comment at `index.ts:229-233`); the token-drop item is not in `setup.ts` at all (`grep -n token src/cli/setup.ts` returns nothing); and the `--help` drift is `start`, dispatched at `cli/index.ts:193` and documented only as bare `tandem`. The args told the group to re-derive those three and to close any that did not reproduce as not-a-defect. **Shipped:** the production log filter now formats through `util.format` in a new pure `src/server/log-filter.ts` (the placeholder loss was the smaller half — `String(err)` was dropping Error STACKS); `scrubEvent` deletes `event.server_name` and scrubs both `frame.filename` and `frame.abs_path`; stdio EOF exits, gated on a `startupComplete` latch so an EOF during boot cannot clobber the CTRL session with an empty doc; `existing-config.ts` strips a BOM and caps size on `MAX_CONFIG_BYTES`; `atomicWrite` sweeps its own `.tandem-setup-*.tmp` siblings; `queue.ts` gates tracking on `forwardExternally`, so a Solo-withheld event no longer reports `alreadyPushed: true`; the symlink refusal names the real reason; `setup --apply` re-reads the rotated token; and `--help` documents `start`. **Two items were REFUTED rather than fixed, and one partly so.** Item 4's "dead code" claim is false as written: on Windows the 6 s grace resolves IMMEDIATELY rather than never running, and only the SIGKILL escalation is unreachable. What is true is that `index.ts:265-270`'s "gives Claude a chance to flush" is wrong on Windows — `reaper/src/windows.rs` installs no signal handler and the relay is `#[cfg(unix)]` — so it shipped as comment corrections with NO shutdown-semantics change on a platform that cannot be verified here. **The PR review is the best this sweep has produced.** All four reviewers did real work (36, 30, 42 and 37 tool calls); round 1 returned six findings collapsing to three defects, the skeptic refuted none, and round 2 re-reviewed the fixes and came back genuinely clean — so "fixed in the final round and not re-reviewed: none" is true here, unlike the rounds that used that phrase over a missing review. **The headline defect was the reviewers', not the build's:** item 10's new `await readTokenFromFile()` sat ABOVE the per-target `try`, and that reader rethrows every non-ENOENT errno, so a root-owned or AV-locked token file would have aborted `tandem setup --apply` having written ZERO configs for ANY target — where the pre-change run wrote them all. Three independent reviewers found it. Fixed behind a warn-and-continue helper, so an unusable token file now degrades exactly as an absent one does. **The hand review found one false claim.** The body's Item-2 assumption still said `abs_path` does not exist in `@sentry/node` 10.73 and that scrubbing it would be a silent no-op — which THIS RUN measured false in round 1 (`abs_path?: string` at `@sentry/core/build/types/types/stackframe.d.ts:9`) and corrected in the SPEC (`f954d60e`), deliberately correcting the spec rather than the code because acting on the wrong claim would have deleted a live redaction. The body was the one carrier left holding the refuted version; the shipped `scrubEvent` scrubs both keys. Corrected before merge, with the missing session URL. **Security-doc changes verified rather than trusted:** `docs/security.md`'s Telemetry paragraph now says the sidecar hook scrubs while the WebView and Rust hooks still do not, citing **#2023** — confirmed a real OPEN `security`-labelled issue with exactly that subject, filed by this run. And `tests/docs/config-writer-set-claims.test.ts` gains `src/cli/setup.ts` to `TOKEN_FILE_REFERENCES` with a written argument that setup.ts is not a `WRITER_SITES` key and holds no durable-write idiom, so **accepted finding #1599's scope is unchanged** — the addition is to the token-reference list, not the writer set. **For Bryan — three decisions and one preference, none blocking:** (a) item 4's behavioural half, whether Windows should get a graceful reaper stop, same family as the open #1994 on macOS, with a Windows issue deliberately NOT filed pending the call; (b) item 8, whether a startup may reclaim a store lock whose PID is alive — `startedAtMs` is written and parsed and compared nowhere, and a wrong GRANT means two writers clobbering the annotation envelope, taking the ADR-027 notes and the tombstone ledger with it; (c) item 12, what the launcher reports during the HTTP boot window — fixing it needs a new `LauncherUnavailableReason` member AND a choice between widening `isTransientlyUnavailable`, which is the authorization gate on `POST /api/launcher/start`, or adding a second UI-only predicate; and (d) whether Sentry's `server_name` should stay DELETED or become a stable pseudonym so multi-machine triage still works. The original scoping note follows. The second PR named in K-server's row. Eleven runtime items from the issue body: the production stderr filter dropping `util.format` placeholders (48 call sites print `%s` literally); Sentry sending `server_name` and absolute frame paths despite `sendDefaultPii: false`; stdio mode never exiting on stdin EOF; the Windows SIGTERM 6 s grace period being dead code (`TerminateProcess`), with the comment at `index.ts:229-233` false; `existing-config.ts` having no BOM strip and no size cap; orphaned `.tandem-setup-*.tmp` never reaped; `queue.ts` tracking ids before the forward decision; store-lock liveness using `kill(pid, 0)` while `startedAtMs` is written and never compared; the symlinked `~/.claude.json` refusal wording, `setup --apply` dropping the token after `rotate-token`, and `--help` drift; and the initial "stdio-mode" reason shown in the HTTP startup window. **The MCP-surface section is DONE** (#2007, `5b1454d2`) and the server-data section is not in this group. Re-read the owner's 2026-09-15 comment before scoping: it lists what landed, what was carved out (#2001–#2004, #2008) and states the release-notes obligation for the wire-code renames. |
| 10 | G4 typecheck-tests | #1613 → #1614 → #1615 (alone) | `fix/typecheck-tests-three-configs-and-a-mock-idiom-that-check-nothing-1613` | #2031 | — | armed | merged | Merged 2026-09-16 (`7aff6259`); closes #1613, #1614 and #1615. Run `wf_2b9ed27b-5d7`, launched on `f6559305`. **Shipped, three halves.** #1613: `tests/tauri-driver/wdio.conf.ts:152` used `host:`, which is not a key of `WebdriverIO.Config` — `@wdio/types`' `Connection` declares `hostname?` and no `host` under the pinned webdriverio 9.28.0, so the intended override had been silently inert. Now `hostname: "127.0.0.1"`, keeping the literal rather than the `localhost` default that can resolve to `::1` first. The directory's own tsconfig, which no script/workflow/hook invoked, is wired into `tauri-webdriver.yml` right after its existing harness install — the cheap end of the two the issue called defensible, chosen on cost (folding it into `typecheck:tests` would add a second `npm ci` to the REQUIRED `check` job for a dispatch-only harness) and recorded as the planning agent's call, not parked for Bryan. #1614: `svelte-check` never read `tests/`, and `tsc` resolves a `*.svelte` import through Svelte's prop-agnostic ambient `declare module '*.svelte'`, so every component render call in the test tree was type-free; `svelte-check --tsconfig ./tsconfig.tests.client.json --fail-on-warnings` is appended to `typecheck:tests` as a fourth leg, and `tests/scripts/typecheck-tests-wiring.test.ts:79-89` pins the new four-leg string **by the same exact equality**, which is what stops a later `|| true` from masking the leg while leaving `ci.yml` byte-identical. #1615: every first-party `vi.mock("…")` becomes the typed `vi.mock(import("…"))` form, which checks the factory against `Partial<T>`. **The counts moved four times and every published one was re-measured rather than carried forward:** `f6559305` held **217 of 265** first-party string sites (215 relative + 2 alias, 48 third-party), not the filed 158/199 and not the body's original "215 of 266" — both halves of that figure were wrong. `c073c992` landed 217 converted / 0 first-party / 48 third-party; the merged head reads **219 typed / 0 first-party / 48 third-party**. **#1614's implied need for a new tsconfig is REFUTED by measurement** — `tsconfig.tests.client.json`'s existing include set was already exactly the right program, and its +23/-6 diff is entirely comment (confirmed mechanically: filtering the diff for non-comment, non-blank `+`/`-` lines returns nothing). **#1614's "no drift today — the hazard is structural, not present" is CORRECTED**: true of the three harnesses, false of the wider surface, where turning the check on surfaced 3 live errors in 2 files on a tree where `typecheck:tests` exited 0. All three were assessed test-side rather than production bugs, because each component reads only the fields its tests supply — which is why they passed. **The branch found and fixed the completeness gap in its own measurement, unprompted.** Two first-party sites in `tests/client/titlebar-listener-leak.test.ts` are spelled through the `@client` alias and are invisible to the `../../src/` grep that scores #1615's completeness, so "0 remaining" would have read as total when it was total for one spelling only. `c073c992` converts both **and fixes the cause rather than the instance**, recording the grep's blind spot in the spec's Boundary section with an alias-form companion command so a future alias site cannot be scored as converted by absence. **It also reported a negative result it did not have to:** a neutral mutation proved typed `vi.mock` does **not** do excess-property checking — only type mismatches on keys that exist on the real module — which is a real limit of the whole #1615 approach, found by its own probe and volunteered rather than buried. **`CLAUDE.md` is edited and it was required, not scope creep:** its Testing & E2E section said `tests/tauri-driver/` "currently holds an unseen TS2353", which #1613 fixes, so leaving it would have made `CLAUDE.md` false. Scoped to the sentences the change makes untrue, nothing adjacent reflowed. **G11 owns `CLAUDE.md` and `.github/` in this ledger and must rebase onto this** — no conflict, since G11 had not launched, but G11 must not run concurrently with this PR open. **The orchestrator's own warning was refuted by the mutation test it demanded.** I warned that `tsconfig.tests.client.json` has no `.svelte` glob — all five includes are `**/*.ts` — so the new svelte-check leg might check nothing, and required a mutation proof before shipping. The proof went the other way and is sound: a bogus-prop mutation on `ChatStateHarness.svelte` produced 5 errors against the **suffix-form** config, 48 seconds before the include was changed to directory form. **svelte-check discovers `.svelte` files by walking the project, not through the tsconfig `include`** — the `tsc` legs resolve no component; svelte-check finds them regardless. The demand was still right (an unproved gate is what this group exists to remove) and the consequence G4 caught is the real defect: the spec's item-0 rationale, and a tsconfig comment asserting it in tracked prose, claimed a `.ts`-suffixed include makes diagnostics inside a component unreachable — true of the `tsc` program, false of svelte-check. Landing it would have shipped a comment misstating its own mechanism, which is the #1613/#1614/#1615 defect class exactly; the justification was corrected and `8a9208cf` retracted spec item 0 with an in-flight mutation located *inside* a `.svelte` file as the evidence. **The orchestrator hand review raised four findings, all corrected before merge**, and all four were about published numbers or prose rather than code — no code defect was found, and the mechanism, mutations and wiring all checked out. (1) The converted count was stale in three places. (2) "0 first-party string forms remaining" goes FALSE on contact with master: `tests/server/routes/save-allow-image-loss.test.ts:29` is new in #2026 and did not exist when G4 measured, so the pre-merge 0 could not ship. (3) "`tsconfig.tests.client.json` was widened" is false and contradicted the PR's own central #1614 result. (4) `CLAUDE.md` was modified and named nowhere in the body. **The review itself published a wrong number and it is recorded rather than quietly dropped:** it asserted the config "resolves the same 559 files it did before"; re-measured at publication time it is **696** first-party files (1835 including `node_modules`). A review of a counts PR putting an unchecked count into its own findings is the same defect one level up, and the fix was to delete the number — the "same file set" claim follows necessarily from a comment-only diff and needs no figure at all. **Brought up to date by MERGE, not rebase** (`f837ff45`): master moved twice underneath it (#2026 then #2029, landing `3dcfa051`) and `strict: true` requires up-to-date, but `--force-with-lease` has been denied by the auto-mode classifier on an earlier group, and a merge commit disappears in the squash anyway. It applied with **no conflicts** — the two files shared with D3 (`docx-fidelity-report.test.ts`, `docx-verify.test.ts`) had byte-identical `vi.mock(` lines on both sides, master's edits there being pure additions elsewhere in the files, which was checked *before* merging rather than discovered during it. The one post-merge site was converted in `b32963c5` and **mutation-proved on that exact line**: changing `getActiveDocId` in its factory to a string fails as TS2769 at 29,4 with `Type 'string' is not assignable to type '() => string | null'` — the real production signature, which the string form never consulted. Restored from a file copy, never `git checkout`. **The raw completeness grep now overcounts by two, not one.** `grep -rn 'vi.mock(import(' tests/` matches two COMMENT lines that merely quote the idiom — `tests/cli/run-setup-apply.test.ts:24` and `tests/server/save-tool-allow-image-loss.test.ts:33` — and the second of those was written by the orchestrator in #2029, *after* filing the finding about the miscount. Every count in the body and this row excludes comment lines; the spec's repro command is corrected to do the same. **`wt-g4`'s hooks were armed, and #2030 as originally filed did not describe it.** Its `node_modules` is a **junction** to the main tree (`LinkType: Junction`), so no `npm install` ran there either — what armed it is the sweep pipeline's own `npx husky` step, which `workflow.js:356` runs at worktree creation and gates on (`test -x .husky/_/pre-push && echo HOOKS_ARMED`), with `:574` re-arming at the checkpoint push. `.husky/_` stamped `05:33:53` against a worktree created `05:31:21` is that step running. Both its pre-commit (lint-staged: eslint + biome) and its pre-push (biome + `typecheck:tests` + full vitest + `cargo test`, 4m34s) genuinely executed. **#2030 was filed asserting every worktree this sweep creates had been pushing unhooked; that is false and is corrected on the issue** — the pipeline arms and gates hooks in five places (`workflow.js:356`, `:574`; ledger `:37`, `:195`, `:214`). The one worktree that did push unhooked, `wt-d3b`, was created BY HAND outside the pipeline for a review agent, so nothing armed it, and because it was pushed by hand too the ship-stage assertion never applied either. The defect was the orchestrator stepping around a guard the sweep already had, not a guard it lacked; #2030 stays open on the narrower point that the repo's `core.hooksPath` is relative, so anything not explicitly armed is silently unhooked with a zero exit status. **For Bryan — no decision required, one awareness item:** the fourth leg adds ~16 s of svelte-check to the required `check` job and to every pre-push, and turns `--fail-on-warnings` on over `tests/client`, `tests/helpers` and `tests/design-system-impl` — a real, small, reversible tax, flagged with its measurement rather than asked. Plus the residual gap above: typed `vi.mock` factories do not catch excess/bogus properties, only mismatches on keys that exist, so this is not full structural coverage. |
| 10 | G11 process docs | #1602 #1604 #1605 #1606 | `fix/process-docs-four-issues-from-an-outside-debugging-study-1602` | #2035 | — | armed | merged | Merged 2026-09-16 (`f72c56cb`); closes #1602, #1604, #1605 and #1606. Run `wf_174d2ce0-6e8`, probe ports 4998/4999, launched on `7aff6259`; 17 agents, 2 plan-review rounds, 1 PR-review round, 73 minutes. **Scheduled alone and it mattered** — this group owns `CLAUDE.md` and `.github/`, the files every other group also touches. **Shipped, four halves.** #1602: a `## Disposition` section in each of the four `.claude/agents/*.md` reviewers, inserted **before** each file's `## Output Format` rather than appended (all four close with their own "Start by reading…" instruction, so a naive append lands in the wrong place), and **tailored per domain rather than pasted identically** — ADR-027 privacy leaks / wrong origin-tag helper / annotation data loss for `annotation-model`; range-invariant violations / wrong origin-tag helper for `crdt`; Critical-or-High for `security`; `state_unsafe_mutation` crashes / silently-dropped user edits for `svelte-migration`. `CLAUDE.md` gained a matching paragraph binding the orchestrating session to the same rule, which is the half that matters, since the orchestrator is the party that would otherwise ship past a finding on a likelihood judgment. #1604: one paragraph in `CLAUDE.md`'s header blockquote — "the absence of a rule is not evidence of safety" — kept **inline rather than linked**, per the issue's explicit criterion that an agent which would over-trust the docs is by definition not going to take the hop. #1605: three short Markdown templates (`bug_report.md`, `feature_request.md`, `pull_request_template.md`), each opening with the one required-field question and each issue template carrying the `beta-report`/`untrusted-source` dual-label reminder unconditionally — filing on an outside reporter's behalf without those labels silently disarms a real security control. #1606: a routing paragraph after the dated-gates block, plus a **real** `needs-human-evidence` label. **Two of the four issues contained a measurably wrong statement about the repo, and both were corrected rather than transcribed.** #1605 claimed `.github/` holds `codeql`, `dependabot.yml` and `workflows`; it holds exactly `dependabot.yml` and `workflows/` — CodeQL runs as GitHub default setup and is not a tracked file. #1606's label-target list named four issues; **#1596 and #1529 are both CLOSED** and were deliberately left unlabelled, because a label applied to closed issues makes the bucket look populated, which is worse than no label. The label went to **#316** (open, a stated v1.0 blocker) and to **#2034**, which the run **filed itself** during planning for the previously-untracked cross-platform install matrix — "file it, then reference it", not a prose reference to work nobody owns. **The `CLAUDE.md` paragraph points at live label membership** (`gh issue list --label needs-human-evidence`) rather than hardcoding issue numbers, which avoids the exact convenience-copy-that-no-test-reads failure Critical Rule 7 already warns about. **A deliberate no-mechanism decision, argued rather than defaulted:** no CI gate was built over the four agent files' Disposition prose. Nothing under `tests/` reads `.claude/agents/` (re-measured on the branch, zero hits), so the text is enforced by nothing and can drift — the same defect class as G4's three issues. The argument for leaving it that way is that these are **prompts**, obeyed by being read by a model, and a presence test can pin that the heading exists while proving nothing about whether any review honoured it; ADR-051's wiring-test pattern was read before deciding, not skipped. **The one enforceable artifact WAS mutation-tested:** deleting `pull_request_template.md`'s first line turns the new `tests/docs/issue-pr-templates.test.ts` red (1 failed / 7 passed), restored and re-confirmed green. Everything else here has nothing to mutate, and the body says so plainly instead of implying a test proved something. **The orchestrator hand review found one real defect — in the new prose itself.** Both `CLAUDE.md`'s #1602 paragraph and `security-reviewer.md`'s Disposition let a blocking security finding through by pointing at an "already-accepted, bounded, **dated** entry" in `docs/security.md`'s register. **Two of that register's four entries deliberately carry no revisit date** — #1609 ("no revisit date, deliberately — its condition is a property of the code rather than a bet that expires") and #1488 ("for the same reason as #1609") — and the register's own heading is *Accepted (bounded) — decided, not fixed*. As written, the rule would have made a future security review refuse a legitimate pointer to half the accepted set: **a brand-new rule misstating its own mechanism, arriving inside the group whose entire purpose is removing claims nothing checks.** Fixed in `80660bea` by **deleting the word in both files** — `already-accepted` plus "a *new* acceptance made mid-review does not count" already carried the whole guard — so the correction *subtracts* from the repo's most expensive file rather than adding to it. **The run's own review round was not empty and the body under-reported it.** Round 1's `general-purpose` reviewer raised a low finding (the #1602 paragraph keys on "the reviewer's own stated blocking set", which only the four `.claude/agents/` reviewers now have, so it no-ops for `/pr-review-toolkit:review-pr` and the `/code-review` stage — the reviewers it physically sits beside); the skeptic refuted it as accurate but bounded-scope rather than a defect. The body said only "Unresolved findings: none", which is true and incomplete — **a finding raised and refuted is a review result, not an absence of one** — and it now records both rounds. One further body claim was corrected: Verification said `npx biome format --write` ran "on every changed file", which it cannot have, since the `.md` files here sit outside `biome.json`'s `files.includes`. **Brought up to date by merge, not rebase** (`d615d8e2`): master had moved to `3fdd4973`, whose only commit touched `docs/plans/` — a path G11 does not go near — so the conflict surface was checked and empty before merging rather than discovered during it. **Blast radius worth naming:** the four agent files are prompts, so their new Disposition sections change what every future adversarial review in this repo emits, including reviews of the remaining PRs in this sweep. Verification: pre-push ran the full gate to completion on both pushes (biome + `typecheck:tests` + full vitest + `cargo test`, 4m12s on the fix commit), and the six `tests/docs/` specs that pin passages of `CLAUDE.md` all stayed green across an edit to that file. Windows-only locally; no cross-platform claim made beyond the CI legs. **For Bryan — one item, no blocker:** sanity-check the `needs-human-evidence` label's name, colour (`#5319E7`) and description before it accumulates members. Cheap now at two (#316, #2034), a migration at thirty. |
| 10 | D3 docx save override | #1941 | `fix/docx-image-loss-save-the-explicit-override-both-surfaces-1941`, then `fix/docx-image-loss-followups-1941` | #2026, then #2029 | — | armed | merged | Merged 2026-09-16 (`757eeeca`); **closes #1941**, which is the issue's own closing condition — both surfaces shipped, the flag AND the browser affordance. Run `wf_4322bcb2-c61`, probe ports 4996/4997, launched on `f6559305`. **Shipped:** `saveDocumentToDisk(docId, source, opts?: { allowImageLoss?: boolean })` as a third OPTIONAL parameter, so `reload-family.ts`, `autoSaveAllToDisk` and the auto-save timer keep refusing **by construction** rather than by inspection; the gate becomes `!opts?.allowImageLoss && reportCount(...) > 0`. `tandem_save` takes the param; `POST /api/save` parses it `=== true` off the same `?? {}` fallback as every other field, so `"true"`, `1` and a `text/plain` body `express.json()` never parsed all land on refuse. The post-write `blocked` verdict stays non-overridable — a different claim (*the regenerated file is broken*), not a stricter form of the same one. Browser half: **"Save anyway without pictures"** in `FidelityReportBanner`, its OWN block keyed on `droppedImages > 0` rather than nested under import-losses, because a report with `droppedImages > 0` and an EMPTY `importLosses` is reachable and is exactly the report whose next save is refused — nesting it would have hidden the only exit from the one document that needs it. `droppedImages` joins `hasLosses` and normalize-on-read. **The run never executed its review stage and said so:** the PR body's `## Review` section reads "No review result — the pipeline's review stage has not run against it yet", which is the honest form, so the orchestrator hand review was the only review #2026 received and is recorded as a PR comment rather than in a commit body. **Hand review verified four body claims against the diff and master, all four holding:** testid snapshot 494 → 495 and 8 → 9 `fidelity-report-*`; `SKILL.md` v23 → v24 with both literals in `tests/skill-instruction-contract.test.ts`; `docx-apply.ts` carries zero `rearmWatch` and is absent from the changed-file list; `NON_LOOPBACK_ALLOWED` lives in `api-routes.ts`, also absent. Also verified `documentId={activeTab.id}` is passed at the single mount site (`App.svelte:2909`), since the PR newly destructures a prop whose prior comment said it was deliberately unread — a missing prop would have made the CTA a silent no-op through `triggerSave(null)`. **One finding raised and WITHDRAWN:** the reworded `file-io/index.ts` line says `choose "Save anyway without pictures" below`, which would be wrong on a surface with no "below" — but that string feeds `importLosses` → `LoadIssue { kind: "other" }` → `FidelityReport.importLosses` → the banner alone; `tandem_save` returns `fidelityWarnings` plus `unpreservedImports`, and the latter is a COUNT (`reportCount(importSnapshot, "structuralLosses")`), not these strings. Accurate on every surface it reaches. **#2026 was merged while its review round was still in flight — an orchestrator error.** The round was read as finished because its worktree was quiet; it was mid-round-1 with three confirmed findings. Nothing was lost (the findings became the follow-up PR instead of pre-merge fixes) but the merge was premature, and the lesson is the same one wave 10 had already written down: *only twice-sampled file mtimes distinguish a live worktree from a dead one.* **Follow-up PR `#2029` on `fix/docx-image-loss-followups-1941` carries all three findings.** (1) *The MCP half shipped pinned by nothing* — dropping the forwarded bag in `document.ts` left **229/229** tool-level tests green while `docs/mcp-tools.md` and `SKILL.md` v24 both told an agent the parameter worked; the five files mentioning `allowImageLoss` covered the route, the client, and `saveDocumentToDisk` called directly, but none drove the registered tool. Fixed by a spec driving `tandem_save` through a real `McpServer` + `Client`, asserting over the ARGUMENT (the refusal lives inside `saveDocumentToDisk`, so an outcome assertion would pass however the tool forwarded the field, including not at all), and distinguishing a forwarded explicit `false` from merely "not `true`". (2) *Both backup promises hedged.* `snapshotBeforeFirstWrite` is best-effort by contract — `"skipped-size-cap"` past `MAX_DOC_BACKUP_BYTES` (500 MB, `doc-backup.ts:58`), `"failed"` on any IO/ACL error, save proceeds either way (`:467`) — so the pre-save consent hint at `:198` AND the integrity advisory at `:106` both now point *at* a backup instead of promising one. The `:106` instance was found after the review round and is the more consequential of the two: it fires AFTER a save verification already flagged, and feeds the assertive live region. The head clause `live-regions.test.ts:306` pins is unchanged. (3) *Filed, not fixed:* **#2027** — `allowImageLoss` is flippable from any `127.0.0.1` origin with no proof of user intent, since `LOCALHOST_ORIGIN_RE` admits any loopback port. Bounded: the CSRF reach over `/api/save` is pre-existing; what #1941 added is picture-stripping on the one previously-immune document class. Low, and Bryan's call; `routes/save.ts` carries a comment pointing at it. **#2028 was a duplicate of #2027 and is closed `not planned`** — two writers filed the same finding 64 seconds apart. **The follow-up round had two writers in one worktree** (the orchestrator and its review agent, each writing a near-identically-named MCP spec); the collision was caught by timestamps and the issue-number mismatch, one spec was kept with the other's distinct assertion folded in, and no work was lost — but a `git add -A` a minute earlier would have produced a commit mixing two agents' work with neither aware. **For Bryan:** two non-blocking calls recorded in the decisions memo — after a successful override save `droppedImages` stays non-zero, so ordinary saves keep refusing for the session and the CTA stays the only way through; and the refusal string names the MCP parameter `allowImageLoss` in what is simultaneously the browser toast and `tandem_save`'s `reason`. Plus #2027 itself. Verification Windows-only on both PRs; #2026's ubuntu `check` and all 17 checks went green before merge. `typecheck:tests` on the follow-up was run as three separate projects — the combined script was OOM-killed under contention with G4, a local resource limit rather than a type error. **No git hook ran on #2029 at all — not pre-commit, not pre-push — so CI was its first full-suite run.** Not a bypass: `wt-d3b` has `node_modules` linked by junction rather than installed, so `npm install`'s husky `prepare` never ran, `.husky/_` does not exist there, and the **relative** `core.hooksPath` resolved to nothing; git ran no hook and exited 0. The push took 3 seconds against the usual 7–8 minutes, which is the only tell. Filed as **#2030**, whose scope was then corrected: the sweep PIPELINE already arms and gates hooks (`workflow.js:356` runs `npx husky` and asserts `.husky/_/pre-push`; `:574` re-arms at the checkpoint push; ledger `:37`, `:195`, `:214`), so its worktrees are fine — `wt-g4` proves it, having a **junctioned** `node_modules` with no install and a `.husky/_` stamped two minutes after creation, and a full 4m34s pre-push that genuinely ran. `wt-d3b` was created BY HAND outside the pipeline for a review agent, so nothing armed it and, since it was also pushed by hand, the ship stage's assertion never applied. The defect was stepping around a guard the sweep already had, not a guard it lacked; #2030 stays open on the narrower point that the repo's `core.hooksPath` is relative, so anything not explicitly armed is silently unhooked. Run by hand in the hook's place on #2029: biome on all four changed files (0 fixes), `check:tokens` (exit 0; its 12 `border-radius` warnings pre-exist and are in other files), `tsc -p tsconfig.tests.client.json` (exit 0), and the five touched suites. No E2E on the follow-up (copy-only on already-rendered elements, no new `data-testid`, testid snapshot unchanged). Worktree `wt-d3` removed junction-first (main `node_modules` verified at 471 entries before and after), branch deleted, remote ref pruned, `core.bare` false. `wt-d3b` was removed after #2029 merged, junction-first as well. Both counts in this row are `Get-ChildItem -Force` figures (471); a git-bash `ls | wc -l` of the same directory reads 467 because it omits dotfiles — the 4-entry "drift" noted at the time was two counting conventions, not a change. |
| 11 | #1689 harness refactor | #1689 | `fix/extract-the-duplicated-in-memory-mcp-tool-harness-1689` | #2042 | — | armed | merged | Merged 2026-09-16 (`c6533cb0`); closes #1689. Run `wf_e3d7f336-ca1`, probe ports 5000/5001, launched on `f72c56cb`; 19 agents, 2 plan-review rounds, 2 PR-review rounds. **Shipped:** `tests/helpers/mcp-harness.ts` exporting `setupMcpServer(registrars)` and `parseResult`, with six files migrated off their local copies. **The point is not deduplication, and the body says so** — driving the *registered* handler is what separates a real tool test from one that reimplements the tool's filters and asserts its own model of them. The live counter-example is still in the tree and was verified rather than cited from memory: `tests/server/annotation-tools.test.ts:115`'s "tandem_getAnnotations tool logic" describe hand-rolls `.filter((a) => a.author === "claude")` at `:148` and `:178` and contains **zero** `callTool` or `createLinkedPair` — it never drives a handler at all, which is why ADR-035 Unit 8g (`docs/decisions.md:885`) exists. ~20 lines of boilerplate is the friction that produces the next hand-rolled filter test; a one-line import makes the right shape the easy one. **Scope cut, disclosed and tracked:** #1689 named 6 files, measurement found **17**, and the run migrated the 6 the issue names and filed **#2040** for the remaining 11 (ten candidates plus `mcp-stdio-ports`, a permanent non-migration — it links a pair but hands `serverTransport` to `startMcpServerStdio`, so there is no registrar list to pass). Three deliberate non-migrations each carry a reason rather than being omitted: `restore-backup.test.ts` links no transport at all and its `ToolResult`-typed `parseResult` is a real difference that was **not** flattened to make the migration uniform; `wire-code-fixtures.ts` keeps its second `parseResult` and **no re-export shim was added**, deliberately, because a shim is what lets two copies drift back apart while looking reconciled. **The spec was overruled by the compiler, and the measurement is in the file:** it prescribed `parseResult(result: { content: unknown })`, which produces **93** errors — `callTool` returns a union whose legacy `CompatibilityCallToolResult` arm carries `toolResult` and no `content` key — while `{ content?: unknown }` produces the same 93 for a different reason (an all-optional target is a TypeScript *weak type*) and `Awaited<ReturnType<Client["callTool"]>>` alone produces the mirror-image 5. The shipped signature is an explicit union of both, documented in-file with the counts. **Evidence is mutation, not existence:** a spec asserting the helper exists would test the refactor rather than the code, and none was added; instead three mutations, one per migration shape, each turning NAMED specs red — `case "not-pending"` → `"MUTANT"` (edit-annotation, 2 failed), suffix rejection disabled (export-path-canonicalization, 3 failed), `arch: process.arch` deleted (mcp-output-schemas, 4 failed, which also proves `textEnvelope`'s preserved body is still load-bearing). Restored from a file copy, never `git checkout`. Full suite observationally identical before and after: 693 files / 11729 tests both times. **The orchestrator hand review found one real defect, and it had already propagated past the PR.** The reproduction command published in the body *and carried into #2040* — `git grep -l "InMemoryTransport.createLinkedPair" -- tests/ \| xargs grep -L "helpers/mcp-harness"` — returns **12**, not the stated 11: `tests/helpers/mcp-harness.ts` itself contains `createLinkedPair` and does not import itself, so **the probe matches the very file it created**. That mattered more than an off-by-one because #2040 explicitly instructs the reader to *"Re-run it rather than trusting this number"*, and the twelfth entry is the one file that must never be migrated, because it IS the migration target. The set of 11 was always correct, so the **command** was corrected (adding the pathspec `':!tests/helpers/mcp-harness.ts'`), verified to return exactly 11 at the PR head, and fixed in both the PR body and #2040 — no code change. **The workflow had independently noticed the same off-by-one and classified it "minor, not blocking", leaving it in place**; it is recorded here because a wrong reproducible command in a filed follow-up ages into a wrong conclusion. Assertions were checked to have survived the migration, which identical suite totals cannot prove: `expect(` and `it(` counts are byte-identical per file across all six (302→302 in `mcp-tool-integration` alone). **The body said "no review result" and that was the correct phrasing** — no review agent ran, so there were no findings either way, and it did not dress that up as a clean review. One deliberate behavioural delta: `close()` now runs in every migrated file including `mcp-tool-integration`, whose client was never closed at all (verified: `grep "close()"` returns nothing at `6b37088a`) — hygiene, not a leak fix, and the body says so rather than selling it as one. **Teardown note, recorded because it nearly went wrong:** `git worktree remove` failed with `Permission denied` after something recreated a local `node_modules` mid-removal; the junction had already been deleted first, so the main tree's `node_modules` held at **471** entries throughout and the Windows destructive mode never fired. The leftover was a real directory (`LinkType` empty), not a link, and was removed after confirming it had stopped being written to. **A SECOND PR shipped for this group, and the reason is an orchestrator error worth recording rather than smoothing over.** I removed `wt-w1689` at ~12:40 while its workflow was still live; it did not report completion until 13:13. The fix agent found its worktree **and** its branch deleted mid-run, recreated both from scratch (a full re-clone, re-install and re-build, ~25 minutes of repeated work), and rather than losing the change it filed **#2044** — merged 2026-09-16 (`8167f4f4`). Its own notes record the state more accurately than my teardown did: that #2042 was already merged and #1689 already CLOSED before it started, so this PR's `## Closes #1689` is a formality on a closed issue. **The rule broken is the one already in force — do not edit or tear down a worktree whose workflow is live** — and the near-miss is the instructive part: the junction had been deleted first, so the main tree's `node_modules` held at 471 and the Windows destructive mode never fired. Had I torn down junction-last, this would have emptied the main `node_modules` *while a workflow was building against it*. **What #2044 actually fixes is not cosmetic.** vitest runs a file-level `afterEach` even when that file's `beforeEach` threw, so five of the six migrated files called `await close()` on a binding `setupMcpServer` had never assigned. That fails twice: it reports `close is not a function` stacked on top of the genuine cause, **and on any later test in the same file the stale binding re-closes the PREVIOUS test's client** — a cross-test effect that reads as flakiness rather than as a teardown bug. Each binding became `(() => Promise<void>) \| undefined`, called as `await close?.()` and cleared after; the clear is what makes the guard more than cosmetic. The harness doc comment now carries the pattern so the next migration inherits it instead of re-deriving it — which matters because **#2040's remaining ten files will hit exactly this**. **Scope verified complete rather than asserted:** `git grep 'let close: () => Promise<void>;' master -- tests/` returns exactly the five files changed, no sixth left behind. `export-path-canonicalization` is correctly excluded — its `close` is a function-local at `:89` awaited at `:98` in `try`/`finally`, structurally incapable of being unassigned — and a proposal to fold it in "for uniformity" was raised and refuted. I additionally checked for the same hazard on the `client` binding, which is unassigned under identical conditions, and found no teardown that touches it. Evidence is mutation: a throwing registrar on a mutated copy of `edit-annotation.test.ts` gives 1 `close is not a function` unguarded, 0 guarded, real cause unchanged in both. **The orchestrator hand review found four stale or false body claims, all corrected before merge since the body becomes the squash commit message.** The one that mattered: the Assumptions block — inherited verbatim from the pre-cut spec — stated `parseResult` **moves** out of `tests/helpers/wire-code-fixtures.ts`. It does not. Measured at `a8f424a1`, `wire-code-fixtures.ts:13` still defines its own and `mcp-harness.ts:82` exports the other, so **two definitions exist**; only the "no re-export shim" half was true, and that half is deliberate. This ledger's ROW 1 already recorded the true state, so **the ledger and the PR body disagreed, and the ledger was right** — a case for re-deriving a body's claims against the tree rather than trusting the workflow's own summary. Also corrected: `annotation-tools.test.ts:119` → **`:115`** (the substance survives — filters at `:148`/`:178`, and **zero** `callTool` and **zero** `createLinkedPair`, so it never drives a registered handler at all); "16 files migrate" relabelled as the **pre-cut** measurement, since the cut took it to 6 with 11 filed as #2040; and the "For Bryan" line still listing #2040's off-by-one as outstanding when I had already fixed it in both #2040 and #2042's body. **Wave 11 therefore shipped three PRs, not two:** #2042 (`c6533cb0`), #2043 (`a8f424a1`) and #2044 (`8167f4f4`). |
| 11 | local-model flip blockers | #1657 | `fix/local-model-stillowner-checks-presence-not-identity-1657` | #2043 | — | armed | merged | Merged 2026-09-16 (`a8f424a1`); closes #1657. Run `wf_2b3dfcd6-fb3`, probe ports 5002/5003, launched on `f72c56cb`; 18 agents, 2 plan-review rounds, 1 PR-review round. #1292 was removed from this row 2026-09-11 — closed as fixed 2026-09-08 — so the "only after Bryan re-decides" gate it carried is gone. **Shipped: one predicate.** `stillOwner`'s third conjunct now compares identity, `requireDocument(req.docName)?.doc === ydoc`, replacing a presence test that a Hocuspocus Y.Doc swap leaves true. **The issue's quoted code was stale and the body says so rather than pasting it:** it quotes a one-conjunct function; the real one has **three**, and `current?.token === token` (supersession) and `!abort.signal.aborted` (cancellation) were already correct. Only presence was wrong, and **neither correct conjunct sees a swap** — the token is unchanged and nothing aborts. A brief handing the group the issue's strawman would have invited a diff re-adding guards already present. **Two ordering facts are load-bearing.** `ydoc` is bound above the predicate's *definition*, not merely above its first call: the predicate closes over it, so a later binding throws a TDZ `ReferenceError` on the top-of-run call. And `?.doc === ydoc` is false when the lookup returns null, so **identity subsumes presence** and additionally rejects a re-created instance — stated as an intended widening, not as "behaviour unchanged". **A stale comment was deleted rather than carried forward** — `requireDocument` "never fabricates a phantom room" is false, since `getOrCreateDocument` creates on a map miss — while **the identical phrase at `:464` was deliberately kept**, because there `requireDocument` genuinely returns null for an unregistered docName and an existing spec pins that. Removing both would have been the easy, wrong consistency. **The sink's twin `isOwner()` deliberately DIVERGES and stays on presence**, and the reason is now in the code rather than left as an unstated exception: `makeSink` writes only to `CTRL_ROOM` via `appendClaudeChatMessage` / `updateClaudeChatMessage`, which a *document*-room swap never touches, and mirroring the conjunct would drop #1292's truncation marker on the swap path. Verified independently at review: `collaborator.ts:238-242` carries an explicit "ORDER IS LOAD-BEARING — do not reorder these two calls" comment and `:287-288` states that gating there would strand that marker. That divergence is also what makes test arm 1 discriminating. **Bound, and it constrains how this should be read: a flip blocker, not an incident.** `BYO_MODELS_ENABLED` is a literal `const false` (`shared/constants.ts:97`), so the collaborator never subscribes and the defect is not user-reachable today; the fix changes behaviour only on a path that cannot execute, keeping the dark-system byte-identical rule intact. **The tests swap, they do not close** — a close is already caught by the presence check that predates the fix and would stay green against the old code, proving nothing. The helper removes only the provider map entry, re-creates a fresh instance under the same room name, populates it and destroys the old one, leaving the registry row intact so `requireDocument()` keeps returning non-null throughout: that is the discriminating condition. Two arms, deliberately not redundant — one asserts the terminal reply is dropped (discriminating *because* the sink stayed on presence), one asserts the notification buffer stays empty via `pushNotification`, which bypasses the sink entirely and so survives any future change to it. Both honour a microtask timing rule written into the file: a sub-`STREAM_FLUSH_CHARS` delta arms a `setTimeout` flush that would mint the bubble on its own if a macrotask ran first. Mutation is two-directional and names both specs. **A second mechanism was split out rather than bundled, and it is the one that matters operationally: #2037.** `tandem_applyChanges` captures the room's Y.Doc at `docx-apply.ts:146`, awaits `fs.stat` at `:291`, then re-reads that captured reference at `:309` via `extractText(ydoc)` before writing the user's `.docx` — so an ordinary tab connecting mid-apply feeds text from a **destroyed** doc into the saved file, silently, with no attacker. **Unlike #1657 this path is LIVE and needs no flag.** The audit also **half-refutes the issue's own framing**: the long-lived store there is `new YDocStore(...)`, not `getDocumentStore` (whose grep returns nothing in that file and reads like an expired claim), and the store's only use is synchronous before the first await — so "the store is live across the awaits" is true but harmless; the real residue is the raw `ydoc`. **The register entry and the CLAUDE.md count word are mutually required, and the run got this right for a reason it had to correct mid-review:** a round-2 finding proposed the register entry and asserted a register-only bullet stays green — that half is wrong, because `tests/docs/security-findings-claims.test.ts` pins **four** coupled assertions (`:163` open count word, `:176` accepted count word, `:208` every open finding has its own entry, `:301` the reverse), so the bullet, the `#2037` reference at paren depth zero, and `Three` → `Four` land in one commit or the required `check` goes red. **Two mechanisms were proposed and CUT, and the ledger records them because the cut is the result:** mirroring identity into the sink (mooted by leaving the sink untouched), and a `docSwapped()` + `abort()` mechanism in the sink's deferred `write()` — killed by three findings, the decisive one being that **a tool-only turn never reaches `write()` at all**, so hanging swap detection off the streaming sink misses exactly the case the issue is about. That residual gap is filed as **#2039** rather than deferred silently. **The orchestrator hand review found no unresolved findings**; one correction was applied to the PR body, which named master as `6b37088a` and told the reader to *expect* an Update branch that had already been run — stale prose that would have become the permanent squash commit message. Brought up to date by GitHub's Update branch (a merge from master, no rewrite, no force-push) after #2042 moved master to `c6533cb0`. **For Bryan — three awareness items, none blocking:** whether **#2037** is scheduled independently of the `BYO_MODELS_ENABLED` flip, since it is the only member of this family that is live and it is currently unowned; **#2039's design question**, which is a product call and should be settled before implementation — on a mid-turn swap, abort the turn outright or re-resolve against the fresh doc, the latter not obviously safe because the model's plan was formed against text that may no longer exist; and whether **#2039's `correctness` label** should be `security`, which would oblige a register entry plus another count-word move in the same commit. |
| 12 | #1626 reply surfaces | #1626 | — | — | — | — | planned-not-started | Scheduled 2026-09-16 by decision: part 1 **(a) convert to formatted text**, part 2 **schedule it**. #1629 CLOSED and discharged. |
| 12 | #2038 store-lock recovery | #2038 | — | — | — | — | planned-not-started | Filed 2026-09-16 out of decision 7. `startedAtMs` is written and read but compared nowhere — that comparison is the fix. |
| 12 | #2040 harness migration remainder | #2040 | — | — | — | — | planned-not-started | The ten files #1689's cut left. Inherits #2044's guarded-`afterEach` pattern from the harness doc comment. |

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

### Wave 8 in progress — 2026-09-15

E2-upgrade merged as **#1985**, K-sec-server as **#1987**, G10 as **#1996** and G1 as **#1998**.
Then G9a merged as **#2000**, K-sec-launcher as **#2006** and K-server as **#2007**.
Then G9b merged as **#2012** and G7 as **#2011**.
W1708 and G6 (wave 9) launched straight after, on `4da4efa0`, and both merged 2026-09-15 (#2017, #2016). G14 and #1603 then launched on `33a99d00` — the first two groups to run with the fixed code-review stage — and merged 2026-09-16 as **#2021** (`2f54a8d3`) and **#2020** (`fc417f10`). R1823 then merged 2026-09-16 as **#2024** (`7de27163`), Refs #1823. **Wave 9 is complete.** #1823 itself stays open on its server-data section, and three of its runtime items came back as decisions for Bryan rather than fixes.
Out-of-group PRs:
- **#1986** (`4f112aa4`), the #1957 root cause;
- **#1989**, the smoke-lines merge E2-upgrade did not carry;
- **#1990**, recording that the uninstall log belongs to the npm scrub;
- **#1992**, a `docs/security.md` correction for what #1981 refuted.

Filed out of the work: #1980, #1981, #1982 and #1988 (macOS/Linux force-quit leaves the sidecar
alive: the #800 reaper never landed, and a merged PR was named as its tracker).

**Lesson: `core.bare=true` was never a stray command. It was the pre-push hook running the test
suite from a linked worktree.** `git push` from a worktree exports
`GIT_DIR=<repo>/.git/worktrees/<name>` to the hook. `tests/scripts/biome-worktree-scope.test.ts`'s
`plantRepo` ran `git init` in a temp dir with that environment inherited. With `GIT_DIR` set,
`git init` ignores its `cwd`, re-initialises the real repository and writes `core.bare=true` into
the shared `.git/config`. The repo flipped twelve times, and each flip was repaired by hand and
read as a one-off until the mechanism was reproduced. The general rule: **a test that shells out
to git must scrub `GIT_*` from the child's environment**, because the hook running it is itself
inside a git process. #1986 does that and pins it with a decoy-repo spec. The claim is refuted if
the repo flips again after a worktree push whose tree contains `4f112aa4`.

Also: 23 zero-byte ref locks dated 2026-05-29 under `.git/refs/remotes/` had been silently failing
every `git fetch --prune` since then. They were removed 2026-09-15, after confirming that no git
process was running.

**Lesson: an empty code-review is not a clean one, and both G10 and G1 shipped bodies that treated
it as one.** In both runs the workflow's `code-review` agent returned only an effort-level line and
no findings. G10's body said so. G1's body said "Unresolved findings: none". A hand review of each
whole branch diff, run by the orchestrator before merge, found a real defect both times:
- G10's new docs promised selection clearing that only the active tab performs (#1997).
- G1 had a race that would kill a live Claude turn after a latch flush.

So until the workflow's review stage is shown to return findings again, **every group PR gets an
orthestrator hand review of the full diff before merge**. The group notes now carry rule 7: a review
with no result must be reported as "no review result". G10 also repeated wave 7's lesson 1: its
returned `closes[]` included #1624 while its body correctly said Refs. The body is authoritative.

**Recurrence in wave 9: two of the three next hand reviews found a real defect again.**
- K-server wrote an errno split into the wire contract that is false on Windows (Important).
- K-sec-launcher logged a caller-supplied path unsanitized (Low), and described a public libuv flag as undocumented.

The K-sec-launcher review also surfaced a problem no code review looks for: the PR landed a decision Bryan had explicitly kept for himself (#1822 item 4a). The orchestrator split it out before merge. **Add to the hand review: re-read the owner's latest triage comment on every issue the group touches, and hold anything that comment names as a policy question.** G9a's and K-sec-launcher's returned `closes[]` arrays again disagreed with their bodies.

**The `/code-review --level high` skill returned NOTHING in all THREE PR-review rounds of G9b and G7** (G9b r1/r2 and G7 r1 — an earlier version of this line said four, but G7 ran only one round). In each round its subagent was still running when the collector returned, so the group recorded findings from the named reviewer agents only. Two consequences, both now rules: a round with a missing review is written as **"no review result"**, never as "unresolved findings: none" (G7's body did exactly that and was rewritten before merge); and the named agents — `annotation-model-reviewer`, `crdt-reviewer`, `svelte-migration-reviewer`, `general-purpose` — are what the sweep actually relies on, so the group is not reviewed if they are skipped.

**Both wave-9 hand reviews again found something, and G7's finding was in the PR body rather than the code.** A body that overstates its own review record is the one defect no code-review agent is looking for, so the hand review now reads the body against the run's journal: every review round, every cut assumption, every artifact the body says it attached.

**The code-review stage was then measured across the whole sweep, and the number is worse than any single wave suggested: 15 of 39 rounds delivered no review at all.** Eleven returned a single pseudo-finding that says so outright ("NOT A FINDING", "NO REVIEW RESULT", "do not read this empty result as a clean review") and four returned a bare `{findings: []}`. The rounds: G1 r1/r2, G10 r1/r2, G9a r1/r2, G9b r1/r2, K-server r1/r2, W1708 r1/r2, G6 r1, G7 r1, K-tests r2. The cause is structural — the skill forks a background, non-interactive subagent (`spawnDepth` 2) that the calling agent cannot await — and is verified on G6's transcript, whose forked skill agent made ZERO `ReportFindings` calls and stopped mid-sentence while its caller had already returned. W1708's fork finished seven minutes after its caller gave up, holding findings it never delivered. **Fixed on `chore/sweep-workflow-model-effort`: the stage now reads the branch diff and judges it itself, and the prompt forbids invoking the skill.**

**The fix is now measured across two groups, and it holds.** #1603's round returned zero findings after three reviewers did real work (58 tool calls between them), and G14's two rounds each found a REAL defect that the skeptic could not refute — a CRLF paragraph collapse and a whitespace-only-line collapse, both reachable from `tandem_reply`/`tandem_comment`'s bare `z.string()`, both fixed with a named mutation test. Before the fix, 15 of 39 rounds delivered nothing at all. The distinction that matters for reading these results: an inline stage returning `{findings: []}` after twenty tool calls is a clean review, while the old stage's identical-looking empty array meant the fork was still running. **Only the journal separates the two**, which is why the hand review now joins each `code-review:*` label to its agent's tool count rather than to its finding count alone.

**A stale anchor in an ISSUE body is worth measuring before a group launches, not after.** R1823's brief carried an orchestrator-verified inventory, and three of #1823's own anchors named the wrong FILE — not a shifted line. Two of those items then came back REFUTED rather than fixed (the SIGTERM "dead code" claim, which is false as written) or relocated (the token drop, which is real but nowhere near `setup.ts:198`). A group handed the raw issue text would have spent its plan rounds rediscovering that, or worse, "fixed" a defect at an anchor that does not hold it. The measurement cost one orchestrator pass; it is the cheapest thing in this pipeline.

**The review stage's value is now visible in a way no clean round can show.** R1823's round 1 returned six findings that collapsed to three defects, and the headline one was a REGRESSION THE GROUP ITSELF HAD JUST INTRODUCED: item 10's new token read sat above the per-target `try`, and the reader rethrows every non-ENOENT errno, so an unreadable token file would have aborted `setup --apply` with zero configs written where the pre-change run wrote them all. Three independent reviewers found it and the skeptic refuted none. That is the case the 15-of-39 dead rounds were silently failing to catch.

**A PR body can be wrong in the generous direction too, and #1603 is the first instance.** Its body said no review result reached it, when all three reviewers had reported clean. The ship agent is not handed the review transcripts, so its honest report of what it could see was false about what happened. Rule 7 — say "no review result", never "unresolved findings: none" — is still right, but it needs its twin: **the ship agent's view of the review is not evidence about the review.** Read the journal both ways.

**That count was got wrong twice before it was trusted, which is the transferable part.** A first pass said "five rounds in a row" and named rounds that had in fact reported. The correction then counted only bare empty arrays and said "4 of 39" — an undercount, because each of the eleven self-declared non-reviews looks like one finding to a length check. **A round that reports "I have no result" is a missing review, not a finding**, so any count of review coverage has to read the finding, not its array length.

### Wave 10 complete — 2026-09-16

D3 merged as **#2026** (`757eeeca`) and its follow-up as **#2029** (`3dcfa051`); together they
close **#1941**, which is the issue's own closing condition — both surfaces shipped, the
`allowImageLoss` flag and the browser affordance. G4 merged as **#2031** (`7aff6259`), closing
**#1613**, **#1614** and **#1615**. **G11 (#1602 #1604 #1605 #1606) is the wave's remaining
group** and is scheduled alone, because it owns `CLAUDE.md` and `.github/` — both of which G4
touched, so it rebases onto `7aff6259`.

Filed out of the work: **#2027** (`allowImageLoss` is flippable from any loopback origin with no
proof of user intent — Low, bounded, Bryan's call), **#2028** (a duplicate of #2027, filed 64
seconds later by a second writer, closed *not planned*), and **#2030** (the relative
`core.hooksPath`, below).

**Every lesson this wave produced is about mistaking one thing for another, and in four of the
five the orchestrator was the one mistaken.**

**A build agent can misdiagnose its own delegate as a rival agent.** G4's `build:G4` stopped work
and escalated a collision naming `a1bf6cbdf1452d0ed` — its own agent id, read out of its own
`ListAgents` row. The unexplained fixture writes were its own write-capable delegates. Three
measurements settled it and no one alone would have: the run journal (authoritative on which
agents a run owns), `ListAgents` (which does **not** list a Workflow's agents at all, so its
silence is not evidence), and the agent's own transcript. **Serialize delegates — never run a
write-capable delegate while also editing, and never spawn two that touch one file.**

**A quiet worktree is not a dead run, and only twice-sampled mtimes discriminate.** A frozen
journal, an `ok: false` stage, an empty `ListAgents` and a clean `git status` are all consistent
with a perfectly healthy run writing every 40 seconds. D3 looked identically "dead" and had in
fact finished and opened #2026, which was found only by `gh pr list`. That discipline is what
made G4's final merge safe: two manifests of all 2,201 files, byte-identical, before any write.

**Two writers in one worktree — and the orchestrator was one of them.** D3's three review
findings were assigned to an agent, and then fixed by the orchestrator in the same worktree
before it started. The agent found three modified files that were not its own, stopped, and
escalated — which is the only reason this cost one duplicate file and one duplicate issue rather
than a commit mixing two agents' work. **Assigning work to an agent and then doing it yourself is
a collision by construction**; no sampling discipline helps, because you are not detecting a
rival writer, you are being one. Detection was timestamp-shaped, not state-shaped: `git status`
says files changed, never by whom.

**#2030 was filed against tooling that already had the guard.** The report said every worktree
this sweep creates had been pushing with no git hooks. That is false: the pipeline runs
`npx husky` at worktree creation and refuses to push unless `.husky/_/pre-push` exists
(`workflow.js:356`, `:574`; and this document at `:37`, `:195`, `:214`). `wt-g4` proves it — its
`node_modules` is a **junction**, so no `npm install` ran there either, and its `.husky/_` is
stamped two minutes after the worktree was created: that is the pipeline's arming step. The one
worktree that did push unhooked, `wt-d3b`, was created **by hand, outside the pipeline**, for a
review agent — so nothing armed it, and because it was pushed by hand the ship-stage assertion
never applied either. The issue's scope is corrected and it stays open on the narrower, real
point: **`core.hooksPath` is a *relative* path, so anything not explicitly armed is silently
unhooked and exits 0.** It fails toward green — the explicit bypass flag is blocked by a hook,
while this achieves the same effect with nothing to block, and the only tell is elapsed time
(3 seconds against 7–8 minutes).

**A review can carry the defect it is reviewing.** The hand review of #2031 found three stale
counts and, in the same document, asserted that `tsconfig.tests.client.json` "resolves the same
559 files it did before". Re-measured at publication: **696**. The fix was to delete the number
rather than correct it — "resolves the same file set" follows necessarily from a comment-only
diff, and *that* is mechanically checkable. **Prefer a claim that follows from a testable
property over a measurement that merely illustrates it.**

**Three unrelated operations failed toward looking successful, which is #2030's shape again.** A
pre-flight `perl -pi -e 's{…}{…}'` never compiled (a brace-delimited replacement must contain
balanced braces), so a clean `tsc` was measured on an unmodified file and read as a pass — print
the evidence the mutation landed, not just the result of the check. A `gh api /repos/… > file`
hit git-bash's MSYS path rewriting, and the shell had already truncated the target to zero bytes
before the command failed, so a read-modify-write nearly replaced a whole GitHub comment with its
own correction footer. And the `grep -P` meant to prove a script was ASCII-clean never ran at all
(unsupported locale), returning a reassuring message from its `||` fallback.

**The `node_modules` "drift" was two counting conventions.** A close-out recorded 471 entries and
a later check read 467, and the gap was flagged as unexplained. `ls | wc -l` under git-bash omits
dotfiles; PowerShell `Get-ChildItem -Force` does not. Same directory, same moment. **A safety
check whose before and after come from different tools cannot answer the question it exists for**
— and it manufactures a fake anomaly that costs attention later. The close-out figure is **471 by
`Get-ChildItem -Force`**. Relatedly: `git-bash` renders both junctions and symlinks as
`lrwxrwxrwx`, so `ls -l` cannot tell you which you have, and the junction is precisely the shape
that makes `git worktree remove` destructive. Ask PowerShell.

**`strict: true` does not require a rebase.** G4 fell behind twice (#2026, then #2029). Merging
`origin/master` into the branch satisfies the up-to-date requirement, needs no force-push — which
the auto-mode classifier has already denied once in this sweep — and the merge commit disappears
in the squash. Checking the conflict surface first is worth the minute: the two files G4 shared
with D3 had byte-identical `vi.mock(` lines on both sides, which predicted the clean merge it got.

**G11 merged last, alone, as designed — and the group that exists to delete unchecked claims
shipped one.** #2035 closed #1602, #1604, #1605 and #1606: a `## Disposition` section in each of
the four `.claude/agents/*.md` reviewers, three `CLAUDE.md` paragraphs, three short `.github/`
templates, one wiring test, and a real `needs-human-evidence` label carried by #316 and by #2034,
which the run filed itself for the previously-untracked cross-platform install matrix.

**A new rule can arrive misstating its own mechanism.** The #1602 escape hatch — the one way a
blocking security finding may be shipped past — required pointing at an "already-accepted,
bounded, **dated** entry" in `docs/security.md`'s register. Two of that register's four entries
deliberately carry **no revisit date** (#1609, #1488), and its own heading reads *Accepted
(bounded) — decided, not fixed*. The rule would have made a future security review refuse a
legitimate pointer to half the accepted set. This is the same shape as everything else in wave 10
— a claim that reads as authoritative and checks nothing — except that it arrived **in the change
whose purpose was removing exactly that**, and it survived a plan-review round, a PR-review round
and a skeptic pass, because every one of those read it as prose rather than as an assertion about
a file they could open. **The fix was a deletion.** `already-accepted` plus "a *new* acceptance
made mid-review does not count" already carried the whole guard, so the correction made the
repo's most expensive file shorter. When a rule in `CLAUDE.md` turns out to be wrong, prefer
subtracting the wrong half to appending a correction.

**A review round that finds something and refutes it is a result, not an absence.** #2035's body
said "Unresolved findings: none", which was true. Round 1 had in fact raised a low finding — the
#1602 paragraph keys on "the reviewer's own stated blocking set", which only the four repo agents
have, so it no-ops for the two reviewers it physically sits beside — and the skeptic refuted it as
accurate but bounded in scope. None of that reached the body. The existing rule ("if a review
returned no result, say *no review result*, never *Unresolved findings: none*") covers the empty
case; this is its twin at the other end, and both exist because the PR body is the only durable
record of what a review actually did.

**Filing the follow-up during planning, rather than deferring it, is what made #1606 honest.**
The issue asked for a label over four issues. Two were closed, so labelling them would have made
the bucket look populated; one existed only as a description with no issue behind it. The run
filed #2034 and created the label with `gh label create` before writing any prose about either —
so the `CLAUDE.md` paragraph that ships describes artifacts that exist, and points at live
membership (`gh issue list --label needs-human-evidence`) rather than hardcoding numbers that rot.

### Wave 11 complete — 2026-09-16

**Wave 11 shipped three PRs, not two.** #2042 (`c6533cb0`) closing **#1689**; #2043 (`a8f424a1`)
closing **#1657**; and **#2044** (`8167f4f4`), a review follow-up that exists because of an
orchestrator error (below). **#2037**, **#2038**, **#2039**, **#2040** and **#2041** were filed out
of the work and all remain OPEN.

**ADR-037's G6 amendment is RATIFIED** — Bryan, 2026-09-16, by chat. **Recorded here because no ADR
in `docs/decisions.md` records a ratifier**, so there is no in-ADR convention to extend: ADR-037's
own Status line reads `Accepted; implemented (verified against src/ 2026-05-25)` and carries no such
field. The amendment stands exactly as written and nothing in the ADR changes — this records *who*
ratified it and *when*, which was the only thing missing.

**Every lesson this wave produced is a measurement that looked right and was not.**

**A reproduction command can match the artifact it created.** #2042's published probe —
`git grep -l "InMemoryTransport.createLinkedPair" -- tests/ | xargs grep -L "helpers/mcp-harness"` —
returns **12**, not the stated 11, because `tests/helpers/mcp-harness.ts` itself contains
`createLinkedPair` and has no reason to import itself. The twelfth entry is **the migration target**,
the one file that must never be migrated. The set of 11 was always correct, so what was wrong was the
**command**, not the number: the fix is the pathspec `':!tests/helpers/mcp-harness.ts'`. It matters
beyond an off-by-one because #2040 instructs its reader to *"Re-run it rather than trusting this
number"* — a wrong reproducible command inside a filed follow-up ages into a wrong conclusion.
**The workflow had independently noticed the same discrepancy, classified it "minor, not blocking",
and left it in place.**

**`grep -v '^[+-][+-]'` silently eats changed markdown bullets.** A diff line for a bullet renders as
`+- **Four security findings…`, which begins `+-`, so a filter written to strip `---`/`+++` headers
deletes exactly the line being looked for. A real `CLAUDE.md` `+1/-1` change read as an empty diff.
Re-run the diff raw before concluding a file is untouched.

**A two-dot diff across a missing merge renders merged work as deletions.** `git diff master
<branch>` showed #2042's harness as ~90 lines of *deletions* on #2043's branch, reading exactly like
a revert of shipped work. It was an artifact of the merge base, nothing more. **Review at the merge
base** (`git diff <merge-base> <head>`), or misread a branch as reverting what it merely predates.

**A subsection's terminator may be a `##`, not a `###`.** Counting the security register's Accepted
entries with an `awk` range ending at `/^### /` runs *past* the subsection into the next `##` section
and returns **10** where the true count is **4**, because the unindented prose bullets there also
begin with `- `. That count is CI-pinned by `tests/docs/security-findings-claims.test.ts`, so the
miscount would have turned the required `check` red.

**The ledger was right and the PR body was wrong.** #2044's Assumptions block, inherited verbatim
from the pre-cut spec, stated that `parseResult` **moves** out of `tests/helpers/wire-code-fixtures.ts`.
It does not: `wire-code-fixtures.ts:13` still defines its own and `mcp-harness.ts:82` exports the
other — **two definitions**. This ledger's own row already recorded the true state. **Re-derive a PR
body's claims against the tree rather than trusting a workflow's summary of its own work**; the body
becomes the permanent squash commit message, so a false claim there is permanent.

**Tearing down a worktree whose workflow is live costs a full rebuild.** `wt-w1689` was removed at
~12:40; its run did not report completion until 13:13. The fix agent found worktree **and** branch
gone, **recreated both from scratch** — re-clone, re-install, re-build, roughly 25 minutes of
repeated work — and filed #2044 rather than losing the change. The near-miss is the instructive half:
the `node_modules` junction had been deleted **first**, so the main tree held at 471 entries and the
Windows destructive mode never fired. Junction-last would have emptied the main `node_modules`
*while a workflow was building against it*.

**When reporting open decisions back, use the source document's numbers.** Renumbering items 1, 6, 9,
10, 13 as 1–5 made Bryan read "4 and 5 went unanswered" against the document's own numbering, where
those two *had* been answered. Never renumber.

**This ledger's own table had drifted, and the check that caught it was a byproduct.** Verifying that
the new wave-11 rows carried the right column count turned up **twelve** pre-existing rows in this
status table that do not. Seven carry a tenth column against a nine-column header; four contain
unescaped pipes in cell prose — **a pipe splits a table cell even inside a code span, because
backticks do not protect it**; and one line holds **two rows**, so the `Gc2a position mapping` row
(#1774 #1776) never renders as a row at all and is invisible to anyone reading this table for what is
still unstarted. One of the new rows written here had the same defect before it was escaped. The
defect is invisible in a diff and in most editors, which is how it recurred thirteen times. Repairing
the twelve is a larger detour than a wave-completion entry should carry, so it is filed as **#2045**.

#### Decisions closed in wave 11

All **13** items of the 2026-09-16 decisions document are answered — 8 by anchored comment, 5 by
chat. Three of the thirteen were withdrawn as stale during preparation, which is itself the finding:
**preparation, not answering, was the bottleneck.** Bryan's 11 comments spanned 9.5 minutes.
Recommendation recorded: raise the decision batch size from 4 to **~12**.

Two acceptances follow and are **owed as a separate docs PR**, because the `CLAUDE.md` half is
CI-pinned and cannot be split across PRs: **#1666** (leave as-is — *a new acceptance, not a no-op*)
and **#2027** (leave as shipped, documented). The open count word moves `Four` → `Three` and the
accepted word `four` → **`six`**.

**Item 7 settles a direction permanently, not just an instance** — Bryan: *"We don't ever want to
lose the user's hard work, full stop."* Where one branch risks data loss and the other risks
annoyance, take the annoyance. Its cost is the recovery gap filed as **#2038**.

#### Three new decisions, none blocking

1. **Is #2037 scheduled independently of the `BYO_MODELS_ENABLED` flip?** It is the only member of
   this family on a **live** path, needs no flag, and is currently unowned. Reading all three as one
   dark-code family would postpone the only reachable one.
2. **#2039 — abort the turn outright, or re-resolve against the fresh doc?** A product call, and it
   should be settled before anyone implements. Two measured constraints bound any fix: aborting
   *above* the `truncated` latch strands #1292's truncation marker, and **a tool-only turn never
   reaches the sink's `write()` at all**, so hanging swap detection off the streaming sink misses
   exactly the case the issue is about.
3. **#2039's label — `correctness` (as filed) or `security`?** Relabelling obliges, *in the same
   commit*, a `docs/security.md` register entry **and** another count-word move, because
   `tests/docs/security-findings-claims.test.ts` asserts in both directions.

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
