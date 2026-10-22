---
description: Run parallel divergent ideation on an open-ended design problem before /plan. Spawns 6 frame generators + critic + 3 deepen survivors. 10 Agent calls, 60–180s. Use only when /plan would be premature.
---

# /diverge — Parallel divergent ideation

The user's problem statement: **$ARGUMENTS**

You are running the `/diverge` workflow. This is a heavy, opt-in step that runs **before** `/plan` for genuinely open-ended design problems. This file is the complete, tracked definition of the workflow. (An earlier reference doc, `.claude/plans/diverge-workflow.md`, lived in a gitignored directory and is absent from any fresh clone; nothing here depends on it.)

Follow the six steps below exactly. Do not skip the sanity check.

---

## Step 1 — Sanity check (you, not an agent)

Restate the problem in one sentence.

Ask yourself: do I already have a confident one-sentence answer to this? If yes, **stop and report that diverge is not warranted** — say so to the user, propose the answer directly, and suggest going straight to `/plan` if they agree. Do not proceed to step 2.

Also stop if the problem is bug-shaped (known root cause), a lookup, or mechanical implementation against an approved plan. Tell the user the workflow doesn't fit.

If the problem is genuinely design-shaped and you do not have a confident answer, proceed to step 2.

---

## Step 2 — Fan out generators (single message, six parallel Agent calls)

In **one assistant message**, spawn six parallel `Agent` calls with `subagent_type: diverge-generator`, one per frame below. Each call's `prompt` holds exactly two things: the problem statement from `$ARGUMENTS`, verbatim, and that frame's block, pasted verbatim. Nothing else — no codebase pointers, file paths, CLAUDE.md excerpts or other context, and no paraphrase of the frame. Generators are deliberately stripped of project context; that isolation is the property the method depends on. Run them in the foreground; all six must complete before step 3.

Each generator returns exactly 2 proposals → 12 total.

### Frames

**regulator**

You are a regulator reviewing this system. The product must be **auditable, traceable, and rollbackable**. Every change is a compliance question:

- Who did this? When? Why? On whose authority?
- What is the recovery path if this is wrong?
- What is the user's right to know about state changes affecting them?
- What is the retention policy? What gets logged, what gets purged?
- What's the defensible trail of evidence if questioned six months later?

Privacy, consent, retention, and after-the-fact reconstruction are first-class concerns. Performance and developer ergonomics are not your problem.

Two numbered proposals, each 4–7 sentences. First sentence states the proposal as a concrete shape. Remaining sentences develop what that shape concretely means under the regulator frame: what gets logged, what's reversible, what the user sees, where the audit boundary lives.

**speedrunner**

You are a speedrunner studying this problem for the glitch. You don't want the **right** solution; you want the **fastest** one — the path that exploits something weird about how the existing system already works.

- What's already in the codebase that solves 80% of this for free if you squint?
- What's the dirty repurposing of an existing primitive?
- What's the one-line change that makes the whole problem disappear because some other component already did the work?
- What's the "wait, why don't we just use the thing we already have for the thing we already use it for, but for this too" move?
- What's the technically-deferred-to-later mechanism that could be exploited now?

You are not maintainable. You are not future-proof. You are FAST. Glory is in the trick.

Two numbered proposals, each 4–7 sentences. First sentence states the trick concretely. Remaining sentences develop what existing thing you're exploiting, what the actual diff would look like, and what makes this a glitch rather than a clean design.

**biology**

You are a biologist. Biological systems do not have central coordinators, explicit RPCs, or a "main" function. They have **gradients, signals, emergence, decay, and local rules that produce global behavior.**

- What is the gradient here? What concentration of what signal drives behavior?
- What propagates by diffusion rather than by explicit call?
- What decays? What has a half-life?
- What's the local rule that, when followed by every component, produces the global outcome we want?
- What's the chemotaxis — what does each part follow toward, away from?
- What's the immune response — what's the marker for "this is foreign, ignore it"?
- What's the apoptosis — the cell-suicide path that lets the system clean up dead state?

You may not propose anything with a central scheduler, a top-level orchestrator, or an explicit "call this then call that" sequence. Everything must emerge from local behavior + signal propagation.

Two numbered proposals, each 4–7 sentences. First sentence states the biological analog as a concrete system shape. Remaining sentences develop the local rule, what propagates, and how the desired global behavior emerges without central coordination.

**on-call**

You are the engineer being paged at 3am because something is on fire. Your cognitive bandwidth is degraded. You have a phone, maybe a laptop. You need to **understand what's wrong and stop the bleeding within minutes**, not architect a beautiful solution.

The shape you propose must be:

- **Legible under degradation.** A junior engineer who has never seen this code should be able to read the log/dashboard/error message and know what to do.
- **One-action recovery.** A single command, a single toggle, a single redeploy — not a five-step coordinated rollback.
- **Boring.** The boring obvious solution counts double. Cleverness is a bug at 3am.
- **Observable.** If it goes wrong, the wrongness must be visible. Silent failures are unacceptable.
- **Bounded blast.** When this breaks, what's the smallest blast radius shape we can give it?

Beauty, performance, and forward-looking flexibility are not your problem. Surviving the page is.

Two numbered proposals, each 4–7 sentences. First sentence states the shape concretely. Remaining sentences develop: what the on-call engineer would see, what the single recovery action is, what the bounded blast radius looks like, and why this shape is boring in a good way.

**deletionist**

The best line of code is the one that doesn't exist. The best feature is the one we removed. Your proposals are **negative diffs**: things to delete, mechanisms to retire, abstractions to flatten, configurations to remove.

Force yourself to answer:

- What existing thing, if removed, makes this problem evaporate?
- What is the question we're trying to answer that we could simply stop asking?
- What configuration knob nobody uses can we delete, simplifying the design back to the assumption it was originally built on?
- What "general" mechanism is solving for a case we don't actually have? Can we collapse it to the one case we do have?
- What documentation, comment block, or compatibility shim is load-bearing on something already retired?
- What's the smallest negative diff that solves the problem? **Aim for net-negative LOC.**

You are not allowed to propose anything that requires writing more code than it deletes. The proposal must be a subtraction.

Two numbered proposals, each 4–7 sentences. First sentence states what gets deleted as a concrete shape. Remaining sentences develop: what the deletion enables, what assumption the deleted thing was load-bearing on (and why we no longer need it), and roughly what the line-count delta looks like. Each proposal's first sentence is `Delete <X>.`

**future-self**

You are the engineer who has to extend this feature **three more times over the next six months**. The first extension might be foreseeable; the second and third will not be. Your proposals must answer: *what shape survives that?*

Force yourself to ask:

- What three extensions are most likely? (Pick concrete plausible ones, not abstract "scalability".)
- Of the shapes that solve today's problem, which one **does the least violence** to those extensions?
- Which shape has the cleanest seam to add behavior without rewriting?
- Which shape, when I look back in six months, will I be embarrassed by? (Avoid that one.)
- Which shape becomes *more* legible as use cases multiply, vs. one that becomes spaghetti?
- What's the migration story if this shape turns out wrong? Can a future me back out cleanly?

You are not allowed to over-engineer for hypothetical extensions. The shape must solve today's problem completely. But of the shapes that do, you pick the one with the friendliest seam.

Two numbered proposals, each 4–7 sentences. First sentence states the shape concretely. Remaining sentences name 1–2 plausible extensions, show how this shape absorbs them without rewriting, and identify the cleanest back-out path if this turns out wrong.

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
- If "None of these — reframe": update **Outcome** to `"none — reframe"`. Ask if they want to retry diverge with a reframed problem statement or abandon.

---

## Hard reminders

- **Don't leak context into generators.** Step 2 is where the method lives or dies. Resist the urge to "help" generators by passing codebase context.
- **Don't inline-critic.** The critic must be a separate `Agent` call. Do not score proposals yourself before step 3.
- **Don't pick for the user.** Step 6 is a picker, not a recommendation. State trade-offs in the `preview` content, do not order the options by your preference.

## Known limitations and curation notes

These were captured during the first-use validation (two runs against known-answer past decisions: solo-mode state location and orphan-temp cleanup).

- **Isolation is leaky.** The generator's "no project context" instruction is *not* fully obeyed. Several generators in the validation produced text containing Tandem-specific identifiers (`CTRL_ROOM`, `Y_MAP_USER_AWARENESS`, the exact temp-file regex from CLAUDE.md gotchas) — implying CLAUDE.md still bleeds into their context somehow. Diversity still emerged across frames in aggregate, so the method works under leaky isolation, but don't claim more than that. If you see a generator output that's suspiciously specific to Tandem, it's likely leaked rather than independently reasoned.
- **Speedrunner is the lowest-yield frame.** In both validation runs, the speedrunner generator produced outputs that were either the shipped answer verbatim (with leaked identifiers) or speedrunner-flavored variants of it. If a future curation pass trims the frame library, this is the first to drop. Deletionist and biology consistently produced the most genuinely-distinct shapes; regulator consistently surfaced auditability concerns no other frame named.

## No review gate

`/diverge` has no review date and no retirement criterion (Bryan, 2026-10-22): it is a tool to
use when a problem fits step 1, and nothing more. Its runs are not counted, so nothing needs to
mark a commit or PR as informed by it.
