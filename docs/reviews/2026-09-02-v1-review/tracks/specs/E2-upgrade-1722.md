# E2-upgrade — #1722 rail toggles are silent no-ops on a read-only settings blob (partial: the `updateSettings` boolean only)

Branch `fix/upgrade-and-downgrade-paths-annotation-envelope-compatibility-and-settings-that-go-silently-inert-1791`. **Refs #1722 — this PR must NOT close it.** Ledger: the wave-8 row in `docs/plans/2026-09-06-open-issues-sweep.md:461` scopes this group to "#1722's `updateSettings` boolean, once"; the wave-9 row at `:470` assigns the rest to **G6 rail seam**. No probe — the condition is source-confirmed and the issue's own reviewer battery could not reach it.

## Problem

`updateSettings` (`src/client/hooks/useTandemSettings.svelte.ts:92`) opens with `if (settings._readOnly) return;` and returns `void`. `toggleLeft`/`toggleRight` (`src/client/layout/model.svelte.ts:166,173,176`) route through it and also return `void`, so neither the model nor `App.svelte` can distinguish a refused write from an applied one. The rail does not move, nothing is said, and `App.svelte` then calls `focusToggleTarget("right", nextVisible)` for an element that will never mount — so keyboard focus drops to `<body>` and the one warning that fires names focus, not the cause.

## Fix

**Exactly the piece #1792 item 1 already needs, and no more** — the full design, including the central refusal surface and the `App.svelte` wiring, is in `E2-upgrade-1792.md` under "Item 1". In summary: `updateSettings` returns `boolean`, and the `_readOnly` short-circuit invokes a module-level handler that `App.svelte` registers once against `notifications.push`. That makes the refusal legible everywhere at once, which is the half #1792 closes.

**Deliberately not done here:** consuming the boolean in `toggleLeft`/`toggleRight`, and skipping the `focusToggleTarget` call on a refusal. That is the rail seam, it is the same file as **#1719** and **#1716**, and doing it on this branch would collide with G6 in wave 9.

## Tests

Covered by `E2-upgrade-1792.md` test 1 (return value + handler-fired-once + handler-not-fired). No new rail-model spec here: `tests/client/layout-model.svelte.test.ts`'s `makeSettingsState` has no `_readOnly` path, and building that harness is G6's half of the work — adding it here without the consuming change would be a harness with nothing to discriminate.

## Done when

`updateSettings` returns `boolean`, the refusal reaches the user once per condition, and **#1722 appears under `## Refs` in the PR body, never `## Closes`** — it keeps at least two open carve-outs regardless of what lands here: the rail-seam half (G6) and **#1964** (Settings radiogroup `readOnly` getter + `aria-disabled` contract, filed out of K-client, currently OPEN).

## Not in scope

`toggleLeft`/`toggleRight` returning a boolean; the `focusToggleTarget` guard; a `_readOnly` axis in `tests/client/layout-model.svelte.test.ts`; #1964's radiogroup migration; #1719 and #1716.
