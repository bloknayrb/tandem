# E2-upgrade — #1792 upgrade/downgrade UX: inert settings controls, a swallowed integrations error, and a stamp written before the open

Branch `fix/upgrade-and-downgrade-paths-annotation-envelope-compatibility-and-settings-that-go-silently-inert-1791`. **Refs #1792 — this PR must NOT close it**: item 3's premise is refuted by measurement and left open for Bryan (below). Ledger: `docs/reviews/2026-09-02-v1-review/areas/upgrade-path.md:21` (items 1-3) and `:22` (item 4).

**Citations re-read on this branch** (lesson 4): `sendInternal` is `src/server/integrations/api-routes.ts:1199`, not `src/server/mcp/api-routes.ts` — that file is claimed by no launched group, so the edit is safe. `copy_sample_files` is `src-tauri/src/lib.rs:2078` with its gate at `:2120`, not `:1942, :1985` (#1968 rewrote `lib.rs`). The transport branch is `src/server/index.ts:655`, not `:562`. `doctor` is `src/cli/doctor.ts`; there is no `src/server/doctor.ts`.

## Problem

1. **Every settings-backed control outside the modal is a silent no-op after a downgrade.** `useTandemSettings.svelte.ts:92` is `if (settings._readOnly) return;` — the #659 defence that stops a downgraded client clobbering a newer blob. It returns `void`, so none of the eleven `updateSettings(...)` call sites (`App.svelte:998,1016,2207,2293,2297,2314,2320,2584`; `layout/model.svelte.ts:166,173,176`) can tell refused from applied. Only `SettingsModal.svelte:814` renders `SettingsReadonlyBanner`. Extends #1722.
2. **The integrations future-schema error becomes `{"error":"INTERNAL"}`.** `integrations/storage.ts:104-106` throws a precise message; all seven `sendInternal` callers flatten it to a 500 "Internal server error", and `checkAnnotationStore` (`doctor.ts:2766`) has no `integrations.json` counterpart. **The two client surfaces render only the status code**, so a wire-only fix changes nothing the user sees: `SettingsClaudeCodeTab.svelte:100` sets `Failed to load integrations (HTTP ${res.status}).` and returns before any `res.json()`; `useIntegrationWizard.svelte.ts:242` does the same at its own error path.
3. **`welcome.md` is only ever copied when absent** — `copy_sample_files` gates each file on `if !dest.exists()` (`lib.rs:2120`), so a desktop upgrader keeps the release-N sample. **Premise refuted; see the measurement under Bryan.**
4. **The CHANGELOG stamp is written before the open is attempted.** `checkVersionChange` (`version-check.ts:31-34`) writes the version file *inside itself*, then `index.ts:692-697` attempts `openFromDisk(CHANGELOG.md)`. A failed open means that release's notes never open: the next start reads `current`. **The rest of item 4 is measured NOT live** — `CLAUDE.md:199` already states the `if (transportMode === "http")` bound explicitly ("do not read either as unconditional"), and the "outside every launcher branch" comment the issue attributes to `apply.ts` is at `index.ts:657` and says *launcher* branch, which is true. Only its line citation is stale.

## Fix

**Item 1 — `src/client/hooks/useTandemSettings.svelte.ts` + `App.svelte`.** `updateSettings` returns `boolean` (`false` on the `_readOnly` short-circuit, `true` otherwise) — that is #1722's half, done once, here. Surface it **centrally, not per call site**: a module-level `let onWriteRefused: (() => void) | null` plus `export function setSettingsWriteRefusedHandler(fn: (() => void) | null): void`, invoked from the short-circuit before returning `false`. `App.svelte` wires it once beside `const notifications = createNotifications();` (`:271`) to

```ts
notifications.push({
  id: crypto.randomUUID(),
  timestamp: Date.now(),
  type: "general-error",
  severity: "warning",
  message: "…",
  dedupKey: "settings-readonly",
});
```

— `push` takes a full `TandemNotification` (`useNotifications.svelte.ts:58`; `id`/`timestamp` required, `shared/types.ts:635-660`), so a four-field literal would not typecheck. One wiring line covers all eleven call sites, and `useNotifications`' dedup collapses repeated clicks into a count badge. Message in **past tense** and it must name the cause: settings were written by a newer version of Tandem, so this one will not change them. `_resetTandemSettingsSingletonForTests()` (`:120-123`) must also set `onWriteRefused = null` — it resets only `_instance` today, and without this test 1's "handler does not fire" arm is decided by test ordering.

**Do not** consume the boolean in `layout/model.svelte.ts` or skip `focusToggleTarget` — that is #1722's rail half and belongs to **G6** (wave 9, `#1719 #1716`). `createNotifications` is not a singleton, which is why the handler is a setter rather than an import.

**Item 2 — `integrations/storage.ts` + `integrations/api-routes.ts` + the two client surfaces + `src/cli/doctor.ts`.** Export `class IntegrationsFutureSchemaError extends Error` carrying `{ found: number; supported: number }`, thrown at `storage.ts:104`. Branch **inside `sendInternal` (`api-routes.ts:1199`)**, not at the seven call sites: `409`, `error: "CONFLICT"`, a stable `code`, and a message the response builds itself — `integrations.json was written by a newer Tandem (schemaVersion N; this build supports M). Update Tandem, or remove the integrations file.` **The thrown message's `${filePath}` must not reach the wire**: `GET /api/integrations/*` is LAN-reachable and CLAUDE.md's MCP/Server gotcha forbids resolved paths there; the path stays in the `console.error` line `sendInternal` already writes. Model: `sendKeychainError` (`:1211`), the same shape one layer out.

**The client half is required, not optional** — without it the user still sees a bare status code and test 3 passes anyway. At `SettingsClaudeCodeTab.svelte:100` and `useIntegrationWizard.svelte.ts:242`, on `!res.ok` parse the body inside a `try`/`catch`-and-ignore and render `body.message` when it is a non-empty string, falling back to the existing `(HTTP ${res.status})` string.

Then a `checkIntegrationsFile` recorder in `doctor.ts` beside `checkAnnotationStore` (`:2766`) — the counterpart the issue names: read `integrations.json`, `r.warn` when its `schemaVersion` exceeds `INTEGRATIONS_SCHEMA_VERSION` (`shared/integrations/contract.ts`), mirroring the `futureActive` warn at `:2859-2864` in wording and remediation.

**Item 4 — `src/server/version-check.ts` + `index.ts`.** `checkVersionChange(currentVersion, versionFilePath, opts?)` takes an optional `onUpgrade?: () => Promise<void>`: on `"upgraded"` it awaits the hook and stamps **only if it resolves**; on a rejection it logs and leaves the file unwritten, so the next start still reports `upgraded`. `"first-install"` stamps with no hook call. `index.ts:691-699` passes the `openFromDisk(CHANGELOG.md, { readOnly: true })` as that hook. **The hook shape is deliberate**: it keeps read and write in one function, so there is no second call for `index.ts` to forget — a split into `checkVersionChange` + `stampVersion` fails silently if the stamp call is dropped (every launch re-opens CHANGELOG read-only, forever) and would need its own wiring test. Also make `:695`'s "upgraded to vX" version-change-neutral — a *downgrade* correctly opens the running build's own CHANGELOG; only the word is wrong, no semver comparator. Finally, refresh `CLAUDE.md:199`'s stale `src/server/index.ts:591` citation to `:655` — **and touch nothing else in that file**, because PR #1979 is open against its security-findings bullet.

## Tests

1. `tests/client/` (beside `use-tandem-settings-migration.test.ts`): with `_readOnly: true`, `updateSettings({theme:"dark"})` returns `false`, localStorage is untouched, and the registered handler fired exactly once; without `_readOnly` it returns `true` and the handler does not fire. `beforeEach` calls `_resetTandemSettingsSingletonForTests()` (which now nulls the handler) before registering the spy.
2. `tests/client/settings-readonly-ui.test.ts`: a source-contract assertion that `App.svelte` calls `setSettingsWriteRefusedHandler`. Test 1 registers its own handler, so without this a fix that exports the setter and never wires it passes everything while the user still gets the silent no-op — the exact defect #1792 item 1 and #1722 describe.
3. `tests/server/integrations/`: a `schemaVersion`-too-new file makes `store.read()` reject with `IntegrationsFutureSchemaError`; driving that through `sendInternal` yields **409**, a `message` naming both numbers, and neither the absolute path **nor `path.dirname(filePath)`** — assert on both rather than "no substring of the path", which is unsatisfiable against a message that legitimately contains `integrations.json`. That is what kills the naive `message: err.message` fix.
4. Client half: a mocked `!res.ok` carrying `{ message }` renders a string containing both schema numbers at `SettingsClaudeCodeTab` and at `useIntegrationWizard`; a body with no `message` (or unparseable) falls back to `(HTTP 409)`.
5. `tests/cli/doctor.test.ts`: a future-schema `integrations.json` produces a warn row; a current one does not.
6. `tests/server/changelog-on-update.test.ts`: the six existing specs keep passing with no `onUpgrade` (stamp still written). Three new: hook resolves → stamp written; hook **rejects** → stamp NOT written and the next call still returns `upgraded`; `first-install` → stamp written, hook never called.
7. Mutation-test (lesson 5): revert the `onUpgrade` await, the `sendInternal` branch, the client body-parse, the `App.svelte` wiring and the boolean return in turn, and name the test that goes red for each. Restore from a file copy, never `git checkout`.

## Done when

Tests 1-6 green; `npm run typecheck` + `npm test` + `npm run test:e2e` green; `CLAUDE.md:199`'s line citation corrected with no other edit to that file. **No Rust change lands on this branch**, so no `cargo test` leg is load-bearing here.

## Bryan — item 3, premise refuted by measurement

Refreshing the bundled `welcome.md` on upgrade is **not** recommended, and item 3 is left unfixed. Four measurements, all taken on this branch:

- **No tutorial target string has ever changed.** `git log -S` over `sample/welcome.md` for each of the four `targetText` literals returns only `41a6c5e0`, the commit that introduced them — across four later edits to that file (`36341bf3`, `6d4a795a`, `b9aa278e`, `49adb4f8`). The failure mode the issue describes has not occurred.
- **An uncoordinated edit is already red in CI.** `tests/server/tutorial-annotations.test.ts:81` pins the live `sample/welcome.md` against every target in the flat-text coordinate system. Only a change that edits the sample and the def *together* ships green.
- **A byte refresh damages the population whose tutorial works today.** `injectTutorialAnnotations` is idempotent by **id**, not by target text (`tutorial-annotations.ts:63`, `if (map.has(def.id)) continue;`, stable id constants), so an upgrader who already opened the sample keeps the old records — anchored to the old on-disk text, which still matches. Rewriting the bytes moves the text out from under them: the envelope is keyed by `docHash(filePath)` and the path does not change, `loadAndMerge` re-inserts every record VERBATIM, and `reanchorAnnotations` has exactly three callers (`documents/open.ts:396` force-open, `reload-family.ts:174`, `watcher.ts:203`) — **none is the ordinary startup `openFromDisk(samplePath)` at `index.ts:720`**. Every annotation on that document, the tutorial `note` and any personal note the user added, would go stale.
- **The residual population is small**: desktop only (`index.ts:718` reads `TANDEM_DATA_DIR/sample/welcome.md`; an npm install reads the package copy), and only an upgrader who has *never* opened the sample, after a release that changes a target string.

The options, in cost order: (a) accept — a desktop upgrader who never opened the sample may miss one tutorial annotation after a target-string change that has never happened; (b) refresh bytes *and* add a re-anchor pass on the ordinary sample open plus a stale-snapshot re-seed in `injectTutorialAnnotations` — the design reviewed in round 1, roughly 150 lines across Rust and TS plus a marker file, a `.bak` policy and a three-leg `cargo test` evidence requirement; (c) drop the tutorial's dependence on exact target strings. #1792 stays open for this decision; nothing here forecloses any of the three.

## Not in scope

The rail-toggle boolean consumption and `focusToggleTarget` (#1722 rail half → G6, wave 9). The Settings radiogroup `readOnly` getter + `aria-disabled` migration (#1964, open). Moving the skill refresh or the startup opens out of `if (transportMode === "http")` — a behaviour change no issue asks for. A semver comparator in `version-check.ts`. Merging `smoke-lines.md` into `docs/release-smoke-checklist.md` — ledger-assigned, named by no issue, and it belongs in a docs PR.

## Review corrections (scope cut)

**Removed, not repaired**

- **Item 3 in its entirety** — `sync_sample_dir`, the `.tandem-sample-version` marker, the `.pre-<version>.bak` policy, the marker-on-full-success rule, five Rust unit tests, the `injectTutorialAnnotations` re-seed, `reanchorAnnotations` on the startup open, old test 7, and the three-leg `cargo test` evidence requirement. The measurement above shows the trigger has never fired, CI already catches the uncoordinated form, and the prescribed refresh degrades a strictly larger population than it helps. Removing it makes all four round-1 findings about tutorial re-anchoring, `map.has(def.id)` and stored-range staleness **moot**, and removes the only Rust change — which is also the honest answer to lesson 2 (a Windows-only local run cannot verify a cross-platform change).
- **The Settings-modal toast suppression** (mount/destroy handshake on the handler, plus its test case). The banner and a deduped `warning` tray entry co-existing is mild noise, not a defect either issue reports; the handshake is a mechanism with its own lifecycle bug surface.
- **The extracted `maybeOpenChangelogOnUpgrade({ check, stamp, open })` unit and its three-assertion wiring test.** The finding — nothing pins `index.ts` calling the new stamp — is **fixed directly and more cheaply** by never splitting the write out: the `onUpgrade` hook keeps read and write in one function, so there is no second call to forget. Test 6 still discriminates.
- **The `smoke-lines.md` merge.** Ledger-assigned, but named by no issue in this group.

**Fixed directly (kept from round 1)**

- The client half of item 2 (`SettingsClaudeCodeTab.svelte:100`, `useIntegrationWizard.svelte.ts:242` both render only `res.status`) — verified, kept, with test 4.
- The `App.svelte` registration pin, in its cheapest form (source-contract assertion, test 2).
- The `_resetTandemSettingsSingletonForTests()` handler reset, the typecheck-valid `notifications.push` literal, and the `path` + `path.dirname` scrub assertion.

## PR review, round 1 (fixed by hand after the workflow's fix agent hit the spend limit)

- **Item 1's toast id used `crypto.randomUUID()`** (cr-1, general-purpose-4) — secure-context-only, so over plain http to a LAN IP the handler threw before the toast and `updateSettings` never returned `false`. Now `generateNotificationId()`, pinned in `settings-readonly-ui.test.ts`'s source contract.
- **Item 2's doctor check was narrower than the server** (cr-3): `Number.isInteger` passed a `3.5` every integrations route refuses. It now mirrors `readSchemaVersion` + `>`.
- **Item 2's doctor check reported an unreadable file as absent** (cr-6, general-purpose-2). The server rethrows every errno but ENOENT, so EACCES/EISDIR kill the routes; doctor now warns with the code instead of "No integrations.json yet".
