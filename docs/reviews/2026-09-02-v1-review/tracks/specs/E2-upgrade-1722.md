# E2-upgrade — #1722 rail toggles are silent no-ops on a read-only settings blob (partial: the `updateSettings` boolean only)

Branch `fix/upgrade-and-downgrade-paths-annotation-envelope-compatibility-and-settings-that-go-silently-inert-1791`. **Refs #1722 — this PR must NOT close it.** Ledger: the wave-8 row in `docs/plans/2026-09-06-open-issues-sweep.md:461` scopes this group to "#1722's `updateSettings` boolean, once"; the wave-9 row at `:470` assigns the rest to **G6 rail seam**. No probe — the condition is source-confirmed.

## Problem

`updateSettings` (`src/client/hooks/useTandemSettings.svelte.ts:92`) opens with `if (settings._readOnly) return;` and returns `void`. `toggleLeft`/`toggleRight` (`src/client/layout/model.svelte.ts:166,173,176`) route through it and also return `void`, so neither the model nor `App.svelte` can distinguish a refused write from an applied one. The rail does not move, nothing is said, and `App.svelte` then calls `focusToggleTarget("right", nextVisible)` for an element that will never mount — so keyboard focus drops to `<body>` and the one warning that fires names focus, not the cause.

## Fix

**Exactly the piece #1792 item 1 already needs, and no more.** The full design — the boolean return, the module-level `setSettingsWriteRefusedHandler`, the one-line `App.svelte` wiring beside `createNotifications()` (`:271`), and the `_resetTandemSettingsSingletonForTests()` reset of that handler — is in `E2-upgrade-1792.md` under "Item 1". In summary: `updateSettings` returns `boolean`, and the `_readOnly` short-circuit invokes a handler `App.svelte` registers once against `notifications.push` with `dedupKey: "settings-readonly"`. That makes the refusal legible at all eleven call sites at once.

**Deliberately not done here:** consuming the boolean in `toggleLeft`/`toggleRight`, and skipping the `focusToggleTarget` call on a refusal. That is the rail seam, it is the same file as **#1719** and **#1716**, and doing it on this branch would collide with G6 in wave 9.

## Tests

Covered by `E2-upgrade-1792.md` tests 1 and 2. Test 1 (return value + handler-fired-once + handler-not-fired) exercises the hook with a handler the test registers itself, so on its own it cannot tell a wired fix from an unwired one. **Test 2 is the discriminator this issue's Done-when depends on**: a source-contract assertion in `tests/client/settings-readonly-ui.test.ts` that `App.svelte` calls `setSettingsWriteRefusedHandler`. Without it, a fix that exports the setter and never calls it passes everything while the user still gets the silent no-op both issues describe.

No new rail-model spec here: `tests/client/layout-model.svelte.test.ts`'s `makeSettingsState` has no `_readOnly` path, and building that harness is G6's half — adding it here without the consuming change would be a harness with nothing to discriminate.

## Done when

`updateSettings` returns `boolean`, the refusal reaches the user once per condition **with test 2 pinning that it does**, and **#1722 appears under `## Refs` in the PR body, never `## Closes`** — it keeps at least two open carve-outs regardless of what lands here: the rail-seam half (G6) and **#1964** (Settings radiogroup `readOnly` getter + `aria-disabled` contract, filed out of K-client, verified OPEN on 2026-09-11).

## Not in scope

`toggleLeft`/`toggleRight` returning a boolean; the `focusToggleTarget` guard; a `_readOnly` axis in `tests/client/layout-model.svelte.test.ts`; #1964's radiogroup migration; #1719 and #1716.

## Review corrections (scope cut)

**Removed, not repaired**

- **The Settings-modal toast-suppression decision**, which this spec inherited by reference from `E2-upgrade-1792.md`. The mount/destroy handshake on the module-level handler was a mechanism neither issue asks for; the banner and a deduped tray entry co-existing is not a defect. Its removal takes the modal case out of test 2.

**Fixed directly (kept from round 1)**

- The `App.svelte` registration pin — without it this issue's entire user-facing half was unasserted — now in its cheapest form: a source-contract assertion rather than an `App.svelte` mount test.
- The `_resetTandemSettingsSingletonForTests()` handler reset stays named here, so the summary does not read as though the handler is stateless.
