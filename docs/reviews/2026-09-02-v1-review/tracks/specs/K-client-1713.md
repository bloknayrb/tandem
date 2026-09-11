# K-client — #1713 First-run wizard can stack over an open Settings modal

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. Closes #1713. No area-ledger row
(filed standalone). Probe: with Settings open, flip `isAutoOpenFirstRun` true and assert Settings
closed before the wizard mounts.

## Problem

`src/client/App.svelte`:
- `:794` `const shouldShowWizard = $derived(manuallyReopened || isAutoOpenFirstRun);`
- `:2837` `SettingsModal` renders with `open={settingsModalOpen}`
- `:2874` `{#if shouldShowWizard}` renders `IntegrationWizardModal`

The `manuallyReopened` path is already safe: its setter (`:829-830`) sets
`settingsModalOpen = false` in the same handler. `isAutoOpenFirstRun` (`:789`) is `$derived` off
an async first-run fetch (`useFirstRunNeeded.svelte.ts`) and can flip `true` at any moment,
including while Settings is open — nothing clears `settingsModalOpen` when it does. Result: two
`aria-modal="true"` dialogs simultaneously mounted, the wizard on top, Settings still in the DOM
underneath with its own focus trap and Escape handler still armed.

This is the SAME shape as the escape-owner-competition sub-fix in K-client-1824 (a second modal
opening without closing the one already up) — fixed here with the identical pattern for
consistency, one commit each, same branch.

Verified unchanged on current master (`isAutoOpenFirstRun`/`shouldShowWizard`/`settingsModalOpen`
line numbers may have drifted since the issue was filed; re-grep at implementation time rather than
trusting the cited line numbers verbatim).

Explicitly NOT in scope, per the issue's own investigation: the shared `cowork-enable-confirm-btn`
testid between `CoworkSettings.svelte` and `IntegrationWizardModal.svelte` is a deliberate reuse
(`docs/design-system-impl/testid-manifest.md:270`), pinned by two NEGATIVE assertions in
`tests/client/integration-wizard-cowork.test.ts` (`:245`, `:309-312` — the `:309` case is the
#1298 double-click-fires-the-real-enable regression guard). Do not rename it.

## Fix

`src/client/App.svelte`: add an `$effect` that closes Settings when the wizard is about to show,
symmetric with what `:829-830` already does for the manual-reopen path:

```ts
$effect(() => {
  if (shouldShowWizard) settingsModalOpen = false;
});
```

Placed alongside the existing `manuallyReopened` handler's own state-clearing, after
`shouldShowWizard` is declared. This covers both triggers of `shouldShowWizard` (manual reopen
already self-clears via its own setter, so this effect is a no-op there; the async
`isAutoOpenFirstRun` transition is the one it actually closes for) with one small addition, rather
than threading a guard into `useFirstRunNeeded` or gating the wizard's own mount condition on
`!settingsModalOpen` (which would silently SKIP the auto-open instead of sequencing it — the user
would then never see the wizard once Settings is finally closed, since the fetch that flips
`isAutoOpenFirstRun` doesn't refire).

## Tests

New test in `tests/client/` (co-mounted `App`-level or a scoped harness mounting both modals into
one container — the issue's own repro note: today's two vitest suites each mount into their own
container and query scoped to it, so neither covers co-mounting):

1. Mount with `settingsModalOpen = true`, then flip `isAutoOpenFirstRun` true (drive it via
   whatever `useFirstRunNeeded` test seam already exists, or a fake matching its return shape) —
   assert `settingsModalOpen` becomes `false` and the wizard's own root (`aria-modal` dialog) is
   the only `aria-modal="true"` element in the container. Kills a fix that adds the effect but
   never actually clears the state, or clears the wrong flag.
2. Regression guard: mount with Settings closed, open the wizard manually via the existing
   `manuallyReopened` path, assert Settings stays closed (unchanged behaviour) — pins that the new
   effect doesn't fight the existing manual-path setter.
3. Regression guard: `tests/client/integration-wizard-cowork.test.ts`'s existing negative
   `cowork-enable-confirm-btn` assertions (`:245`, `:309-312`) must still pass unmodified — this
   fix touches modal-open sequencing only, never the shared testid.

## Done when

Cases 1–3 pass; no change to `docs/design-system-impl/testid-manifest.md`'s recorded shared-name
reuse; `npm run typecheck` and `npm test` green; `npm run test:e2e` unaffected (no existing E2E
spec drives this specific race, per the issue's own repro note — this group's e2e run is the
regression net, not a new E2E spec, since a reliable repro needs the async fetch timing this issue
already found by source reading rather than needing browser automation to prove).

## Not in scope

Splitting or renaming `cowork-enable-confirm-btn` — this group does no work against #1727 (see
`K-client-1727.md`); that carve-out stays tracked in #1727 itself, un-consolidated and unsplit,
pending the transport redesign's 2026-11-15 revisit. Any change to the wizard's or Settings' own
internal state beyond the one new effect.
