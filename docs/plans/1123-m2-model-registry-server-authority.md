# #1123 M2 — Client read-authority relocation + Models UI unhide (server-authoritative registry)

**Status:** M2a IMPLEMENTED + reviewed (7 agents: 4 cleanup + Svelte/security/general-correctness). Round 1 found a **data-loss-grade flaw** and a **5×-underscoped reader graph**; round 2 bound R2-A…R2-G. The **implementation review corrected R2-F** (see below) — a genuine dark-guarantee hole — plus applied a keychain-ordering fix, a reconcile-gate altitude fix, and a LAN-ETag hardening. M2b/M3/M4 still to come.

### Implementation-review corrections (round 3 — applied in the M2a PR)

- **R2-F was WRONG — the real dark invariant is localStorage-while-dark, not "empty store → Assistant".** R2-F claimed `models=[]` is provable for every shipped build because `BYO_MODELS_ENABLED` gates all writers. But the flag **did not exist at v0.13.x** (first appears at v0.14.0=false; verified via `git show v0.13.0:src/shared/constants.ts`), and at v0.13.0 the Models tab shipped in the default tabs array + the first-run picker was mounted — so a real cohort configured cloud models into localStorage, and pre-M2 the label resolved from there ("GPT"/"Claude"). Reading the empty store while dark would silently regress their byline to "Assistant". **Fix:** `agentLabelSource()` reads localStorage settings while dark and the store only when lit; `useAgentLabel` + `annotation.ts` source from it. Regression-guarded by `tests/client/agent-label-dark.test.ts`.
- **Keychain terminal-only delete extended to `updateModel`/`deleteModel` (security Q4b).** They deleted the OLD ref eagerly before the write committed, so a rollback stranded the reverted entry against a missing secret. `writeThrough` now returns a `WriteOutcome` (`committed`/`reconciled`/`rolledback`) and all three mutators gate keychain deletes on it (also fixes the reconcile-adopt orphan the old `addModel` guard missed).
- **Reconcile gate hoisted to `initializeStore()` (altitude).** The "settle on success-or-skip, stay pending on failure" rule was re-encoded at ~5 reconcile early-returns reaching back into the store via `_settleReconcile`. `reconcileModelsToServerOnce()` now returns a `ReconcileOutcome`; `initializeStore` maps it to the gate in ONE place, removing the cross-module obligation + import direction.
- **LAN GET ETag hashed over the scrubbed file (security Q5).** The etag was hashed over the full cache even for LAN callers, acting as a weak change-detector for hidden fields. LAN now gets `hashModelsFile(scrubbedFile)`.
- **Deferred (noted):** dead `loading`/`reload` store surface removed (M2b re-adds with its skeleton); legacy-key no-ops kept until M2b removes the SettingsModelsTab banner as one unit; M4-offline reconcile deadlock surfaces the blocked state (follow-up).

**Issue:** #1123 (local-model collaborator), phase **M2**. ADR-039 canonical. Builds on M1a (PR #1219, merged) — which relocated the *resolver* to the server file but left the *client* reading/writing localStorage. Ships **DARK** (`BYO_MODELS_ENABLED=false`) through all of M2; runtime byte-identical to today. The flag flips in **M4**.

---

## Round-1 review — the four findings that reshaped this plan

1. **Data-loss (BLOCKER → fixed by not dropping).** The original "drop `models`/`defaultModelId` (v17→v18) + fold the seed into the migration" loses data on ≥3 paths. `loadSettings()` is synchronous and does not persist; the *durable* localStorage drop happens later on an unrelated `updateSettings()`, decoupled from the async seed POST — so a seed that fails **after** the durable drop is unrecoverable. Worse, it used the wrong signal: M1a relocated only the resolver, so the `tandem:models-migrated-to-server` flag means "seeded once", **not** "server current" — every model edited under an M1a build lives in localStorage *newer* than the stale server seed, and the "skip if already-seeded/non-empty" logic would silently drop those edits. **Fix: M2 does NOT drop the localStorage fields.** The registry stays in localStorage as vestigial dead weight (no readers, no writers) once every consumer is repointed to the server-backed store; the actual field-drop defers to a later cleanup version, *after* the reconcile is proven in the field.

2. **Reader graph 5× underscoped (BLOCKER → fixed by agentLabel rewire).** `settings.models`/`.defaultModelId` are read not just by App.svelte + the two Models components, but by `resolveAgentLabel` (`src/client/utils/agentLabel.ts`) via `useAgentLabel` in ~10 always-mounted components (StatusBar, SidePanel, ChatPanel, FilterBar, CommentThread, BatchPromoteBar, all AnnotationCard\* surfaces, Toolbar) **and** by a synchronous `loadSettings()` call inside a ProseMirror decoration builder (`annotation.ts:69-71`, rebuilt on every decoration pass, outside the Svelte tree). Consequence: the store needs a **synchronous snapshot accessor** (mirroring the server's `getCachedModelsFile()`), and `resolveAgentLabel`/`useAgentLabel` must be repointed to it — a real, scoped M2a task, not a compile-surprise mid-build.

3. **Concurrency: content-hash ETag, not a `revision` field.** A persisted `revision` bumps models-schema to v2; the store backs-up-and-empties any file whose version exceeds the running binary, so an M1a-binary downgrade silently discards a v2 registry (one-way cliff). An **ETag over the canonical serialized bytes** needs no schema change and no downgrade cliff. Still needs an in-process single-flight mutex around compare+write (TOCTOU), and the server owns the token (the client's `ifMatch` is a precondition, never persisted).

4. **Svelte + security fixes.** Facade fields are all **getters**; store holds deep `$state` + immutable array replacement; optimistic write precedes any `await`; `_loading` inits `false`; **allowlist** (not denylist) LAN scrub; 409 returns `{code, etag}` only (no file body); `ifMatch` travels as a **body field** (CORS blocks custom headers to the Tauri client); keychain **secret-before-registry** order kept, with best-effort ref-delete only on *terminal* (non-409) failure; strip `_legacyApiKey` from the write-through body; on final-retry failure the store **adopts the refetched server state** (never leaves optimistic state diverged).

---

## Round-2 review — binding resolutions (these override any conflicting prose below)

Two focused reviews (reconcile/data-loss, agentLabel) validated the revised shape and found one blocker + several refinements. Binding decisions:

**R2-A — Reconcile runs UN-GATED during M2-dark (not `BYO_MODELS_ENABLED`-gated).** The M1a seeder (`migrate-models-registry.ts`, `main.ts:16`) already POSTs localStorage→server while dark, un-gated — so my §7 "a boot POST while dark violates the dark guarantee" premise was **wrong**. Running `reconcileModelsToServerOnce()` un-gated at init (replacing the seeder) makes it complete while CRUD is **structurally impossible** (Models UI unmounted while dark), so "localStorage ≥ server" holds *by construction* and the flag is set before M4. This is not new dark behavior — it swaps one un-gated background POST for a better one. **Crucially: reconcile reads localStorage and POSTs to the server but does NOT touch the client store's `$state`.** The store's `loadFromServer()` stays `BYO_MODELS_ENABLED`-gated so `_models` stays `[]` while dark → `resolveAgentLabel` yields the byte-identical `"Assistant"` fallback (the dark guarantee). Server gets reconciled in the background (inert — only the BYO-gated resolver/GET read it); UI stays dark.

**R2-B — Mutators gate on reconcile SUCCESS (the blocker fix).** Every store mutator `await`s a module `_reconcileSettled` promise that resolves **only** on reconcile success-or-confirmed-skip and stays **unresolved on failure**. This closes the retry-after-failure clobber: at M4 a CRUD write cannot precede a successful reconcile, so localStorage is never CRUD-advanced before reconcile completes, so the boot-2 overwrite can never lose a boot-1 edit. Documented consequence: a *persistently* failing reconcile (offline through M2/M3 and still offline at M4) leaves the Models UI read-only until a boot where reconcile succeeds — consistent with `loadFromServer` also failing offline. Skip conditions that resolve `_reconcileSettled`: flag already set, localStorage registry empty, `_readOnly` client. On reconcile **409** (a concurrent window/origin won): re-GET, **adopt** the server, set the flag (convergent, not a lossy re-clobber).

**R2-C — Drop the "localStorage is definitionally ≥ server" claim.** It is true only at the first attempt and only because R2-A+R2-B keep CRUD from advancing localStorage first. The overwrite is safe by the *timing* R2-A/B enforce, not by a standing inequality.

**R2-D — "Vestigial (no writers)" is false; `localStorage.models` is re-persisted-frozen.** `updateSettings` rewrites the whole settings blob (incl. `models` via `mergeAndClampSettings`→`parseModels`) on every unrelated change (theme/font/panel). So `localStorage.models` stays *frozen at the load snapshot but re-persisted*. Binding invariant for the rewrite: **no mutator may route a model write through `updateSettings({models})`** — including `migrateLegacyKeys` (`useModels.svelte.ts:181`) — else localStorage diverges upward and a future reconcile pushes the divergent value. (Also: that re-persist runs `parseModels`, which strips `_legacyApiKey` — a pre-existing silent legacy-key drop while the migration UI is dark; note only.)

**R2-E — ETag determinism across a read cycle.** `persistModelsFile` must cache the **Zod-canonical** file (schema key order), and the store must serialize that same canonical form, so `GET`-after-POST and `GET`-after-restart (which goes `JSON.parse`→`safeParse`→schema order) produce the **same** etag — else the client's stored etag mismatches and 409s every first write post-restart. The §6 determinism test must exercise a real file **read cycle**, not re-serialize the in-memory object.

**R2-F — agentLabel dark-guarantee: the real invariant.** `resolveAgentLabel` with `models=[]` returns `FALLBACK_AGENT_LABEL = "Assistant"` (NOT "Claude" — §7's wording was wrong). Because `BYO_MODELS_ENABLED` is a **literal `const false`** (not env/define-overridable) and its only writers sit behind the filtered-out Models tab, `models=[]` is a **provable invariant for every shipped build** — the store's empty state and today's localStorage empty state are bit-identical. §7 states this invariant explicitly and scopes it to shipped builds (a local dev-flip that populates then un-flips is accepted, untested drift). There is **no force-on seam today** (the E2E suite `test.skip`s wholesale) — M2b component/E2E tests that need the flag on must create one (a tsup `define`, mirroring the license gate, is the clean option).

**R2-G — agentLabel rewire scope.** §3.5 must list **all 12** call sites: the 2 existing `createModels(settingsState)` sites (`SettingsModelsTab.svelte:22`, `FirstRunModelPickerModal.svelte:25`) break on the signature change to a no-arg factory (compile-caught), plus the 10 `createAgentLabel(createTandemSettings())` sites repointed to the store. No circular init dependency (verified: the reconcile pulls `loadSettings`/`_readOnly` from the plain `useTandemSettings.ts`, not the singleton). **M4 loading-gate: bake it into `createAgentLabel`** (hold last-good/fallback while `store.loading`) rather than per-site — else the ~10 annotation-card surfaces all flash "Assistant"→real on doc load. M4 scope.

---

## 0. The one-line problem

M1a made the server authoritative for the *resolver* but the client still reads/writes the registry in localStorage. Two authorities now drift (the M1a seeder ran once, then edits diverge). M2 collapses this to **one authority — the server** — so a user's model edits reach the resolver, without losing anyone's existing registry in the transition.

## 1. Scope — M2a (data/authority, dark) then M2b (UI mount + gating, dark)

**M2a:**
1. `GET /api/models` (loopback-full / LAN-allowlist-scrubbed) + an ETag; `POST /api/models` gains ETag optimistic-concurrency (single-flight mutex).
2. A **client models store singleton** (`$state` + getters) that loads from the server, writes through on every CRUD op with optimistic-then-reconcile, exposes `loading`/`saveError`/`reload()`, **and a synchronous snapshot accessor** for non-reactive callers.
3. **Repoint every reader** to the store: App.svelte chip; `resolveAgentLabel`/`useAgentLabel` (~10 components) + the ProseMirror `annotation.ts` path (via the sync snapshot).
4. **Reconcile the M1a drift** — a one-shot app-init action (NOT inside `loadSettings`), gated on a *new* flag, that overwrites the server from localStorage (the newer authority at the transition), ETag-guarded, retry-safe (source never dropped).
5. **Do NOT drop the localStorage fields; do NOT change `TandemSettings` schema.** They go vestigial; the drop is a later cleanup version.

**M2b (built dark; lit at M4):**
6. Mount `FirstRunModelPickerModal`; convert the wizard "coming soon" row (`IntegrationWizardModal.svelte:873`) to the local-model setup entry (add the `{:else}` enabled branch — flipping the flag today makes the row vanish with nothing behind it).
7. **Per-provider visibility** — when the flag flips at M4, local providers show; cloud rows stay hidden (v1.1). Replace the all-or-nothing `SettingsModal.svelte:184` boolean filter with a predicate that survives the split.

**Deferred:** M3 (provider-keyed authorship), M4 (flag flip, chat-target, typing presence, tutorial copy, stub-server E2E, close `TODO(M4)`), and the eventual localStorage field-drop (post-reconcile cleanup).

---

## 2. The central decision — Approach B (server single authority), corrected

The settings singleton is constructed **synchronously** with no loading phase; `createModels` is a stateless factory over it; the toggle/radio controls are fully controlled. Approach A (localStorage stays a write-mirror) keeps two authorities — rejected. Approach C (localStorage read-through cache) reintroduces the second write target for an invisible-while-dark benefit — rejected. **Approach B (recommended):** the registry moves into a **module-level client store singleton** with its own `$state`; the server is the single authority; localStorage stays present-but-vestigial (round-1 fix #1 — not dropped in M2).

### 2.1 The store singleton — three access shapes over ONE state

The map + arch review require the store to serve three consumer kinds off one underlying `$state` (round-1 fix #2):
- **Reactive getters** (Svelte consumers: Settings tab, chip, first-run picker, the ~10 agentLabel components) — `get models()`, `get defaultModelId()`, `get loading()`, `get saveError()`. **Every reactive field is a getter** delegating to the singleton `$state` (the exact cross-component reactivity gotcha #2 — a captured value freezes a snapshot and cross-component updates die).
- **A synchronous snapshot accessor** — `getModelsSnapshot(): { models, defaultModelId }` reading the `$state` synchronously, for the non-Svelte ProseMirror decoration path (`annotation.ts`) and any `loadSettings()`-style caller. Mirrors the server's `getCachedModelsFile()`. Outside a reaction this returns the current value with no subscription — exactly today's `loadSettings()` semantics (read-fresh each rebuild), so no behavior regression.
- **Mutators** — `addModel`/`updateModel`/`deleteModel`/`toggleEnabled`/`setDefault`/`reload`, all optimistic-then-reconcile (§3.2).

State lives module-level (mirroring `_instance` in `useTandemSettings.svelte.ts:36`); `createModels()` returns the getter facade (call sites stable); `_resetModelsStoreForTests` seam. The store holds **deep `$state`** (not `$state.raw`) + **immutable array replacement** in every op, so the derived `grouped` (`SettingsModelsTab.svelte:42-50`) reliably recomputes and the optimistic write reflects in the controlled checkbox without a bounce.

---

## 3. Design — M2a

### 3.1 `GET /api/models` + ETag — `src/server/models/api-routes.ts` / `registry.ts`

- Register `app.get(API_MODELS, mw, makeGetModelsHandler())` (no `largeBody` on reads). `mw = lanAwareApiMiddleware` runs the Host-header guard first. `isLoopback(req.socket.remoteAddress)` from `../../auth/middleware.ts` (note: `.ts`, not the plan-draft's `.js`).
- **Loopback-full / LAN-allowlist-scrubbed** (round-1 fix #4 — allowlist, not denylist): the LAN response is *built by selecting* the disclosure-safe fields — `{ id, provider, displayName, modelId, enabled }` per entry + `defaultModelId` + `etag` at file level — so a future field (e.g. a `params` proxy URL, an M3 authorship field) is **non-disclosed until explicitly promoted**. `endpoint` and `apiKeyRef` never cross to LAN. Loopback gets the full file. Document the contract in a header comment like `sessions.ts:19-21`.
- **ETag** = SHA-256 of the **canonical serialized bytes** the store writes (`JSON.stringify(file, null, 2) + "\n"`) — deterministic (fixed key order), restart-stable, no schema change. Computed from the warm cache (`getCachedModelsFile()`); expose `getModelsEtag()` from `registry.ts` alongside `getCachedModelsFile()` so GET and the POST precondition share one implementation. Response envelope: `{ file, etag }` (loopback) / `{ file: scrubbed, etag }` (LAN).
- **Dark-inert option (round-1 note):** guard the handler `if (!BYO_MODELS_ENABLED) return 404` so the reachable read surface is literally byte-identical while dark (the route is otherwise live-callable the moment it registers). Cheap; keeps §7 honest. *(Decision 8.)*
- Read route → not mutation-gated, not license-gated (consistent with M1a's read posture).

### 3.2 Client models store — `src/client/hooks/useModels.svelte.ts` (rewrite internals)

Module-level singleton:
```
_models: $state<ModelsEntry[]>([])
_defaultModelId: $state<string | null>(null)
_etag: $state<string | null>(null)      // last-seen server ETag
_loading: $state<boolean>(false)         // fix: init false, set true at load start
_saveError: $state<string | null>(null)
_loaded: $state<boolean>(false)
_loadInFlight: Promise<void> | null      // dedup concurrent loads
```
- `loadFromServer()` — dedup via `_loadInFlight`; `GET /api/models`; on success set state + `_etag` + `_loaded`; on failure set `_saveError`, leave `_loaded=false` (retriable). Writes land in the promise **microtask** (safe — no active reaction, confirmed not a `state_unsafe_mutation` risk). Kicked off **imperatively from `main.ts`** (not an `$effect`/`onMount`), **`BYO_MODELS_ENABLED`-gated** so a dark boot does zero fetch.
- Each mutator = **optimistic-then-reconcile**, with the optimistic `$state` write as the **first synchronous statement before any `await`** (this is the invariant that kills the controlled-input bounce; promote it to a code comment):
  1. snapshot `{models, defaultModelId, etag}`;
  2. apply mutation to `$state` immediately (immutable replacement);
  3. `POST /api/models` body `{ file: projectToContract(current), ifMatch: _etag }` — `projectToContract` drops `_legacyApiKey`/plaintext (reuse the M1a migration's `projectEntry`), so `.strict()` never 400s on a legacy blob;
  4. `200 { etag }` → adopt new `_etag`, clear `_saveError`;
  5. `409 { etag }` (stale) → `reload()` (re-GET), then **re-apply the user's single intent once** against fresh state and re-POST; if that also 409s or errors → **adopt the reconciled server state** (do NOT leave the optimistic mutation standing — round-1 fix #4) + set `_saveError`;
  6. non-409 error → **rollback to snapshot** + set `_saveError` (the visible re-flip is honest failure feedback, paired with the error surface).
- **Keychain ordering** (round-1 fix #4, reconciling security-F5 + arch-Q4.3): keep **secret-before-registry** (store the secret, then POST the registry). On a **terminal** (non-409) registry failure for `addModel`, best-effort-delete the just-minted ref (`keychain.delete` never throws). On a **409**, do NOT delete — the retry still needs the secret. This preserves "a persisted ref is always backed" without a two-phase-commit tangle against retries.
- `ModelsState` gains `loading`, `saveError`, `reload()` — all getters.

### 3.3 Reconcile the M1a drift — a one-shot app-init action (NOT a schema migration)

Round-1 fixes #1 + the arch "keep the seed outside `loadSettings`" both point here. Replace the M1a `migrate-models-registry.ts` seeder:
- **New action** `reconcileModelsToServerOnce()` — runs once at app init (imperative, from `main.ts`), gated on a **new** flag `tandem:models-reconciled-to-server-v2` (the old `-migrated-` flag is the wrong signal — it means "seeded once", not "current").
- Fires **only if** `!settings._readOnly` (downgrade guard — a stale client must not clobber) AND localStorage still carries a non-empty registry. Then: `GET /api/models` → `etag_now`; `POST { file: projectToContract(localStorage.models+defaultModelId), ifMatch: etag_now }`. **Overwrite semantics on purpose:** at the v-transition localStorage is definitionally ≥ the server (the only server writer was the M1a seed; the only localStorage writer was the newer UI), so we push localStorage → server *unconditionally* (not "skip if server non-empty"). Set the flag **only on `res.ok`**.
- **Retry-safe by construction:** the localStorage source is never dropped, so a failed/ offline reconcile leaves the flag unset and retries next boot — exactly M1a's safety, restored. No async-vs-durable-drop race because there is no drop.
- **Sequencing vs. the store + CRUD (round-1 Svelte/data-loss #5):** the reconcile must complete (flag set, or confirmed skip) **before** the store accepts user CRUD write-throughs, so a late reconcile POST can't clobber a fresh edit. Gate: `loadFromServer()` awaits `reconcileModelsToServerOnce()` first (or the store starts read-only until reconcile settles). The reconcile POST carries `ifMatch` so even a racing two-window reconcile 409s rather than clobbers.

### 3.4 Optimistic concurrency — content-hash ETag (no schema bump)

- `POST /api/models` body becomes `{ file: ModelsFile, ifMatch: string | null }` (`ifMatch:null` = "expect empty/absent server"). The `.strict()` `ModelsFile` stays pure — `ifMatch` is a sibling field on the envelope, never persisted.
- Handler (after the existing origin→loopback gates): **single-flight mutex** (mirror the integrations `apply` in-flight gate) around: compute `getModelsEtag()`; if `ifMatch !== currentEtag` → `409 { code:"MODELS_STALE", etag: currentEtag }` (no file — client re-GETs, closing the security 409-body-scrub leak); else `persistModelsFile(file)` and return `200 { etag: newEtag }`. The server **discards** any client-sent token and derives the new etag from the freshly written bytes.
- **No models-schema change** → no v1→v2 downgrade cliff. The `revision`-field alternative is rejected specifically for that cliff (round-1 fix #3).
- Bounded single retry on the client (§3.2 step 5) → no livelock by construction.

### 3.5 Repoint the readers (round-1 fix #2 — the corrected reader graph)

- **App.svelte chip** (`:651-656`, `:1852`) → read the store's `defaultModelId`/`models` getters (keep `$derived.by`; still gated `BYO_MODELS_ENABLED ? … : null`; at M4 also gate on `loading` to avoid an empty→label pop).
- **`resolveAgentLabel` (`agentLabel.ts`) + `useAgentLabel.svelte.ts`** → source `{models, defaultModelId}` from the store, not `Pick<TandemSettings,…>`. The ~10 always-mounted consumers keep reactivity via the store getters. **This signature change is planned M2a scope**, not a compile-surprise.
- **ProseMirror `annotation.ts:69-71`** (`readAgentFamilyLabel` → `resolveAgentLabel(loadSettings(), "family")`) → `resolveAgentLabel(getModelsSnapshot(), "family")` (the synchronous accessor). Read-fresh-each-rebuild semantics preserved.
- **Vestigial-but-present:** `TandemSettings.models`/`.defaultModelId` remain (no schema change), now with no readers/writers on the models path. `updateSettings` still carries them inertly. The drop is a future cleanup version once the reconcile is proven.

---

## 4. Design — M2b (UI mount + per-provider gating; built dark)

- **Per-provider predicate** replaces `SettingsModal.svelte:184`'s boolean filter: flag-on → show the Models tab, render only `isLocalProvider` rows, cloud rows disabled + "coming in a future release" (v1.1); flag-off → tab filtered out (byte-identical dark). First-run picker reuses its existing `isCloud` split.
- **Mount `FirstRunModelPickerModal`** in the first-run choreography (behind the flag), wired to the store.
- **Wizard row** (`IntegrationWizardModal.svelte:873`): add the `{:else}` enabled "Set up a local AI model" branch opening the models setup path (else flipping the flag removes the "coming soon" row with nothing behind it).
- **Loading + error surfaces** in `SettingsModelsTab`: skeleton while `models.loading`; wire `setDefault`/`toggleEnabled`/`deleteModel` (which have no error channel today) to the store's `saveError` + the 409 "changed elsewhere — reloaded" notice.

---

## 5. Decisions to settle in round-2 review

1. **Reconcile-not-drop (§3.3)** — is the one-shot ETag-guarded overwrite-from-localStorage, gated on the new flag and sequenced before CRUD, sound against every upgrade/downgrade/skip/multi-window path the data-loss review enumerated? (Highest-stakes; my fix is new.)
2. **agentLabel sync-snapshot (§2.1, §3.5)** — is `getModelsSnapshot()` reading module `$state` synchronously from the ProseMirror path correct, and is the `useAgentLabel` rewire complete across all ~10 consumers?
3. **ETag vs revision (§3.4)** — content-hash ETag confirmed over the persisted counter (downgrade-cliff avoidance).
4. **Keychain order (§3.2)** — secret-before-registry + terminal-only ref-delete (reconciles the two round-1 recommendations).
5. **M2a/M2b split** — one PR or two. Recommend **two** (M2a is the risky authority relocation; M2b is additive dark UI).
6. **LAN allowlist membership (§3.1)** — is `displayName`/`modelId` acceptable LAN disclosure (user-authored, reveals what runs on the box), or strip to `{id, provider, enabled}`?
7. **Cloud rows at M4 (§4)** — disabled "coming soon" vs omitted.
8. **Dark-404 the GET (§3.1)** — 404 while dark for a literally-inert read surface, vs leave it live (config-metadata only, no plaintext).

## 6. Testing

- **Server:** GET loopback-full incl. `etag`; LAN allowlist-scrub (assert `endpoint`/`apiKeyRef`/`params` absent, and a *newly added* field is absent by default); dark-404 (if Decision 8 yes). POST ETag: matching `ifMatch` writes + returns new etag; stale `ifMatch` → 409 `{code, etag}` **with no file** and **on-disk file unchanged**; single-flight mutex serializes two concurrent same-etag POSTs (one wins, one 409s). `.strict()` still rejects plaintext with the envelope shape. ETag determinism (same file → same etag across processes).
- **Client store:** load populates + clears `loading`; optimistic mutate reflects before the POST resolves; `200` adopts etag; `409` reload→re-apply-once→(fail)→**adopt server state** (assert no lingering divergence); non-409 → rollback; getter-facade cross-component reactivity (two `createModels()` share state); `getModelsSnapshot()` returns current state synchronously; dark → no GET. Keychain: secret-before-registry; terminal failure best-effort-deletes the ref; 409 does **not** delete; write-through body carries no `_legacyApiKey`/plaintext.
- **Reconcile (the data-loss cases):** M1a-seeded-then-edited-then-M2 → localStorage overwrites the stale server (the important Q4 case); reconcile POST fails → flag unset, localStorage intact, retries next boot (no loss); `_readOnly` client → no reconcile; two-window concurrent reconcile → ETag 409, no double-clobber; reconcile sequenced before CRUD (a CRUD write can't precede reconcile settle).
- **agentLabel:** `resolveAgentLabel` resolves the right label off the store; the ProseMirror snapshot path resolves synchronously; the ~10 consumers still render labels (no regression) with the store empty (fallback) and populated.
- **Downgrade:** a store-written file read by an M1a binary is **not** backed-up-and-emptied (no schema bump — the cliff the `revision` field would have created is absent).
- **Component (dark, force-on seam):** loading skeleton → list; error on every mutating path; no controlled-input bounce under slow/failed write; per-provider gate shows local, hides/disables cloud.
- **E2E:** `settings-models.spec.ts:100` stays `test.skip(!BYO_MODELS_ENABLED)` through M2; add force-on specs where the harness allows, else land wired-but-skipped for M4.
- Full suite green; typecheck + `svelte-check` clean.

## 7. Dark-guarantee checklist (every commit)

`BYO_MODELS_ENABLED=false` → no Models tab, no chip, no first-run mount, no wizard enabled-row, no `GET /api/models` fetch from the client, and (Decision 8) the GET handler 404s. The store's `loadFromServer` and `reconcileModelsToServerOnce` are flag-gated → no boot fetch/POST while dark. `TandemSettings` schema is **unchanged** (no v17→v18) → the settings migration is a genuine no-op for everyone. The agentLabel rewire changes the *source* of a label that today reads localStorage; while dark, `getModelsSnapshot()` returns whatever the (unfetched) store holds — which must equal today's label output for existing users. **Verify:** with the flag off, `resolveAgentLabel` yields byte-identical labels to the pre-M2 localStorage read (the store, unfetched, must fall back to the same "Claude"/family default). This is the one subtle dark-guarantee risk in M2 and gets an explicit test. `check:tokens`/typecheck/`svelte-check` clean.

## 8. Out of scope

- **M3** — provider-keyed authorship (`author` beyond `"claude"`, `agentLabel` provider wiring, authorship color, channel + Solo/Tandem semantics for a non-Claude agent). *Note:* M2's agentLabel rewire is the seam M3 extends.
- **M4** — flip `BYO_MODELS_ENABLED`; chat-target selection; typing presence; tutorial/user-guide copy (≥14B floor); E2E vs a stub OpenAI-compatible server; close `TODO(M4)`; gate the chip on `loading`.
- **Later cleanup** — drop `models`/`defaultModelId` from `TandemSettings` (the deferred v-bump), once the reconcile is proven in the field.
