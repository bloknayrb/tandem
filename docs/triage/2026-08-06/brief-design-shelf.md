# The deferred design-system shelf

**Issues:** #989, #964, #928, #916, #892, #832  **Decision needed:** Defer all six past v1.0 — yes or no (with #832 carved out as the one exception worth doing now)?

## What these are

Six open issues, all labelled `needs-design-decision`, all with **no milestone**, created 2026-05-24 → 2026-06-03, all zero-comment except #832 (one comment, yours, 2026-05-31). All six are leftovers of the `feat/design-system-impl` umbrella:

- **#989** — full checkbox bulk-selection in the annotation rail. Today only `ImportedCard.svelte:35` renders `annotation-select-checkbox-{id}`; the shipped strip is `BatchPromoteBar.svelte` (`batch-promote-bar`/`-count`/`-clear`/`-confirm`). Net-new feature, not a re-skin.
- **#964** — motion scene A17 (streaming text). `docs/design-system-impl/motion.md:156` records the defer: no substrate, replies go through ChatPanel, not Tiptap.
- **#928** — click a margin stub pip to open the annotation in the rail.
- **#916** — per-boundary hysteresis tuning; `MARGIN_VIEW_HYSTERESIS_PX = 32` still a single constant (`src/client/layout/editor-stage.svelte.ts:115`, used at :402).
- **#892** — anchored ↔ stacked margin display toggle. Explicitly "design exploration — not yet scoped."
- **#832** — PeekStrip content preview. **Half shipped:** right-side `.peek-dot`s are live annotation data (`PeekStrip.svelte:83–94`); left-side `.peek-tick`s are still the hardcoded `h1/h2/h2/h3/h2` decorative pattern (`PeekStrip.svelte:77–81`).

## Why they stalled

Not neglect — a **recorded decision**. `docs/plans/2026-06-11-v1-roadmap-reconciliation.md:69` lists all six by number under "Explicitly out of scope … design issues needing hardware/testers/taste." Nothing in `docs/roadmap.md` v1.0 scope references any of them. **None is GA-gating.**

Two facts moved since: #917 shipped (closed 2026-07-30, margin vertical pressure + elastic column), which addresses the collision-pressure degradation #892 cites as its motivation, and names #928 as "the escape hatch for extreme clusters" (`docs/plans/2026-07-30-…-elastic-width.md:128`). So #892 got weaker and #928 got slightly stronger — neither enough to gate.

## Options

1. **Defer all six** — zero cost now; #832 stays visibly half-finished (asymmetric peek: real dots right, fake ticks left).
2. **Defer five, do #832's left half** — ~an afternoon: lift the heading list `OutlinePanel` already computes to `App`, pass into `PeekStrip`. No design decision remains; your own comment settled it. Forecloses nothing.
3. **Defer five, close #892 outright** — its premise was partly consumed by #917; keeping it open implies an unmade decision that may no longer exist.
4. **Pull the shelf into v1.0** — reopens taste-and-tester work under a hardware-bound release. Not recommended.

## Recommendation

**Option 2, plus close #892.** Defer #989, #964, #928, #916 past v1.0 — reaffirming the 2026-06-11 decision rather than re-litigating it. Do #832's left half now: it is plumbing, not design, and a shipped surface currently renders fake data. Close #892 as superseded-in-motivation by #917 (a fresh issue can be filed if stacked mode is ever wanted for its own sake).

## If yes / If no

**If yes:** milestone the four onto `post-v1.0`; one PR threading the heading summary into `PeekStrip` (+ E2E on `peek-tick` count); a close comment on #892 citing #917 and the elastic-width plan.
**If no** (pull any into v1.0): #989 and #892 each need a design pass before a plan; #964 requires a streaming document-write path — a feature, not polish; #916 needs a user-feel test procedure that does not exist yet. That is the real cost of saying no.
