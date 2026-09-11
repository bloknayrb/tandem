# K-client — #1727 Consolidate the three Cowork enable-confirmations (Refs only)

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. This PR does **not close** #1727
and does no code work against it. Referenced (`Refs #1727`, never a closing keyword) because
`K-client-1713.md` and `K-client-1824.md` item I both fix the same modal-stacking failure class
(a second overlay opening without closing/suppressing the one already up) that #1727 discusses.

## Problem

#1727 is Design Call #09's dated deferral (decided 2026-08-31): consolidating
`CoworkOnboardingStep.svelte`, `IntegrationWizardModal.svelte`'s `view === "cowork"` sub-view, and
`CoworkSettings.svelte`'s inline confirm into one shared surface waits behind the Cowork
transport redesign (#1455, review 2026-10-15), with #1727's own revisit dated 2026-11-15. Per
CLAUDE.md's dated-gate rule, the outcome at revisit must be keep / replace / retire, decided by
Bryan.

#1727's body also carves out the shared `cowork-enable-confirm-btn` testid
(`CoworkSettings.svelte:511`, `IntegrationWizardModal.svelte:1286`,
`__snapshots__/testid-set.snap.txt:74`) as explicitly not part of the deferral — splitting it
means adding a distinct testid and regenerating that snapshot, which #1727 says has not been
done.

## Why this group does no work here

The group brief is explicit: "#1727 — Refs only, NO WORK... do not consolidate the three
confirmations." That is authoritative for this PR regardless of any earlier sweep-planning scope.
The testid-split carve-out stays undone here too — it remains tracked inside #1727's own body
(already filed, so "NO UNFILED DEFERRALS" is satisfied), available for whoever next works #1727.

## Fix

None. This file records why the PR body references #1727 without a closing keyword.

## Tests

None — no code changes.

## Done when

The PR body contains `Refs #1727` with a pointer to this file; #1727 remains open, unmodified,
with its 2026-11-15 revisit date intact.

## Not in scope

Everything in #1727's body: the three-confirmation consolidation, the `cowork-enable-confirm-btn`
testid split, and any change to the three confirmation surfaces themselves.

## Review corrections (scope cut)

No blocking findings were raised against this spec. Trimmed restating of the group brief; no
mechanism was ever proposed here to remove.
