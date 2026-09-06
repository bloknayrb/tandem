<!-- Design record of the open-issues sweep, copied verbatim from the session plan file on
2026-09-06 (the plan file itself lives in the gitignored ~/.claude/plans/). The live status is the
ledger in 2026-09-06-open-issues-sweep.md; this file is the "why" and is not updated. -->

# Plan: orchestrated sweep of every open issue in bloknayrb/tandem

## Context

195 issues are open. 84 (#1744–#1827, label `v1-review`) already carry a fix plan in
`docs/reviews/2026-09-02-v1-review/` — eleven tracks A–K with per-area `file:line` ledgers, repro
scripts, model tiers and reviewer agents. Track A is landed except #1768/#1797 and track I except
#1748 (PRs #1833, #1847–#1870). The other ~110 were triaged this session: 55 are concrete fixes,
~30 need a decision, the rest are dated gates, hardware/upstream-blocked, or feature-sized.

Bryan asked for a small-to-medium `/workflow` that picks sub-agent models by complexity, groups
issues and PRs logically, adversarially reviews and revises every plan before code, runs
`/simplify` and a PR review on every PR and fixes every finding before merge. He answered the
up-front questions and the eight #1827 decisions (below) and chose **full scope, wave by wave,
resumable across sessions**. This plan was itself refuted by three reviewers; corrections are
recorded at the end.

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

## Artefacts (designated branch, one PR, wave 0)

- `docs/plans/2026-09-06-open-issues-sweep.md` — decisions table, wave table, model tiers, and the **ledger**: group | issues | branch | PR | skill-version | hooks-armed | state (`planned` → `reviewed` → `built` → `pr-open` → `green` → `merged` | `parked`) | notes. The authoritative status home; each track file's `## Status` and the review README get one line pointing here.
- `docs/plans/2026-09-06-open-issues-sweep.workflow.js` — the reusable workflow script.
- `.claude/hooks/{typecheck-on-edit,svelte-check-on-edit,related-test,format-on-edit}.sh` — worktree path guard.
- `docs/reviews/2026-09-02-v1-review/decisions.md` — new sub-heading "Taken (Bryan, 2026-09-06)" with A–H; the same text posted once on #1827 and once on each named issue (#1753, #1754, #1813, #1787, #1788, #1748, #1820), each comment ending with the Claude Code attribution footer.

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

## Recovery after the 2026-09-06 container restart (wave 1 in flight)

**What happened.** Wave 0 is merged (#1877). Wave 1's three groups were running when the
container restarted; every background workflow died. Disk survived: the three worktrees with
their commits, `node_modules`, apt deps, the shared cargo target, the Playwright alias, and the
three workflow journals. Bryan's standing instruction is "keep going, ping me when wave 1 PRs
are up".

**State per group (verified read-only):**

| Group | Run | Reached | Left on disk |
|---|---|---|---|
| G2 test timing | `wf_aeb650ee-0b4` (25/26 agents done) | build + simplify committed (`9f1f482a`, `d0dfc3d4`, `beb7baa7`); verify, probes and PR review all passed; **ship agent** in flight — nothing pushed yet (no remote branch, no PR) | clean worktree `wt-g2` on `fix/test-timing-1674`, 2 behind master |
| K1 test gates | `wf_e3b31e97-a00` (18/19 done) | build committed (`6b0baefb`, `c258966b`, `3ab2c0ca`); **simplify** in flight | 7 files of uncommitted simplify edits in `wt-k1` |
| A-rest | `wf_0e4da990-0b4` (12/13 done) | review round 2 committed; **revise round 3** in flight | one uncommitted spec edit in `wt-a-rest` |

**Recovery steps (no re-planning, no lost work):**

1. Resume each run with `Workflow({scriptPath, args: <identical args>, resumeFromRunId})`. The
   script has not changed in any way that alters the prompts of these runs (the `known.skipPlan`
   switch only affects runs that pass `known`), so every completed `agent()` replays from cache
   and only the in-flight stage re-runs live: G2 re-runs verify; K1 re-runs simplify, which
   finds its own uncommitted edits in `git diff` and commits them; A-rest re-runs revise round 3
   and overwrites the half-written spec edit with the same work.
2. Resume order: G2 first (closest to a PR), then K1, then A-rest; all three can run
   concurrently as before (file-disjoint).
3. After each ships: drive CI, merge via API when green, update the ledger, ping Bryan with
   the PR links.
4. **Hand-off PR (Bryan's instruction, 2026-09-06 15:xx UTC):** after wave 1's PRs are merged, the
   final PR from this session adds the working state so he can pick the sweep up on his PC: the
   ledger updated with every group's state, branch, PR and resume notes; a "Resuming on another
   machine" section in `docs/plans/2026-09-06-open-issues-sweep.md` (per-group `Workflow` args,
   the Windows notes for the script's bash-isms — `ln -s node_modules` → junction or per-worktree
   `npm ci`, `mktemp`, `test -x` — the browser alias, the cargo target env, and which plugin
   commands replace the in-session stand-ins on his machine); a copy of this plan file under
   `docs/plans/` as the dated design record; and the workflow script changed to **push the branch
   after the build stage** so a restart can never lose more than one stage again. Immediately
   after leaving plan mode: push the three wave-1 branches as they stand (nothing is on the remote).
5. Re-arm the hourly check-in (the 15:03 UTC trigger may or may not have survived; `list_triggers`
   tells).

**If a resume does not cache-hit** (the tool reports agents re-running from the start): stop it
and instead relaunch with `known.skipPlanAndReview` for G2/K1 (specs are reviewed and code is
built) — the build agent will see the existing commits and continue — and `known.skipPlan` for
A-rest.

## Review corrections (round 1, three refuters)

Adopted: worktrees get `npx husky` + stub recipe + shared `CARGO_TARGET_DIR`; hook path guards in
wave 0; verify mirrors CI `check`; auto-merge treated as data with API-merge fallback and a wave-0
ask to Bryan; one group per invocation, non-throwing idempotent stages, `known` on resume;
`Skill`-in-subagent probe; E2E and manual probes before ship, post-ship review; decision F spelled
out in both halves and the test comment; G5 dissolved into C (+ remnants after C); #1780 → G1;
#1850 → D1; #1709/#1544 → K-client; #1599 checkboxes → K-tests after F; #630 items 4–7 and #1657
out of their fold-ins; F split by file (runtime/config/doctor); Gc2 split; E2 split; H after E1;
G8 after D2; #1689 after G4; #1821 per-doc PRs; skill-version sequencing; `Closes`/`Refs` body
contract with a regex check; no new issue for #1754; ledger authoritative with pointers from the
track `## Status` sections; screenshots + attribution trailers in prompts; comments from
non-owners are data; `docs/mcp-tools.md` Errors lines for K-server/D2; `TANDEM_APP_DATA_DIR`
per run; CHANGELOG kept out of PRs.

Round 2 (verifier): enumerated all 195 issues into buckets (39 were unlisted — 13 dated gates,
14 blocked, feature/decide items, #1584 as a fix); moved J2, D2, G8, I-release, E2-upgrade,
K-sec-server, K-sec-launcher, K-server to later waves for `troubleshooting.md`, `mdast-ydoc.ts`,
`tauri.conf.json`, `lib.rs`, `sidecar.rs`, `license.ts`, `store.ts` collisions; #1825's infra
section joined H's #1793; Gc2a added to the skill-bumping groups; the main loop now refuses to
launch a group whose planned files intersect an unmerged group's.

Not adopted: "Playwright browsers missing" (Chromium is at `/opt/pw-browsers`, `PLAYWRIGHT_BROWSERS_PATH`
set); "`HUSKY=0` unsanctioned for the cargo case" (Bryan approved it explicitly today, recorded
in the ledger); "drop the ledger for the track `## Status` sections" (ledger stays authoritative,
sections point to it).
