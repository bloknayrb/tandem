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

### Phase C — Execute (parallel worktrees)

**Before spawning:** cross-check target files across all plans. Any two plans that touch the same file → those issues go sequential through C/D/E. Everything else stays parallel.

Spawn `general-purpose` agents with `isolation: "worktree"`, one per non-colliding issue. Each agent:

1. Implements the plan in its worktree
2. Runs `npm run typecheck` and relevant tests
3. Commits on a feature branch (`fix/issue-N-short-description`)
4. Produces `execute-report.md` with: files changed, test results, any deviations from plan, and the final manual-test checklist

**Do not use `professional-agents:developer`** — it loses changes on worktree exit. Verified via memory `feedback_worktree_agent_persistence.md`.

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

## History

- **Waves 1-3** (PRs #111-#147): informal version of this workflow, refined each wave
- **2026-04-05**: formalized to 10 steps after three review agents caught real process gaps during a Wave 3 PR review
- **Wave 4** (PRs #148-#228): full workflow applied, manual testing prep moved into Phase A
- **2026-04-10**: documented and wired to `/issue-pipeline` slash command
