# K-client — #1713 First-run wizard can stack over an open Settings modal

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. Closes #1713. No area-ledger row
(filed standalone). Probe: with Settings open, flip `isAutoOpenFirstRun` true and assert Settings
closed before the wizard mounts.

## Problem

`src/client/App.svelte` (re-grepped at spec-revision time — line numbers drift; re-grep again at
implementation time rather than trusting any of these verbatim):
- `:730` `const shouldShowWizard = $derived(manuallyReopened || isAutoOpenFirstRun);`
- `:2536` `SettingsModal` renders with `open={settingsModalOpen}`
- `:2573` `{#if shouldShowWizard}` renders `IntegrationWizardModal`

The `manuallyReopened` path is already safe: its setter (`:765-766`, the
`"tandem:open-integration-wizard"` listener) sets `settingsModalOpen = false` in the same handler.
`isAutoOpenFirstRun` (`:725-729`) is `$derived` off an async first-run fetch
(`useFirstRunNeeded.svelte.ts`) and can flip `true` at any moment, including while Settings is
open — nothing clears `settingsModalOpen` when it does. Result: two `aria-modal="true"` dialogs
simultaneously mounted, the wizard on top, Settings still in the DOM underneath with its own focus
trap and Escape handler still armed.

This is the SAME shape as the escape-owner-competition sub-fix in K-client-1824 item I (a second
modal opening without closing the one already up) — fixed here with the identical pattern for
consistency, one commit each, same branch.

## Fix

`src/client/App.svelte`: add an `$effect` that closes Settings when the wizard is about to show,
symmetric with what the manual-reopen listener already does:

```ts
$effect(() => {
  if (shouldShowWizard) settingsModalOpen = false;
});
```

Placed alongside the existing `manuallyReopened` handler's own state-clearing, after
`shouldShowWizard` is declared. This effect reads only `shouldShowWizard` — it never reads
`settingsModalOpen`, so unlike K-client-1824's item G it has no self-dependency risk. It covers
both triggers of `shouldShowWizard` (manual reopen already self-clears via its own listener, so
this effect is a no-op there; the async `isAutoOpenFirstRun` transition is the one it actually
closes for) with one small addition, rather than threading a guard into `useFirstRunNeeded` or
gating the wizard's own mount condition on `!settingsModalOpen` (which would silently SKIP the
auto-open instead of sequencing it — the user would then never see the wizard once Settings is
finally closed, since the fetch that flips `isAutoOpenFirstRun` doesn't refire).

**Scope, stated explicitly:** this fix is one-directional — it closes Settings when the wizard is
about to show. It does NOT guard the reverse: `openModelsSettings` (called both directly and as
`onSetupModels` from inside an open wizard, `:2577`) and `openSettingsModalWithAck` remain
unguarded against `shouldShowWizard`, so Settings can still open on top of an already-open wizard
(e.g. clicking "Set up models" from inside the wizard). That reverse path is an existing,
apparently-intentional product flow (the wizard hands off into Settings' Models tab) and is
**out of scope** for this fix, which targets only the auto-open-over-Settings race #1713 reports.

Also stated explicitly: because `$effect` runs after the DOM update for the render that mounts the
wizard, there is one paint where both `SettingsModal` and `IntegrationWizardModal` are present in
the DOM before the effect clears `settingsModalOpen`. This is accepted as a one-frame trade-off
(switching to `$effect.pre` to close the gap is not pursued here — it would run before the DOM
update rather than after, and neither this codebase's other modal-sequencing code nor the
`manuallyReopened` precedent uses `.pre`, so it would be an isolated pattern for a one-frame
paint no test can observe): the fix's job is that Settings does not stay open, not that the two
dialogs never coexist for a single paint.

## Tests

**Round-1 review correction:** no test in the repo mounts `App.svelte` — every reference to it
under `tests/client/` is a source-text scan (e.g. `tests/client/app-action-mount-contract.test.ts`,
`tests/client/tandem-mode-wiring.test.ts:130`), and this codebase's established pattern for an
App-level composition fact with no runtime signature short of mounting the whole app *is* exactly
that kind of structural source-text assertion (see `app-action-mount-contract.test.ts`'s own
docblock: "The invariant is a composition fact... and it has no runtime signature short of
mounting the whole App"). A scoped harness that mounts only the two modal components into one
container would pass whether or not the `$effect` exists in `App.svelte` — it re-implements the
sequencing itself rather than exercising the real wiring, so it cannot discriminate the fix from
its absence. Dropped in favor of the structural check below.

1. New `describe` block in `tests/client/app-action-mount-contract.test.ts` (same file, same
   `readFileSync(APP_SVELTE, "utf-8")` + regex-match idiom already used there for the
   `mountActionExecutor`/`onDestroy` pairing): assert that a statement matching
   `/\$effect\(\s*\(\)\s*=>\s*\{\s*if\s*\(shouldShowWizard\)\s*settingsModalOpen\s*=\s*false;?\s*\}\s*\);/`
   (whitespace-tolerant) appears at the top level of the instance script, textually after the
   `const shouldShowWizard = $derived(...)` declaration. Kills a fix that never adds the effect,
   adds it in the wrong scope (nested inside a function/`{#if}`), or clears the wrong flag.
2. Mutation test (wave-5-lesson rule): delete the effect from `App.svelte`, confirm test 1 goes
   red, restore from a file copy.
3. Regression guard: `tests/client/integration-wizard-cowork.test.ts`'s existing negative
   `cowork-enable-confirm-btn` assertions (re-grep for current line numbers at implementation
   time) must still pass unmodified — this fix touches modal-open sequencing only, never the
   shared testid.

Behavioral confirmation beyond the structural check is this group's `npm run test:e2e` run (this
is an e2e group) as a smoke net, not a new deterministic Playwright spec — a reliable repro needs
driving the async `useFirstRunNeeded` fetch's timing while Settings is manually held open, which
this issue's own investigation found by source reading rather than needing browser automation to
prove.

## Done when

Cases 1–3 pass; no change to `docs/design-system-impl/testid-manifest.md`'s recorded shared-name
reuse; `npm run typecheck` and `npm test` green; `npm run test:e2e` unaffected (no existing E2E
spec drives this specific race — this group's e2e run is the regression net, not a new E2E spec).

## Not in scope

Splitting or renaming `cowork-enable-confirm-btn` — this group does no work against #1727 (see
`K-client-1727.md`); that carve-out stays tracked in #1727 itself, un-consolidated and unsplit,
pending the transport redesign's 2026-11-15 revisit. Guarding the reverse direction (Settings
opening over an already-open wizard via `openModelsSettings`/`openSettingsModalWithAck`) — see
"Fix" above; that is an existing, apparently-intentional handoff flow, not the race this issue
reports. Closing the one-frame two-dialog paint window (see "Fix" above). Any change to the
wizard's or Settings' own internal state beyond the one new effect.

## Review corrections (round 1)

**Adopted:**
- Replaced the "co-mounted App-level or a scoped harness" test option with a structural
  source-text assertion against `App.svelte`, matching this codebase's own established pattern
  (`app-action-mount-contract.test.ts`) for a composition fact with no runtime signature short of
  mounting the whole app. The scoped-harness fallback the original spec offered would pass whether
  or not the fix landed, since it reimplements the sequencing in the test rather than exercising
  the real effect.
- Re-grepped and corrected every cited `App.svelte` line number (the spec's originals — `:794`,
  `:2837`, `:2874`, `:829-830`, `:789` — had drifted to `:730`, `:2536`, `:2573`, `:765-766`,
  `:725-729` on current master) and added an explicit note to re-grep again at implementation
  time, since master moves fast in this repo.
- Added explicit scope notes for the one-frame two-dialog overlap (`$effect` runs after the DOM
  update) and the unguarded reverse direction (Settings opening over the wizard via
  `openModelsSettings`), rather than leaving both implied-fixed by silence.
- Narrowed "Done when"'s framing to match: this fix guarantees Settings closes once the wizard is
  showing, not that the two dialogs never coexist for any instant.

**Not adopted:**
- Switching the effect to `$effect.pre` to close the one-frame overlap — no other modal-sequencing
  code in this file uses `.pre`, and the gap it would close is not observable by any test in this
  spec; introducing an isolated pattern for an unmeasurable win isn't worth it here. Recorded as a
  known, accepted trade-off instead.
