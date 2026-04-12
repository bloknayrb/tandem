# Agent-Driven Issue Pipeline

The standard 10-step workflow for resolving GitHub issues with Claude Code agents. Validated across Waves 1-4 (PRs #111-#228) and refined on 2026-04-05.

## When to use

- Batch resolution of 3+ open issues
- Issues that are well-scoped (clear acceptance criteria, bounded file set)
- You want to preserve the manager's context and move fast via parallelism

Not a fit for:
- Exploratory work with unclear requirements (use `brainstorming` skill first)
- Single-line typo fixes (just do them)
- Major architectural changes spanning many files (plan separately, execute manually)

## Invocation

```
/issue-pipeline 229 230 231 232 233 234
```

The slash command lives at `~/.claude/commands/issue-pipeline.md`. It briefs the manager session on the workflow and expects GitHub issue numbers as arguments.

## The manager role

The session that runs `/issue-pipeline` is the **manager**. The manager orchestrates; agents do the work.

**Hard rules:**
1. The manager never reads source files directly. The only direct read allowed is `grep` to verify callsite lists produced by Phase A agents.
2. The manager never runs builds, tests, or `/simplify`. Those are agent jobs.
3. The manager writes phase summaries to `.pipeline-state/issue-{N}/{phase}.md` after each phase, then reads from those files in subsequent phases. Do not accumulate raw agent output in chat scrollback — it blows context.
4. `.pipeline-state/` is gitignored.

## The 10 phases

### Phase A — Plan (parallel, one agent per issue)

Spawn one `Explore` subagent per issue, all in parallel. Each agent produces `plan.md` containing:

- **Scope:** what the issue asks for, in one paragraph
- **Callsite list:** every file that needs to change, with function/line references
- **Approach:** the proposed fix
- **Risks:** what could break, what's adjacent
- **Manual-test checklist:** specific steps a human will run at Gate 1 (this must be produced in Phase A, not improvised later)

**Manager verification:** grep the callsite list against the repo to confirm files exist and the agent didn't hallucinate. This is the only direct read the manager does.

### Phase B — Plan review (parallel, 2 reviewers per issue)

For each issue's plan, spawn 2 specialized reviewers in parallel. Pick based on domain:

- `feature-dev:code-architect` — always a good default
- `crdt-reviewer` — anything touching Y.js, annotations, positions, CRDT invariants
- `pr-review-toolkit:silent-failure-hunter` — anything with error handling, catch blocks, fallbacks
- `pr-review-toolkit:code-reviewer` — generic code quality

Reviewers read the plan (not the code) and flag gaps, missing callsites, edge cases, or risks. Manager consolidates findings into `plan-review.md` and amends the plan before Phase C.

**Write-access caveat:** `feature-dev:code-architect` has no Write or Edit tool and cannot persist its review to disk — it returns the review inline in its summary. If you need the reviewer to write `plan-review-architect.md` directly, use `general-purpose` with an architect-framed prompt instead. See Lessons section for details.

### Phase C — Execute (parallel worktrees)

**Before spawning:** cross-check target files across all plans. Any two plans that touch the same file → those issues go sequential through C/D/E. Everything else stays parallel.

Spawn `general-purpose` agents with `isolation: "worktree"`, one per non-colliding issue. Each agent:

1. Implements the plan in its worktree
2. Runs `npm run typecheck` and relevant tests
3. Commits on a feature branch (`fix/issue-N-short-description`)
4. Produces `execute-report.md` with: files changed, test results, any deviations from plan, and the final manual-test checklist

**Do not use `professional-agents:developer`** — it loses changes on worktree exit. Verified via memory `feedback_worktree_agent_persistence.md`.

**Worktree base:** the isolation tool uses `origin/master` as the worktree base regardless of detached HEAD. See Lessons section for mitigation.

### Phase D — /simplify (per worktree)

Each worktree agent runs `/simplify` on its diff as a second pass. This catches duplication, unused code, over-abstraction, and opportunities to reuse existing utilities. The simplify skill has explicit exclusions for intentional patterns — the agent should respect them.

### Phase E — PR (per worktree)

Each worktree agent opens a **draft** PR from its feature branch. PR body includes:

- `Closes #N`
- Summary of the change
- Test plan (from the manual-test checklist)
- Link to any deviations noted in `execute-report.md`

### Phase F — Multi-agent PR review (4 agents per PR, parallel)

For each PR, spawn 4 reviewers in parallel:

- `pr-review-toolkit:code-reviewer` — style, conventions, bugs
- `pr-review-toolkit:silent-failure-hunter` — error handling, fallbacks, stale closures, timer cleanup
- `crdt-reviewer` — where relevant (Y.js, positions, annotations)
- `pr-review-toolkit:pr-test-analyzer` — test coverage adequacy

Each reviewer gets a **focused prompt** scoped to its specialization, not a generic "review this PR" instruction. The silent-failure-hunter consistently finds what code-reviewer misses — don't skip it.

Manager deduplicates findings across agents and writes `pr-review.md`. Verify throw-behavior and error-handling claims against actual code before accepting — LLM reviews inflate issue counts.

**PR base pointer audit:** before kicking off Phase F reviews, verify that stacked PRs have their base pointer set to the parent branch (not master). A wrong base inflates the visible diff with the parent's commits, and reviewers will flag bogus "massive scope" findings. Fix via `gh pr edit <N> --base <parent-branch>` before reviewers start.

### Phase G — Fix review issues (targeted, rework-bounded)

One targeted re-execution agent per PR that has review findings. The agent gets:

- The specific findings (not the full review output)
- The files to touch
- Instructions to make minimal changes

**Rework boundary:** after Phase G fixes, run one targeted re-review (single agent, scoped to changed lines). Do NOT re-run the full 4-agent cycle unless the manager explicitly requests it. Two full review cycles is a sign of poor Phase A planning.

### 🛑 Gate 1 — Manual testing handoff

The manager compiles all manual-test checklists from Phase A/C into a single batched session and hands it to Bryan. Bryan runs the tests and reports back. This is the first pause point.

### Phase H — Fix manual test issues

Targeted fix agents per PR as needed. Same rework boundary as Phase G: one pass, one targeted re-review.

### 🛑 Gate 2 — Merge approval

Manager presents the final state of all PRs (green CI, review approved, manual tests passed) and asks Bryan to approve merge order. Merge is **sequential with rebases**: after merging PR #1, rebase all remaining PR branches onto the new master before merging the next one. Parallel worktrees mean conflicts are possible — handle them at this gate.

## Gates summary

Only two pause points:

1. **Gate 1** — before manual testing (Bryan runs the checklists)
2. **Gate 2** — before merging (Bryan approves order, handles conflicts)

Everything else runs autonomously. No pausing for plan approval, no pausing for review-fix approval.

## Context preservation

After each phase, the manager writes to `.pipeline-state/issue-{N}/`:

- `plan.md` — Phase A output
- `plan-review.md` — Phase B consolidated
- `execute-report.md` — Phase C output
- `pr-url.md` — Phase E PR link
- `pr-review.md` — Phase F consolidated
- `manual-test-checklist.md` — compiled for Gate 1
- `manual-test-results.md` — Bryan's results after Gate 1

The manager reads these files in subsequent phases instead of carrying agent output in conversation context. The directory is gitignored.

## File conflict prevention

Before Phase C, the manager builds a map of `file → [issues that touch it]` from all plans. Any file touched by 2+ issues triggers sequential execution for those issues. The manager documents this in `.pipeline-state/collision-map.md`.

## Failure modes

- **Plan agent hallucinates a callsite** → manager's grep verification catches it, plan gets sent back for one revision
- **Execute agent fails tests** → issue drops from this run, logged for next cycle
- **Phase G fix still broken after one pass** → PR held for manual review at Gate 1
- **Rebase conflict at Gate 2** → manager surfaces it, asks Bryan for direction
- **Review agent produces false positives** → verify against actual code before acting on findings

## Agent selection quick reference

| Phase | Agent type | Why |
|---|---|---|
| A (plan) | `Explore` | Read-only, good at tracing callsites |
| B (plan review) | `feature-dev:code-architect`, `crdt-reviewer`, `pr-review-toolkit:silent-failure-hunter` | Specialized review angles |
| C (execute) | `general-purpose` + `isolation: "worktree"` | Only type that persists changes from worktrees |
| D (simplify) | Same worktree agent | Runs `/simplify` skill on its own diff |
| F (PR review) | `pr-review-toolkit:code-reviewer`, `pr-review-toolkit:silent-failure-hunter`, `crdt-reviewer`, `pr-review-toolkit:pr-test-analyzer` | 4-angle coverage |
| G (fix) | `general-purpose` + worktree | Targeted re-execution |

## Lessons from first full run (v0.3.1)

The workflow's first end-to-end execution on a fresh batch (PRs #237-#243) surfaced five operational findings. Each is captured below as observation → rule → rationale so future runs inherit the fix.

### 1. Worktree base is fixed to `origin/master`

**Observation:** The agent SDK's `isolation: "worktree"` parameter branches new worktrees from `origin/master`, not from the manager session's current HEAD. During Wave 1 the manager checked out `origin/fix/issue-229-crlf-normalize` as a detached HEAD hoping Phase C agents would branch from there; they branched from master anyway. Some Phase C agents noticed and rebased manually (#231, #232, #233-panellayout); #230 did not and stayed master-based, causing Phase F base-display confusion and a manual `gh pr edit --base` cleanup.

**Rule:** When chaining PRs on a common ancestor, do not rely on the manager's detached HEAD. Either (a) instruct each Phase C agent to explicitly `git checkout <base-branch>` inside its worktree before creating its feature branch, or (b) accept that all Phase C branches will be master-based and plan the rebase cost at Gate 2.

**Rationale:** Implicit assumptions about worktree base cost one wasted rebase and several confused reviewers per run. Making the base explicit is a one-line prompt addition.

### 2. `feature-dev:code-architect` cannot write files

**Observation:** This agent type is configured read-only — no Write or Edit tool. When Phase B instructions told it to persist its plan review to `.pipeline-state/<issue>/plan-review-architect.md`, it could not comply and instead delivered the review inline in its summary text. Wave 1 hit this on 4 architect reviews, and the manager had to manually persist each one before Phase C could read them.

**Rule:** For any review role that needs to write output files, use `general-purpose` and frame the role via the agent's prompt. Reserve `feature-dev:code-architect` for cases where the review can legitimately return inline (short, no file persistence needed). The same caveat applies to any other `feature-dev:*` agent whose tool list excludes Write — verify before dispatching.

**Rationale:** Agent-type tool sets are opaque until you hit the limit. One manual persistence pass is tolerable; four is a process smell that signals the wrong agent type was picked.

### 3. Rework boundary is one pass per hypothesis, not one pass per PR

**Observation:** The original doc said "Phase G / Phase H: one pass, one targeted re-review." Wave 1's #239 (E2E server-start timeout) required three distinct passes: 60s→180s timeout (revealed the timeout wasn't the root issue), `stdio: "ignore"` (revealed Playwright's ignore may not propagate to child fds), and finally pre-built `node dist/server/index.js` (success). A strict one-pass rule would have closed #239 after pass 1 or 2, losing the diagnostic signal each failed pass provided.

**Rule:** The rework boundary is one pass per working hypothesis, capped at 3 total passes per PR. When a fix agent reports DONE_WITH_CONCERNS or FAILED with a new root-cause hypothesis, the manager may dispatch one more pass with the new hypothesis without asking the user. Beyond 3 passes, escalate to Gate 1 / Gate 2.

**Rationale:** Strict one-pass rules work when the first hypothesis is right; they fail on multi-layered root causes. Hypothesis-bounded passes preserve the "don't loop forever" intent while allowing diagnostic iteration.

### 4. Debate agents for stuck fixes

**Observation:** When #239 was still blocked after Phase H pass 2, the manager dispatched 3 parallel debate agents (pragmatist, robustness-first, root-cause) plus 1 referee to select the winning approach. The referee hit a quota limit mid-execution, but the 3 self-contained proposals alone gave the manager enough signal to pick "pre-built server" without the referee. This pattern was not in the original workflow.

**Rule:** Add a formal debate escalation sub-process to Phase G/H. When a rework pass fails and the manager is unsure of the next approach, dispatch 2-3 proposal agents with different priors (minimalist / robustness / root-cause investigator) in parallel. Each writes a self-contained proposal. The manager may then decide directly or dispatch a referee. A debate escalation counts as one "pass" for rework-boundary purposes.

**Rationale:** Parallel proposals cost roughly the same tokens as one exhaustive investigation but expose three angles. Self-contained proposals mean the manager is resilient to referee failure.

### 5. PR base pointer hygiene on stacked branches

**Observation:** When Phase C agents produce chained PRs (branch X stacked on branch Y), the PR's base pointer on GitHub should be set to Y, not master. Otherwise the PR diff shows all of Y's commits plus X's, confusing reviewers who think X has massive scope. Phase F reviews for #240 and #242 both flagged "100+ file scope violations" that were base-pointer artifacts, not real scope problems.

**Rule:** Phase E (PR open) must include "if the branch is stacked on another open PR's branch, set `--base <parent-branch>` when running `gh pr create`." The manager should verify PR base pointers in a quick audit step after Phase E completes, and correct any via `gh pr edit --base` before Phase F dispatch.

**Rationale:** Wrong base pointers waste reviewer attention on nonexistent findings and pollute `pr-review.md` with noise. A 30-second audit prevents 20 minutes of false-positive triage.

## History

- **Waves 1-3** (PRs #111-#147): informal version of this workflow, refined each wave
- **2026-04-05**: formalized to 10 steps after three review agents caught real process gaps during a Wave 3 PR review
- **Wave 4** (PRs #148-#228): full workflow applied, manual testing prep moved into Phase A
- **2026-04-10**: documented and wired to `/issue-pipeline` slash command
- **2026-04-11**: v0.3.1 first full pipeline run — 7 PRs merged (#237-#243). Workflow updated with 5 lessons.
