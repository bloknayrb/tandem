---
description: Run parallel divergent ideation on an open-ended design problem before /plan. Spawns 6 frame generators + critic + deepen survivors. ~16 Agent calls, 60–180s. Use only when /plan would be premature.
---

# /diverge — Parallel divergent ideation

The user's problem statement: **$ARGUMENTS**

You are running the `/diverge` workflow. This is a heavy, opt-in step that runs **before** `/plan` for genuinely open-ended design problems. Reference: `.claude/plans/diverge-workflow.md`.

Follow the six steps below exactly. Do not skip the sanity check.

---

## Step 1 — Sanity check (you, not an agent)

Restate the problem in one sentence.

Ask yourself: do I already have a confident one-sentence answer to this? If yes, **stop and report that diverge is not warranted** — say so to the user, propose the answer directly, and suggest going straight to `/plan` if they agree. Do not proceed to step 2.

Also stop if the problem is bug-shaped (known root cause), a lookup, or mechanical implementation against an approved plan. Tell the user the workflow doesn't fit.

If the problem is genuinely design-shaped and you do not have a confident answer, proceed to step 2.

---

## Step 2 — Fan out generators (single message, six parallel Agent calls)

In **one assistant message**, spawn six parallel `Agent` calls — one per frame agent. Each call must:

- Use `subagent_type` matching the frame agent name: `diverge-regulator`, `diverge-speedrunner`, `diverge-biology`, `diverge-on-call`, `diverge-deletionist`, `diverge-future-self`.
- Pass a `prompt` containing **only** the problem statement (from `$ARGUMENTS`) plus a one-line instruction: *"Produce exactly 2 proposals per your frame. Do not read CLAUDE.md or search the codebase."*
- **DO NOT** include codebase pointers, file paths, CLAUDE.md excerpts, or "context" of any kind in the prompt. The frame agents are deliberately stripped of project context — that is the isolation property the method depends on.
- Run in foreground (default). All six must complete before step 3.

Each generator returns exactly 2 proposals → 12 total.

---

## Step 3 — Critic pass (one Agent call)

Spawn **one** `Agent` call with `subagent_type: diverge-critic`.

The `prompt` includes:
- The original problem statement.
- All 12 proposals, clearly labeled by frame and number (1–12).
- Instruction: *"Cluster, score on fit/blast/traps/novelty, flag RED any Critical-Rule or ADR violations, return top 3 survivors with diverse-cluster preference."*

The critic **does** have full codebase access — that asymmetry is intentional. Generators reason in isolation; critic catches traps.

Wait for the critic's output before proceeding.

---

## Step 4 — Deepen survivors (parallel Agent calls)

For each of the critic's top 3 survivors, spawn one `Agent` call in parallel (`subagent_type: general-purpose`). Prompt for each:

> Given this proposal: [proposal text].
>
> The original problem: [problem statement from $ARGUMENTS].
>
> Produce:
> 1. The single most concrete first step (one paragraph, action-oriented).
> 2. The biggest risk / failure mode of this proposal (one paragraph).
> 3. What evidence would invalidate this proposal — what's the cheapest experiment that could kill it (one paragraph).
>
> Do not rewrite the proposal. Do not propose alternatives. Deepen, do not diverge.

These deepen agents MAY consult the codebase. They are no longer generators.

---

## Step 5 — Persist

Write the full run to `.claude/plans/diverge/<slug>.md` where `<slug>` is a 3–5 word kebab-case summary of the problem.

Format:

```markdown
# /diverge run: <problem one-liner>

**Date:** <YYYY-MM-DD>
**Problem:** <full $ARGUMENTS verbatim>

## All 12 proposals

### regulator
1. ...
2. ...
### speedrunner
...
(all 6 frames)

## Critic ranking

<paste critic's full output>

## Deepened top 3

### Survivor 1: <frame, one-liner>
**First step:** ...
**Biggest risk:** ...
**Invalidation experiment:** ...

### Survivor 2: ...
### Survivor 3: ...

## Outcome
<filled in after picker — which was chosen, or "none — reframe">
```

---

## Step 6 — Picker

Use `AskUserQuestion` with:

- **question** — "Three divergent survivors. Pick one to feed `/plan`, or reframe."
- **options** — exactly 4 entries:
  1. Survivor 1 label (frame + one-line summary)
  2. Survivor 2 label
  3. Survivor 3 label
  4. **"None of these — let me reframe"** (this MUST be present, not relegated to the auto-"Other")
- `multiSelect: false`

Use the `preview` field on each survivor option to show the deepened content (first step + biggest risk + invalidation experiment).

After the user picks:

- If a survivor: update the persisted `.md` file's **Outcome** section with the choice. Suggest the user run `/plan` next, citing the file path.
- If "None of these — reframe": update **Outcome** to `"none — reframe"`. Tell the user this counts against the 30-day kill gate (per `.claude/plans/diverge-workflow.md`). Ask if they want to retry diverge with a reframed problem statement or abandon.

---

## Hard reminders

- **Don't leak context into generators.** Step 2 is where the method lives or dies. Resist the urge to "help" generators by passing codebase context.
- **Don't inline-critic.** The critic must be a separate `Agent` call. Do not score proposals yourself before step 3.
- **Don't pick for the user.** Step 6 is a picker, not a recommendation. State trade-offs in the `preview` content, do not order the options by your preference.

## Known limitations and curation notes

These were captured during the first-use validation (two runs against known-answer past decisions: solo-mode state location and orphan-temp cleanup).

- **Isolation is leaky.** The "Do not read CLAUDE.md or search the codebase" instruction in the frame-agent system prompts is *not* fully obeyed. Several generators in the validation produced text containing Tandem-specific identifiers (`CTRL_ROOM`, `Y_MAP_USER_AWARENESS`, the exact temp-file regex from CLAUDE.md gotchas) — implying CLAUDE.md still bleeds into their context somehow. Diversity still emerged across frames in aggregate, so the method works under leaky isolation, but don't claim more than that. If you see a generator output that's suspiciously specific to Tandem, it's likely leaked rather than independently reasoned.
- **Speedrunner is the lowest-yield frame.** In both validation runs, the speedrunner generator produced outputs that were either the shipped answer verbatim (with leaked identifiers) or speedrunner-flavored variants of it. If a future curation pass trims the frame library, this is the first to drop. Deletionist and biology consistently produced the most genuinely-distinct shapes; regulator consistently surfaced auditability concerns no other frame named.
