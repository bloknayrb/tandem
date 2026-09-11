# K-client — #1713 First-run wizard can stack over an open Settings modal

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. Closes #1713. Probe: with Settings
open, flip `isAutoOpenFirstRun` true and assert Settings closed before the wizard mounts.

## Problem

`src/client/App.svelte` (re-grep at implementation time; line numbers drift):
- `shouldShowWizard = $derived(manuallyReopened || isAutoOpenFirstRun)`.
- `SettingsModal` renders with `open={settingsModalOpen}`; `IntegrationWizardModal` renders under
  `{#if shouldShowWizard}`.

The `manuallyReopened` path already self-clears `settingsModalOpen` in its own listener.
`isAutoOpenFirstRun` is `$derived` off an async first-run fetch and can flip `true` at any
moment, including while Settings is open — nothing clears `settingsModalOpen` when it does. Two
`aria-modal="true"` dialogs end up mounted, the wizard on top, Settings still in the DOM
underneath with its own focus trap and Escape handler armed. Same shape as #1824 item I.

## Fix

`src/client/App.svelte`: add an `$effect`, placed after `shouldShowWizard` is declared, reading
only `shouldShowWizard` (never `settingsModalOpen` — no self-dependency risk):

```ts
$effect(() => {
  if (shouldShowWizard) settingsModalOpen = false;
});
```

This is a no-op on the already-safe `manuallyReopened` trigger and closes Settings for the
`isAutoOpenFirstRun` trigger. Gating the wizard's own mount on `!settingsModalOpen` instead was
rejected: it would silently *skip* the auto-open rather than sequence it, and the fetch that
flips `isAutoOpenFirstRun` doesn't refire once Settings closes.

**Scope, stated explicitly:** one-directional only. `openModelsSettings` /
`openSettingsModalWithAck` remain unguarded against `shouldShowWizard` — Settings can still open
on top of an already-open wizard (the wizard's own "Set up models" hand-off), which is an
existing, intentional flow, not this race. There is one paint where both dialogs coexist before
the effect runs (it runs after the DOM update) — accepted; no other modal-sequencing code in
this file uses `$effect.pre`, and the gap isn't observable by any test here.

## Tests

No test in the repo mounts `App.svelte` — every reference under `tests/client/` is a
source-text scan (e.g. `tests/client/app-action-mount-contract.test.ts`, whose own docblock
argues exactly this: an App-level composition fact with no runtime signature short of mounting
the whole app). A scoped harness re-mounting just the two modals would pass whether or not the
real effect exists, so it can't discriminate the fix.

1. New `describe` in `tests/client/app-action-mount-contract.test.ts`, same
   `readFileSync(APP_SVELTE, "utf-8")` + regex idiom already used there: assert a
   whitespace-tolerant match for
   `$effect(() => { if (shouldShowWizard) settingsModalOpen = false; });` at the top level of the
   instance script, textually after `const shouldShowWizard = $derived(...)`.
2. Mutation test: delete the effect, confirm test 1 goes red, restore from a file copy.
3. Regression guard: `tests/client/integration-wizard-cowork.test.ts`'s existing
   `cowork-enable-confirm-btn` assertions pass unmodified (this fix touches sequencing only).

This group's `npm run test:e2e` run is the behavioral smoke net (this is an e2e group); no new
deterministic Playwright spec — reproducing needs driving the async fetch's timing, which this
issue's own investigation established by source reading.

## Done when

Cases 1–3 pass; `npm run typecheck` + `npm test` green; `npm run test:e2e` unaffected.

## Not in scope

Splitting/renaming `cowork-enable-confirm-btn` (see `K-client-1727.md`; #1727 stays Refs-only).
Guarding the reverse direction (Settings over an open wizard). Closing the one-frame overlap.

## Review corrections (scope cut)

No blocking findings remain — the test approach already uses the structural source-text
assertion (a co-mounted or scoped harness would pass with or without the real fix, since it
re-implements the sequencing rather than exercising it). Condensed the prior round's line-number
correction history and the `$effect.pre` rejection rationale into single stated facts rather
than "originally X, corrected to Y" narration. No mechanism removed.
