# K-client — #1727 Consolidate the three Cowork enable-confirmations (Refs only)

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. This PR does **not close** #1727 and
does no code work against it. No area-ledger row (filed as its own dated-gate issue, not part of
the #1824 batch). Referenced (`Refs #1727` in the PR body, never a closing keyword) because
K-client-1713 touches the modal-stacking class of bug #1727 also discusses, and because item I of
`K-client-1824.md` touches Settings-modal open/close sequencing adjacent to the wizard.

## Problem

#1727 is Design Call #09's dated deferral (decided 2026-08-31): consolidating
`CoworkOnboardingStep.svelte`, `IntegrationWizardModal.svelte`'s `view === "cowork"` sub-view, and
`CoworkSettings.svelte`'s inline confirm into one shared confirmation surface waits behind the
Cowork transport redesign (#1455, review 2026-10-15), with #1727's own revisit dated 2026-11-15 —
a month after #1455's, so the transport outcome is known before this is re-decided. Per CLAUDE.md's
dated-gate rule, the outcome at revisit must be keep / replace / retire, decided by Bryan against
`git log` and issue state, not re-deferred.

#1727's body also carves out the shared `cowork-enable-confirm-btn` testid
(`CoworkSettings.svelte:511`, `IntegrationWizardModal.svelte:1286`,
`tests/design-system-impl/__snapshots__/testid-set.snap.txt:74`) as explicitly NOT part of the
deferral — the issue's own text: "It has not been fixed... Splitting it means adding a distinct
testid and regenerating that snapshot."

## Why this group does no work here

The group instructions for this PR are explicit: **"#1727 — Refs only, NO WORK... do not
consolidate the three confirmations."** That instruction is authoritative for this PR regardless of
what an earlier sweep-planning pass (`docs/plans/2026-09-06-open-issues-sweep.md`'s wave-7 row,
`#1727-split (Refs)`) may have scoped in — re-checked against the current, more specific per-issue
brief for this run, which names #1727 as reference-only. The testid-split carve-out therefore also
stays undone by this group: it remains tracked inside #1727's own body (already filed, so "NO
UNFILED DEFERRALS" is satisfied — the carve-out has a tracked home, just not this PR), available
for whoever next works #1727 or a future sweep pass that explicitly scopes it in.

No Cowork copy in `K-client-1824.md`'s fixes needed the three-confirmation surfaces touched, so
there is no incidental code change to attribute to this reference either — the reference exists
solely because #1713 and #1824-item-I fix the SAME modal-stacking failure class #1727 is adjacent
to (a second overlay opening without closing/suppressing the one already up), which is useful
context for whoever next reads #1727, not a code dependency.

## Fix

None. This file exists so the PR body's reference to #1727 has a written record of why it's a
reference and not a close, per the wave-lesson rule ("cross-check the `## Closes` list against your
own notes before writing the PR body").

## Tests

None — no code changes.

## Done when

The PR body contains `Refs #1727` (no closing keyword) with a one-line pointer to this file;
#1727 remains open, unmodified, with its 2026-11-15 revisit date intact.

## Not in scope

Everything in #1727's body: the three-confirmation consolidation, the `cowork-enable-confirm-btn`
testid split, and any change to `CoworkOnboardingStep.svelte`, `IntegrationWizardModal.svelte`'s
Cowork sub-view, or `CoworkSettings.svelte`'s inline confirm.
