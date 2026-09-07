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
`git worktree add … || git -C <wt> checkout <branch>`; ship checks `gh pr list --head <branch>`
before creating; `args.known` lets a resumed run skip.

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
   keyword + `#N` appears outside `## Closes`; `gh pr merge --auto --merge` (result recorded as
   data — the repo refuses while auto-merge is off); no PR-activity subscription exists here, so
   the main session polls CI (`subscribed: false`). Returns `{group, branch, pr, closes[], refs[],
   unresolved[], bryan[], skillVersion}`.
10. **postShipReview** — `code-review` once more on the pushed head; findings → fix → push.

Models/effort: plan + reviewers at the group's tier; L-tier domain reviewer `effort: max`;
verify/review `high`; simplify/ship `low`. `isolation` unused (worktree managed explicitly).

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
| 3 | C privacy & authority | #1769 #1733 → #1770 #1779 #1803 (+#1619 #1710 folded into #1803) | `fix/privacy-and-authority-1769` | — | — | — | — | planned | Launched 2026-09-07 08:52 after F-doctor merged (run `wf_0a5a9898-f59`, probe ports 4928/4929), concurrently with J2. Seven issues incl. the two read-side twins; skill 15 → 16 plus the body hash pinned since #1896. |
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
| 7 | I-release | #1748 (+G) #1856 #1830 #1831 #1832 (fix halves; policy halves to Bryan) + #1825 CI section | — | — | — | — | planned-not-started | **#1748 item 3 is already done** — the `NPM_TOKEN` expired mid-release and `publish.yml` moved to npm Trusted Publishing out of band on 2026-09-06. Items 1, 2 and 4 remain. |
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
| Worktree + symlinked `node_modules` probe | A worktree under `.claude/worktrees/` with `ln -s` `node_modules`: `npx husky` arms `.husky/_/pre-push`; `tsc`, `svelte-check`, `biome`, `vitest` and `npm run test:e2e` all run. One environment fix was needed for E2E: this container ships Chromium build 1194 under `$PLAYWRIGHT_BROWSERS_PATH` while `@playwright/test@1.58` looks for build 1234 in the newer `chrome-linux64` / `chrome-headless-shell-linux64` layout, so every launch failed. Aliased in place rather than downloaded; the workflow's E2E stage repeated the alias when needed (removed in wave 2 — the stage now runs `npx playwright install chromium` when a build is missing). |
| Auto-merge repo setting | asked of Bryan; until enabled the loop merges via API when green |
| Decisions recorded | `decisions.md` + comments on #1827, #1753, #1754, #1813, #1787, #1788, #1748, #1820 |
