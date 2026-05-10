# Skeptical content review — issue-pipeline skill conversion plan

Plan: `~/.claude/plans/update-docs-agent-workflow-md-to-be-soft-seahorse.md`
Baseline: `docs/agent-workflow.md` (222 lines, last touched 2026-04-11).

## Lesson-citation accuracy (spot checks)

**`feedback_prefer_sonnet_subagents.md` — accurate, but plan over-applies.** The memory says "if the task would take the main thread >5 tool calls or require reading >500 lines, delegate" and explicitly warns against delegating trivial work. Plan section 4 says "prefer sonnet for substantive subagents (Phase A/C/F/G/H); reserve Opus for the manager." That matches, but the proposed "model column with sonnet as default for all rows" (section 10) drops the trivial-task carve-out. **IMPORTANT:** the skill should preserve the threshold guidance ("delegate when >5 calls or >500 lines"), not just blanket-default to sonnet.

**`feedback_resume_locked_worktree.md` — accurate.** Plan Phase C resume protocol matches: dispatch `general-purpose` without `isolation`, pass absolute path, use `git -C`, run `git status`/`git diff` first. Memory cites #364, #483, #484 as proof. Faithful.

**`feedback_plan_drift_from_merged_reality.md` — accurate.** Plan Phase A wording ("If the issue references or follows a merged PR, the agent must run `gh pr diff <N>` on the predecessor and validate against the merged contract") matches the memory verbatim in spirit. Good.

**`feedback_agent_stall_on_implementation.md` — slightly embellished.** Memory says "stream watchdog fires (600s)" and "split by file rather than by PR." Plan says ">4 files" as the trigger threshold. **NICE-TO-HAVE:** the memory does not specify "4" — it says "5-6 file edits." Either cite the source range or drop the false precision. Also, memory says "implement directly rather than dispatching agents" as the primary remedy; plan presents that as the third option. Reorder.

**`feedback_two_agent_rootcause_validation.md` — accurate, scope-correct.** Memory restricts to "infra/tooling (gitignore, husky, lint configs, CI, build tooling)" and the plan mirrors that scope ("infra-only fixes (gitignore / husky / lint / CI / build)"). Good — explicitly scoped, not over-generalized.

## Missing lessons (agent-workflow-relevant, post-2026-04-11, uncited)

Searched MEMORY.md index for agent/workflow-relevant feedback files not in plan's source list:

- **`feedback_parallel_agents_same_worktree.md`** — IMPORTANT. "Parallel agents in same worktree can bundle unrelated changes into one commit." Directly relevant to Phase G/H where the manager may dispatch multiple fix agents per PR. Not cited.
- **`feedback_bundled_scope_when_fix_reveals_bug.md`** — NICE-TO-HAVE. PR-scope rule that affects Phase G decisions.
- **`feedback_plan_review_catches_gaps.md`** — NICE-TO-HAVE. Reinforces Phase B Round-1 design but isn't cited.
- **`feedback_review_convergence_validates_severity.md`** — NICE-TO-HAVE. Phase F finding-triage signal.
- **`feedback_never_skip_hooks.md`** — IMPORTANT. Phase E PR creation can hit pre-push hooks; recovery via `git reset --soft HEAD~1` belongs in failure modes.
- **`feedback_correctness_over_speed.md`** — meta-rule worth a one-liner in "When to use."

Plan's source list is 13 files. MEMORY.md has ~25 agent-workflow-adjacent feedback entries. The plan's "all 11 new lessons + 5 amendments" claim is not literally exhaustive — it's a curated subset. **BLOCKER if presented as exhaustive; IMPORTANT to surface the gap.**

## Over-incorporation candidates (war-story, not binding rule)

- **Manager-branch-switching on `feat/570`** (plan section 11) — single incident. Hard rule "never `git checkout` in shared tree once Phase C is dispatched" is sound but should be presented as one rule with the war-story as rationale, not duplicated as both a hard rule and a standalone v0.4+ lesson.
- **`feedback_two_agent_rootcause_validation.md`** — only triggered once (Windows lint-staged). Scoping to "infra-only" is right; do not let it expand to Phase G/H generally.
- **`feedback_brief_subagents_about_webserver_workaround.md`** — workaround for #230. NICE-TO-HAVE: this is environmental and may obsolete. Mark with a "valid until #230 fixed" caveat or it'll calcify.
- **`feedback_claude_in_chrome_manual_testing.md`** — Bryan's current preference, not a permanent process rule. Frame as "current Gate 1 default," not eternal.

## Phase ordering and rule conflicts

**IMPORTANT:** "Manager never runs `git checkout` in shared tree once Phase C is dispatched" potentially conflicts with **Gate 2's sequential-merge-with-rebases**. Gate 2 explicitly rebases remaining PR branches after each merge — that's a worktree operation, but if the manager interprets "shared tree" loosely, it could refuse to drive the rebase loop. The skill must explicitly carve out: "Gate 2 rebase ops happen IN worktrees (or are delegated), never in the manager's shared tree." Otherwise the rule contradicts itself.

Also: hard rule #1 ("manager never reads source files") already implies a "no working-tree mutation" stance. Adding a `git checkout` rule belongs as a clarifying sub-bullet under rule #1, not a parallel rule #5.

## Verification adequacy

The 6 steps are weak. Missing:

1. **No content-correctness check.** Steps verify frontmatter, line count, and grep-distinctive-phrases — but do not verify a human/agent reads the resulting SKILL.md and confirms the 11 lessons are actually expressed coherently, not just present as keyword tokens. **IMPORTANT: add a "skim-pass review by an independent agent" step.**
2. **No check that `~/.claude/commands/issue-pipeline.md` was actually updated** — only that `CLAUDE.md` was. Add: `grep "agent-workflow" ~/.claude/commands/issue-pipeline.md` returns nothing.
3. **No check `.pipeline-state/` ignore is preserved.** If the doc moves, ensure `.gitignore` still covers it.
4. **Cold-test step 5 is theatre.** "Type `/issue-pipeline 999`" doesn't prove the skill auto-loaded — only that the slash command works. Better: confirm via Skill tool listing or session reminder that `issue-pipeline` appears in available skills.

## Summary

Plan is structurally sound and the lesson-to-section mapping is mostly faithful. **Two BLOCKER-adjacent issues:** (1) the "all 11 + 5" exhaustiveness claim is overstated — at least 5 relevant feedback files are uncited; (2) the Gate 2 rebase carve-out is missing and the new git-checkout rule needs reconciling with rule #1. **IMPORTANT fixes:** preserve sonnet-delegation threshold, soften the ">4 files" precision, add independent content-review verification step.

Word count: ~595.
