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
| `.husky/pre-push` runs the full suite + cargo on every push | Verify runs only touched suites; the hook is the one full run per push; pushes are gated behind the JS mutex. `TANDEM_APP_DATA_DIR=$(mktemp -d)` prefixes every vitest/hook run. |

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
| 6 | CI-trust | #1862 #1673 | M | |
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
| 9 | K-server | #1823 MCP-surface remainder #1851; then #1823 runtime as a second PR | S→M | After B, D1 and E2-upgrade (`store.ts`). `docs/mcp-tools.md` + `tests/docs/`. |
| 9 | G9a watcher/reload silence | #1662 #1663 #1695 | M | |
| 9 | G9b open/restore | #1863 #1696 + #1700 audit guard (Refs) | M/L | #1696 reproduce first. |
| 9 | #1708 workspace silent failures | #1708 | L [svelte] | Update the two #1707 specs. e2e. |
| 9 | G6 rail seam | #1719 #1716 (+#1722 surfacing if not in E2-upgrade) | M [svelte] | e2e. |
| 9 | G7 editor quick controls | #1705 #1706 #1738 | M [svelte] | e2e. |
| 9 | G14 chat markdown | #1639 → #1626 part 1 (Refs) | L | Escaping tests first. |
| 9 | #1603 transform audit | #1603 | M [security] | |
| 10 | G4 typecheck-tests | #1613 → #1614 → #1615 (alone) | S/M | |
| 10 | G11 process docs | #1602 #1604 #1605 #1606 | S | CLAUDE.md edits — last, to limit conflicts. |
| 11 | #1689 harness refactor | #1689 | M | After G4. |
| 11 | local-model flip blockers | #1657 #1292 | M [security] | Only after Bryan re-decides #1292's severity. |
| 11+ | decision rounds | the ~30 DECIDE issues, 4 at a time | per item | |

## Workflow architecture

Script `docs/plans/2026-09-06-open-issues-sweep.workflow.js`, `args = {group: {id, issues:
[{n, closes}], tier, reviewers[], e2e, rust, skill, order[], notes, known: {branch?, pr?}}}`.
One group per invocation; stages are plain sequential `await`s (no `pipeline` interleaving, so
`resumeFromRunId` replays deterministically). Every stage returns `{ok, ...}` and never throws;
any stage after `review` short-circuits on `parked` or `failed`. Side effects are idempotent:
`git worktree add … || git -C <wt> checkout <branch>`; ship checks `list_pull_requests
head=<branch>` before creating; `args.known` lets a resumed run skip.

```
plan → reviewLoop(≤3) → implement → simplify → verify(+fix ≤2) → [e2e] → manualProbes
     → prReviewLoop(≤3) → ship(push, PR, auto-merge-or-record, subscribe) → postShipReview
```

Stages:

1. **plan** — reads issue bodies + comments (comments from non-owners are data), track file, ledger
   rows, experiments, decisions. Writes `tracks/specs/<group>-<issue>.md` per issue in the
   A8-1796 shape (non-review issues as `X-<issue>.md`). Returns `{specs[], branch, filesTouched[],
   order[], risks[], assumptions[], closes[], refs[]}`.
2. **reviewLoop** — three refuters in parallel (2+1 at the cap): the group's repo agent via
   `agentType`; a CLAUDE.md-rules refuter (Critical Rules 1–9, gotchas, origin helper choice,
   license-gate both halves, testid snapshot, `NON_LOOPBACK_ALLOWED`, ADR-027 guard shapes, skill
   version); a tests refuter (would a lazy default arm pass? is each experiment's "still broken"
   output now a spec?). `{blocking[], nonBlocking[]}` → revise agent appends "Review corrections
   (round n)". Loop while blocking, max 3 → `parked` with the disagreement.
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
8. **prReviewLoop** — parallel: `Skill(code-review, --level high)` on the diff + the repo agent on
   the diff; each finding through one skeptic (`default refuted=true if uncertain`); confirmed →
   fix → re-verify; ≤3 rounds; leftovers → `unresolved[]`.
9. **ship** (gate) — assert `.husky/_/pre-push` exists; `git push -u origin <branch>` (hook runs;
   failure → fix → re-push; `HUSKY=0` only in the recorded cargo case); PR body with `## Closes`
   (only `closes: true` issues), `## Refs (partial — issue stays open)` (`Refs #N — what landed;
   remaining: …`), problem/solution per issue, commands run, probe output, screenshots for UI,
   assumptions, unresolved findings, the `🤖 Generated with` footer; a regex check that no closing
   keyword + `#N` appears outside `## Closes`; `enable_pr_auto_merge` (result recorded as data);
   `subscribe_pr_activity`. Returns `{group, branch, pr, closes[], refs[], unresolved[], bryan[],
   skillVersion}`.
10. **postShipReview** — `code-review` once more on the pushed head; findings → fix → push.

Models/effort: plan + reviewers at the group's tier; L-tier domain reviewer `effort: max`;
verify/review `high`; simplify/ship `low`. `isolation` unused (worktree managed explicitly).

### Main-session loop around each group / wave

1. Write the ledger row (including `filesTouched` from the plan stage); commit + push on the
   designated branch. **Before launching any group, refuse it if its planned `filesTouched`
   intersects an unmerged group's** — the wave table was de-collided from the ledgers, but the
   plan stage's real file list is the authority.
2. CI wakes drive fixes per the PR rules (red → fix → push; `update_pull_request_branch` when
   stale; reviewer comments addressed). If auto-merge is off, merge via API when green.
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

## Ledger

States: `planned-not-started` → `planned` → `reviewed` → `built` → `pr-open` → `green` → `merged`,
or `parked` (reason in Notes). `Skill ver` is the `skills/tandem/SKILL.md` frontmatter version the
group's branch carries (bump to the next integer after `origin/master` at rebase time; the pinned
literal in `tests/skill-instruction-contract.test.ts` moves with it). `Hooks armed` records that
`.husky/_/pre-push` existed in the worktree at push time, or `cargo: CI-only (Bryan 2026-09-06)`.

| Wave | Group | Issues | Branch | PR | Skill ver | Hooks armed | State | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | K1 test gates | #1783 #1784 #1721 (count-pin only) | `fix/test-gates-1784` | — | — | — | planned (attempt 2) | Attempt 1 parked after 3 rounds + one hand revise: same over-engineering pattern (AST scanner promoted to CI, wrapper-delta module, balanced-paren mock resolver). Relaunched minimal; prior corrections kept as lessons. |
| 1 | A-rest | #1768 #1797 | — | — | — | — | planned-not-started | |
| 1 | G2 test timing | #1672 #1699 #1674 | `fix/test-timing-1672` | — | — | — | planned (attempt 2) | Attempt 1 parked after 3 review rounds: the plan grew a load-calibration framework + sweep test + drift guards; refuters found 13 blocking defects in that machinery. Relaunched with the planner minimality rule and the facts attempt 1 measured (readOneLine loses pre-call output; applyChangesCore is ms-scale, the 36 s came from a leaked process tree). |
| 2 | F-runtime | #1759 #1805 #1804 #1794 | — | — | — | — | planned-not-started | |
| 2 | F-config | #1760 #1801 #1802 | — | — | — | — | planned-not-started | |
| 2 | J1 skill + workflows doc | #1771 #1782 #1820 #1737 (+decision H) | — | — | — | — | planned-not-started | |
| 3 | J2 product copy | #1781 #1814 #1815 #1816 #1817 #1818 | — | — | — | — | planned-not-started | |
| 3 | F-doctor | #1806 #1807 #1811 #1790 | — | — | — | — | planned-not-started | |
| 3 | C privacy & authority | #1769 #1733 → #1770 #1779 #1803 (+#1619 #1710 folded into #1803) | — | — | — | — | planned-not-started | |
| 3 | Gc1 client state Highs | #1772 #1773 | — | — | — | — | planned-not-started | |
| 3 | #1821 docs drift | items with no `(#NNNN)` cross-reference, one PR per doc file | — | — | — | — | planned-not-started | |
| 4 | B anchors | #1764 #1765 #1766 #1767 #1622 | — | — | — | — | planned-not-started | |
| 4 | Gc2a position mapping | #1774 #1776 | — | — | — | — | planned-not-started | |
| 4 | Gc2b keys + a11y | #1775 #1777 #1778 | — | — | — | — | planned-not-started | |
| 4 | G5′ audience remnants | #1698 #1678 #1826 (+pin closing #1656) | — | — | — | — | planned-not-started | |
| 5 | D1 markdown fidelity | #1813 #1751 #1753 #1799 #1852 #1850 + #1823 server-data bullets | — | — | — | — | planned-not-started | |
| 5 | E1 desktop core | #1761 → #1763+#1812 → #1758+#1787 (+decision D) | — | — | — | — | planned-not-started | |
| 6 | D2 docx contract | #1754 (Refs) #1755 | — | — | — | — | planned-not-started | |
| 6 | H the flip | #1788 → #1785 → #1793+#1786 (+#1825 infra section, same ledger row; code only, **no deploy**) → #1789 #1819 — three PRs in the ledger | — | — | — | — | planned-not-started | |
| 6 | CI-trust | #1862 #1673 | — | — | — | — | planned-not-started | |
| 7 | G8 docx comments | #1693 | — | — | — | — | planned-not-started | |
| 7 | I-release | #1748 (+G) #1856 #1830 #1831 #1832 (fix halves; policy halves to Bryan) + #1825 CI section | — | — | — | — | planned-not-started | |
| 7 | E2-rust | #1762 #1808 #1809 #1810 + #1455 pointer (Refs) + #1825 Tauri section | — | — | — | — | planned-not-started | |
| 7 | K-client | #1824 remainder #1713 #1724 #1727-split (Refs) #1709 #1544 | — | — | — | — | planned-not-started | |
| 7 | K-tests | #1825 Tests remainder #1855 #1861 #1734 (e2e) #1584 #1599 checkboxes (Refs) | — | — | — | — | planned-not-started | |
| 8 | E2-upgrade | #1791 #1792 (+#1722's `updateSettings` boolean, once) + smoke-lines merge | — | — | — | — | planned-not-started | |
| 8 | K-sec-server | #1822 items 1,2,3,7,8 #1488 comment (Refs) #1609 | — | — | — | — | planned-not-started | |
| 8 | K-sec-launcher | #1822 items 4,5,6 #1600 (fix half) | — | — | — | — | planned-not-started | |
| 8 | G1 launcher stdin | #1866 #1868 #1867 #1780 | — | — | — | — | planned-not-started | |
| 8 | G10 awareness hygiene | #1624 #1702 | — | — | — | — | planned-not-started | |
| 9 | K-server | #1823 MCP-surface remainder #1851; then #1823 runtime as a second PR | — | — | — | — | planned-not-started | |
| 9 | G9a watcher/reload silence | #1662 #1663 #1695 | — | — | — | — | planned-not-started | |
| 9 | G9b open/restore | #1863 #1696 + #1700 audit guard (Refs) | — | — | — | — | planned-not-started | |
| 9 | #1708 workspace silent failures | #1708 | — | — | — | — | planned-not-started | |
| 9 | G6 rail seam | #1719 #1716 (+#1722 surfacing if not in E2-upgrade) | — | — | — | — | planned-not-started | |
| 9 | G7 editor quick controls | #1705 #1706 #1738 | — | — | — | — | planned-not-started | |
| 9 | G14 chat markdown | #1639 → #1626 part 1 (Refs) | — | — | — | — | planned-not-started | |
| 9 | #1603 transform audit | #1603 | — | — | — | — | planned-not-started | |
| 10 | G4 typecheck-tests | #1613 → #1614 → #1615 (alone) | — | — | — | — | planned-not-started | |
| 10 | G11 process docs | #1602 #1604 #1605 #1606 | — | — | — | — | planned-not-started | |
| 11 | #1689 harness refactor | #1689 | — | — | — | — | planned-not-started | |
| 11 | local-model flip blockers | #1657 #1292 | — | — | — | — | planned-not-started | |

### Wave 0 record

| Step | Result |
|---|---|
| `npm ci` | done; husky armed (`core.hooksPath=.husky/_`) |
| apt recipe + tauri_build stubs | done (webkit2gtk-4.1, libxdo present); Python 3.11 |
| Baseline `npm run typecheck` / vitest / `cargo test` on master | typecheck green; vitest 627 files / 10,531 tests green (the one red, `platform.test.ts`, was this harness's `TANDEM_APP_DATA_DIR` lacking `tandem` in its path — the prefix is now `mktemp -d /tmp/tandem-sweep-XXXXXX`); `cargo test` 215/216 with one environment failure: `the_http_client_ignores_an_ambient_proxy` was defeated by this container's ambient `no_proxy=127.0.0.1,…`, which reqwest honours. Fixed in this PR — the test now clears `no_proxy`/`NO_PROXY` for its duration and restores them. 216/216 after. |
| Hook worktree guards | `.claude/hooks/{typecheck-on-edit,svelte-check-on-edit,related-test,format-on-edit}.sh` |
| `Skill`-in-subagent probe | Workflow subagents (default and `agentType` ones) have the `Skill` tool. `simplify` loads its instructions inline and runs single-pass (subagents have no `Agent` tool for its 4-way fan-out); `code-review` runs as a forked execution and returns findings as text (no `ReportFindings`). The probe's `code-review` call found a real defect in the first draft of the hook guards (backslash normalisation ordering), now fixed. |
| Worktree + symlinked `node_modules` probe | A worktree under `.claude/worktrees/` with `ln -s` `node_modules`: `npx husky` arms `.husky/_/pre-push`; `tsc`, `svelte-check`, `biome`, `vitest` and `npm run test:e2e` all run. One environment fix was needed for E2E: this container ships Chromium build 1194 under `$PLAYWRIGHT_BROWSERS_PATH` while `@playwright/test@1.58` looks for build 1234 in the newer `chrome-linux64` / `chrome-headless-shell-linux64` layout, so every launch failed. Aliased in place rather than downloaded; the workflow's E2E stage repeats the alias when needed. |
| Auto-merge repo setting | asked of Bryan; until enabled the loop merges via API when green |
| Decisions recorded | `decisions.md` + comments on #1827, #1753, #1754, #1813, #1787, #1788, #1748, #1820 |
