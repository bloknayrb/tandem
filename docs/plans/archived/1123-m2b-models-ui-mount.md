# #1123 M2b — Models UI mount + per-provider gating (built dark)

**Status:** REVISED after 3-agent plan review (dark-guarantee / Svelte-reactivity / altitude). Agent feedback incorporated — see "Plan-review corrections (round 1)" below. Stacked on M2a (PR #1220, branch `feat/1123-m2-model-registry-server-authority`); this branch is `feat/1123-m2b-models-ui-mount`. Retarget the PR to master once M2a merges.

### Plan-review corrections (round 1 — applied before implementation)

- **§3.8 force-on seam was a CRITICAL client-crash risk — DROPPED (dark-guarantee + altitude converged).** The tsup `define` + `process.env` fallback is a *server/cli* pattern (the license gate is server+cli). `BYO_MODELS_ENABLED` is imported by 7 **client** files built by **vite**, and `vite.config.ts` has **no `define` block**; the client bundle has no `process` shim. So the copied mechanism would fold `__BYO_MODELS_ENABLED__=undefined` → evaluate `process.env` → **`ReferenceError: process is not defined`, white-screen crash on every client load** (a guaranteed dark regression, worse than "flag true"). It also trades away R2-F's "literal `const false`, not env/define-overridable" dark guarantee. **Resolution:** keep `BYO_MODELS_ENABLED` a literal `const false` (production is dark until M4 regardless — a runtime env-read buys nothing). Cover flag-ON logic by (a) **mounting `SettingsModelsTab` / `FirstRunModelPickerModal` directly** in vitest — neither has an internal flag gate, only their call-sites do — and (b) a targeted `vi.mock` of `shared/constants` **only** where a flag-ON *gate* assertion adds value (does SettingsModal show the tab? does App mount the picker?). E2E `settings-models.spec.ts` stays `test.skip(!BYO_MODELS_ENABLED)` and **auto-enables at the M4 flip** — so M4 gets full E2E for free; M2b's logic is fully covered at the component layer meanwhile. **No production flag change ships in M2b.**
- **§3.3 re-altituded — surface the outcome, don't read a shared flag (altitude).** `addModel` already does `const outcome = await writeThrough(...)` (`useModels.svelte.ts:406`) and discards it. Reading the reactive `_saveError` after an await is a fragile single-writer timing invariant and can't distinguish `reconciled` from `rolledback`. Instead: `addModel` returns `Promise<string | null>` (id on commit, `null` on non-commit), `updateModel` returns `Promise<boolean>` (committed?). The imperative branch-on-success flows (FirstRun, `handleSave`) key off the return; the declarative tab banner keeps the reactive `models.saveError` bind (fire-and-forget mutators). This also closes the tab's add/edit-path gap (a rolled-back save must not close the modal).
- **Sticky `saveError` needs a non-write clear (Svelte Q4).** `_saveError` clears only on a successful write today, so a stale tab banner can co-show with a fresh modal validation error. Add `clearError()` to the store; call it on modal-open and at mutation-start.
- **`setDefault` outcome guarded in FirstRun (Svelte Q2).** `setDefault` can itself roll back; don't call `onComplete()` blind — treat a `setDefault` failure as surfaced-but-non-fatal, or gate `onComplete` on it.
- **§3.7 carriers named (dark-guarantee + Svelte).** Removing the legacy UI also updates `tests/client/use-models.test.ts:426-429` (asserts both removed members), deletes the E2E block `settings-models.spec.ts:294-345`, and regenerates `tests/design-system-impl/__snapshots__/testid-set.snap.txt` (drop `models-legacy-migration-banner|-migrate-btn|-migration-status`).
- **§3.5 is a real state-machine change, not a drop-in mount (altitude).** Inserting an optional/skippable picker between wizard-dismiss and tutorial-show is a new gate that must let the tutorial through on skip. Its own commit; ordering §3.3 → §3.5 (don't mount a picker that finishes onboarding on a rolled-back add).
- **Round-4 (M2a) superseded the "M4-offline reconcile deadlock surfaces blocked state" follow-up** — the `finally`-settle in `initializeStore` dissolved the deadlock, so there is no blocked state to surface. Not carried into M2b.
- **Sequencing:** §3.1 (loading/reload) before §3.2/§3.4 (consume it); §3.3 before §3.5; §3.7 (pure deletion) as its own commit; testid-registry edits (§3.2 rebind, §3.7 removal) landed together to avoid collision.

**Issue:** #1123 (local-model collaborator), phase **M2b**. ADR-039 canonical. Builds on M2a (client registry read/write-authority relocated to the server store). Ships **DARK** (`BYO_MODELS_ENABLED=false`) — every change adds a flag-ON branch **without changing any flag-OFF behavior**. The flag flips at **M4** (v1.0). M2b's deliverable: when M4 flips the flag, a complete, tested Models UI lights up.

---

## 0. The one-line goal

M2a made the server the registry authority but left the UI unmounted (Settings Models tab filtered out, first-run picker never rendered, wizard shows "coming soon", chip forced null). M2b **mounts and wires** that UI behind the flag, closes the two M2b-BLOCKING gaps the M2a PR review surfaced, and adds a force-on test seam so the flag-ON paths are actually exercised.

## 1. Dark guarantee (the load-bearing constraint — every commit)

With `BYO_MODELS_ENABLED=false`, the app must stay **byte-identical to M2a**:
- No Settings Models tab (`SettingsModal.svelte:181-184` filter keeps stripping it).
- No titlebar chip (`App.svelte:1856` keeps forcing `defaultModelLabel={… : null}`).
- `FirstRunModelPickerModal` never mounts (new mount site gated on the flag).
- The wizard renders the `{#if !BYO_MODELS_ENABLED}` "coming soon" row; the new `{:else}` never renders.
- No `GET /api/models` fetch, no store `loading` transition (store stays inert; `loadFromServer` is flag-gated).

Verification per commit: `check:tokens` + `typecheck` + `svelte-check` clean; the existing M2a dark tests stay green; a grep-level confirmation that every new branch is behind `BYO_MODELS_ENABLED` (directly, or inside a component that only mounts when the flag is on).

## 2. Anchors (verified on this branch head via the surface map)

- `src/shared/constants.ts:18` — `BYO_MODELS_ENABLED = false` (currently a literal const).
- `src/client/components/SettingsModal.svelte:155-162` (Models tab entry), `:181-184` (flag filter).
- `src/client/components/settings-tabs/SettingsModelsTab.svelte` — `createModels()` at :19; local `saveError` :52 (set only in `handleSave` catch :91); `deleteModel` :97 / `setDefault` :202 / `toggleEnabled` :215 have **no error path**; legacy banner :117-147 (`{#if models.hasLegacyKeys}`); no loading skeleton.
- `src/client/components/FirstRunModelPickerModal.svelte` — unmounted (doc-comment :2-11); `handleSave` :97-120 calls `setDefault(id)` + `onComplete()` **unconditionally** after `addModel`.
- `src/client/App.svelte:257` (`modelsStore`), `:655-660` (`defaultModelLabel` derived), `:666-669` (`openModelsSettings`), `:1856` (chip null-gate), first-run render block ~`:2221-2245` (`shouldShowWizard` primary, tutorial behind).
- `src/client/components/IntegrationWizardModal.svelte:873-880` — `{#if !BYO_MODELS_ENABLED}` coming-soon row (no `{:else}` yet).
- `tests/e2e/settings-models.spec.ts:93-100` — `test.skip(!BYO_MODELS_ENABLED, …)` in `beforeEach`.

## 3. Changes

### 3.1 Store: re-add `loading` + `reload` (the skeleton's data source) — `useModels.svelte.ts`

- Add `let _loading = $state(false)`; expose `readonly loading` on `ModelsState`. `loadFromServer` sets `_loading = true` before `fetchAndApply` and `false` in its `finally`. **Dark-safe:** `loadFromServer` early-returns while dark → `_loading` never leaves its `false` initial; nothing reads it while dark.
- Add `reload(): Promise<void>` = clear `_loadInFlight`, then `loadFromServer()` (a user-triggered refetch after a 409 "changed elsewhere" notice). Flag-gated via `loadFromServer`.
- These re-add the surface M2a deliberately deleted (dead-while-dark); now they have a consumer (the skeleton + a reload affordance).

### 3.2 Close M2b-BLOCKING gap #1 — write-failure surfacing (`SettingsModelsTab.svelte`)

Root problem (from the M2a silent-failure review): the store's write-through **rolls back and sets the reactive `_saveError` but does not throw**, so the tab's `try/catch` never fires for a rollback, and three mutators (`deleteModel`/`setDefault`/`toggleEnabled`) have no error path at all.

Fix — a **declarative/imperative split**:
- **Declarative (fire-and-forget mutators):** the tab-level error banner (testid `models-save-error`) binds `models.saveError` (the store's `$state`). Because it is reactive, a rollback from `setDefault`/`toggleEnabled`/`deleteModel` surfaces automatically with no "forget to check" risk.
- **Imperative (branch-on-success):** `handleSave`'s add/edit path must not close the modal on a rolled-back write. `writeThrough` doesn't throw on rollback, so the `try/catch` alone misses it — instead key off the return: `addModel → Promise<string | null>` (null = didn't commit), `updateModel → Promise<boolean>`. `handleSave` closes the modal only on a truthy/non-null return; otherwise it leaves the modal open and the store banner shows the error. (See §3.3 for the store-side signature change.)
- **Pre-write validation** (the `assertValidPatch` / `storeSecret` throws inside `handleSave` — the latter a real keychain-unavailable case) is caught by `handleSave`'s `catch` and shown **inside `ModelEditModal`** via a new `error` prop (small component change), not the tab banner. With per-provider gating (§3.4) the provider is always valid, so in practice this surfaces only keychain-unavailable.
- **Sticky-error clear:** add `clearError()` to the store (sets `_saveError = null`); call it on modal-open and at mutation-start so a stale tab banner can't co-show with a fresh modal error.
- After the 409-reconcile outcome (`saveError === "Model registry changed elsewhere; reloaded."`), the banner offers a `reload` affordance (§3.1) — the state was already adopted, so this is informational + optional refresh.

### 3.3 Close M2b-BLOCKING gap #2 — FirstRun rolled-back default (`FirstRunModelPickerModal.svelte`)

`addModel` returns an id even on a rolled-back write, so the current `setDefault(id)` + `onComplete()` run even when the add didn't land — pointing `defaultModelId` at a non-existent entry and finishing onboarding as if configured.

Fix — surface the authoritative outcome the store already computes (it does `const outcome = await writeThrough(...)` at `useModels.svelte.ts:406` and currently discards it). Change the store signature: `addModel(...) → Promise<string | null>` (the id on `committed`, `null` on `reconciled`/`rolledback`). FirstRun then branches on the return, not a shared reactive flag:
```
const id = await models.addModel(...);
if (id === null) return;              // didn't commit — modal stays open, models.saveError shows why
const ok = await models.setDefault(id);
onComplete();                          // completes even if setDefault rolled back (non-fatal; error surfaced)
```
This is robust without depending on the single-writer timing of a shared `_saveError` read, and distinguishes commit from non-commit precisely (a shared-flag read can't tell `reconciled` from `rolledback`). `setDefault` returns `Promise<boolean>` too so its rollback is *surfaced* (banner) but treated as non-fatal for onboarding (the model was added; a failed default is a minor follow-up). Surface `models.saveError` in the picker (testid `first-run-error` already exists). Two call sites touch the new `addModel` return (FirstRun uses it; `SettingsModelsTab.handleSave` gains the null-guard from §3.2); the M2a store tests asserting `typeof id === "string"` still pass on the commit path and the rollback tests assert on `models.models`, not the return.

### 3.4 Per-provider gating (`SettingsModelsTab.svelte` + the add/edit modal)

v1.0 ships **local providers only**; cloud BYO keys are v1.1 (`contract.ts` `LOCAL_MODEL_PROVIDERS` comment). Using `isLocalProvider` from the shared contract:
- The provider picker in the add/edit modal renders local providers enabled and cloud providers **disabled** with a "coming in a future release" note.
- If a registry somehow contains a cloud row (hand-edited `models.json`), render it read-only/disabled rather than hiding it (no silent disappearance).
- **Dark-safe:** the tab only mounts when the flag is on.

### 3.5 Mount `FirstRunModelPickerModal` in the first-run choreography (`App.svelte`)

- Add a render site in the first-run block, gated `BYO_MODELS_ENABLED && <firstRunModelStep>` — while dark it never mounts (byte-identical). Wire `onComplete`/`handleSkip` to advance first-run state.
- **Choreography:** the model picker is an **optional** post-wizard step (the integration wizard stays primary; the picker sequences after it and before the tutorial, mirroring the existing `shouldShowWizard` gating). It is skippable (`first-run-skip`). Final copy/ordering polish is M4-owned (`TODO(M4)`); M2b's job is a correct, store-wired mount that the flag flip lights up.
- Reuse the existing first-run state machine rather than adding a parallel one; if a dedicated `showModelPicker` boolean is needed, derive it from the same server "first-run needed" signal the wizard/tutorial use.

### 3.6 Wizard enabled `{:else}` branch (`IntegrationWizardModal.svelte:873-880`)

Add the `{:else}` to the existing `{#if !BYO_MODELS_ENABLED}`: an **enabled** "Set up a local AI model" row that closes the wizard and opens the Models settings path (reuse `App.svelte`'s `openModelsSettings` via a wizard callback prop, or emit an event the App handles). While dark the `{#if}` (coming-soon) still renders; the `{:else}` only renders when lit.

### 3.7 Remove the dead legacy-key UI (`SettingsModelsTab.svelte` + store)

`hasLegacyKeys` can never be true off a `.strict()` server store (it never carries `_legacyApiKey`), so the `{#if models.hasLegacyKeys}` banner (`:117-147`) is dead. Remove, updating every carrier:
- the banner + `runLegacyMigration` handler in `SettingsModelsTab.svelte`;
- the `migrateLegacyKeys`/`hasLegacyKeys` members from `ModelsState` + the facade in `useModels.svelte.ts`;
- `tests/client/use-models.test.ts:426-429` (asserts both removed members — would fail the client project);
- the E2E block `tests/e2e/settings-models.spec.ts:294-345`;
- `tests/design-system-impl/__snapshots__/testid-set.snap.txt` — drop `models-legacy-migration-banner` / `models-legacy-migrate-btn` / `models-legacy-migration-status` and regenerate;
- the same three testids from the CLAUDE.md registry.

(Legacy plaintext in localStorage is dropped by the reconcile's `projectEntry` — R2-D, already documented; there is no live migration path to preserve.)

### 3.8 Flag-ON test coverage — NO production flag change (revised)

The original "make `BYO_MODELS_ENABLED` env/define-overridable, mirroring the license gate" is **dropped** — it was a server/cli pattern that crashes the vite-built client bundle (see the round-1 corrections). `BYO_MODELS_ENABLED` stays a literal `const false`; nothing about the shipped dark behavior changes. Coverage for the new flag-ON paths comes from the test structure, not a runtime seam:
- **Component logic (the bulk of M2b):** mount `SettingsModelsTab` and `FirstRunModelPickerModal` **directly** in vitest. Neither component has an internal `BYO_MODELS_ENABLED` gate — only their call-sites (`SettingsModal` filter, App first-run block) do — so a direct mount renders the full flag-ON UI. This covers per-provider gating, the reactive `saveError` bind, `clearError`, the loading skeleton, and the FirstRun add→setDefault→onComplete guard.
- **Gate wiring (thin):** a targeted `vi.mock("shared/constants", …, { BYO_MODELS_ENABLED: true })` in a dedicated test file for the one-line gates worth asserting (SettingsModal includes the Models tab; App mounts the picker; the store's `loading` toggles in `loadFromServer`). Isolated to those files; production untouched.
- **E2E:** `settings-models.spec.ts` stays `test.skip(!BYO_MODELS_ENABLED)` and **auto-enables at the M4 flip** — M4 inherits the full browser suite for free.

No `tsup.config.ts` / `vite.config.ts` change; no boot warning needed; R2-F's "literal const, not overridable" dark guarantee is preserved intact.

## 4. Testing

- **Store:** `loading` toggles across a load (flag-on seam); `reload` refetches; dark → `loading` stays false + no fetch.
- **SettingsModelsTab (flag-on seam):** a rolled-back `deleteModel`/`setDefault`/`toggleEnabled` surfaces `models.saveError` in the banner; a committed one clears it; per-provider gating (local enabled, cloud disabled + note); loading skeleton → list; legacy banner is gone.
- **FirstRunModelPickerModal (flag-on seam):** a rolled-back add does NOT `setDefault`/`onComplete` (modal stays open, error shown); a committed add advances; skip advances with no write.
- **App:** with the seam on, the chip renders `defaultModelLabel`; dark → null (unchanged).
- **Wizard:** dark → coming-soon row; seam-on → enabled row opens Models settings.
- **Dark regression:** every M2a dark test stays green; a test asserts `BYO_MODELS_ENABLED` (shipped default) is `false`.
- Full suite green; typecheck + `svelte-check` + `check:tokens` clean.

## 5. Decisions to settle in review

1. **Force-on seam (§3.8)** — is the define+env mirror of the license gate the right mechanism, and is the boot-warning + shipped-default-false test sufficient to protect the dark guarantee? (Highest stakes.)
2. **saveError unification (§3.2)** — binding the tab banner to the store's reactive `saveError` vs threading `WriteOutcome` out of every mutator. (Recommend the reactive bind — no API churn.)
3. **First-run choreography (§3.5)** — model picker as an optional post-wizard step, skippable, final copy deferred to M4. Acceptable, or does M2b need the full ordering now?
4. **Legacy-UI removal (§3.7)** — remove in M2b as one unit (dead code) vs keep the no-ops one more phase.
5. **Cloud rows (§3.4)** — disabled "coming soon" vs omitted entirely at M4.

## 6. Out of scope (M3 / M4)

- **M3** — provider-keyed authorship (`author` beyond `"claude"`, authorship color, channel + Solo/Tandem for a non-Claude agent). M2b's mount is the seam M3 extends.
- **M4** — flip `BYO_MODELS_ENABLED`; chat-target selection; typing presence; tutorial/user-guide copy; chip `loading`-gate; E2E vs a stub OpenAI-compatible server; final first-run choreography copy.
- **Later cleanup** — drop `models`/`defaultModelId` from `TandemSettings` once the reconcile is field-proven.
