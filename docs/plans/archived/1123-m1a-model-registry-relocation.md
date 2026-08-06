# #1123 M1a — Model-registry persistence relocation (server-side)

**Status:** APPROVED (Bryan, 2026-07-21) — **Option B**. Revised after 3-agent adversarial review (security, architecture, Svelte reactivity). Implementing.
**Issue:** #1123 (local-model collaborator), phase **M1a**. ADR-039 canonical.
**Ships:** DARK. `BYO_MODELS_ENABLED` stays `false`. Runtime must remain byte-identical to today for end users.

**Review round (2026-07-21):** security-reviewer, feature-dev:code-architect, svelte-migration-reviewer each reviewed the first draft in prose. Core server design confirmed sound (gating order, no-nonce reasoning, SSRF/TOCTOU, license-gate exclusion all verified against real code). They surfaced one critical boot bug (cold cache → §3.4), one security-guard bypass (`_readOnly` → §3.6), a CORS-method break (`PUT` → §3.3), and a convergent finding that the client async-CRUD write-through concentrates all the reactivity/concurrency risk and belongs with the UI in M2. This revision folds all of that in.

**Post-implementation /simplify round (2026-07-21):** 4 cleanup agents (reuse/simplification/efficiency/altitude). Applied: gate the boot cache-warm behind `BYO_MODELS_ENABLED` (restores byte-identical-when-dark — prime + wire light up together at M4); reuse `API_BASE` in the migration; dedup `readSchemaVersion` (exported from `integrations/storage.ts`); inline `deriveTransport` (a constant seam — two agents converged). **Deferred follow-up:** the shared config-store helpers (`atomicWriteConfigFile`/`backupBrokenJsonFile`/`sweepBrokenBackupsOnStartup`/`readSchemaVersion`) live in `integrations/storage.ts`, giving `models/store.ts` a models→integrations dependency for domain-neutral file mechanics. A clean lift to a neutral floor (`src/server/file-io/`) cascades into re-homing `acl-win`/`backup` and inverts the dependency direction — out of M1a scope, worth its own PR.

---

## 1. Why this phase exists

The local-model collaborator engine (M1.1) and its server wiring (M1.2) already live in `src/server/local-model/`, gated behind two dark layers:

1. `BYO_MODELS_ENABLED = false` (`src/shared/constants.ts:18`) — `collaborator.ts:338` early-returns in `start()`, so the loop never subscribes.
2. `resolveLocalModelConfig()` (`src/server/local-model/config-source.ts:17`) returns `null` — even if the flag flipped, the loop has no config, so it stays inert (`collaborator.ts:306`, `:192`).

The collaborator resolves config **once at boot** inside `wire()` (`collaborator.ts:327`), caches it (`collaborator.ts:104`), and flows the `{endpoint, modelId, transport}` object opaquely through `runLocalModelTurn` → `runLoop` → `chat`, where `ollama-client.ts:498-503` is the sole consumer.

The blocker M1a removes: **the model registry today lives only in client `localStorage` (`tandem:settings`, schema v17).** The server can't read it, so a server-side loop can't resolve an endpoint without a browser session. The server currently holds only keychain secret *refs* (`src/server/models/api-routes.ts`, service `tandem-models`) — never the registry entries themselves.

M1a relocates the registry so the server is the authority for `{endpoint, modelId, transport}`.

## 2. Two decisions: storage authority (settled) + M1a scope boundary (needs Bryan)

### 2a. Storage authority — server-authoritative (settled)

The registry becomes a **server-owned file**; the server is the single authority. M1a's job is "resolve config with **no browser session**," and a synced *copy* (client authoritative, pushes a mirror) is stale exactly in the case that matters — a server run where no browser has opened has nothing to read. Server-authoritative matches the `integrations.json` precedent, consolidates with the already-server-side keychain (service `tandem-models`), and has exactly one writer authority. Not in dispute.

### 2b. M1a scope boundary — **needs Bryan's call**

The review surfaced that the **client async-CRUD write-through rewire** (`useModels` → server on every add/update/delete/toggle/setDefault) is where *all* the risk concentrates — lost-update clobber across tabs, optimistic-feedback flicker on native controls, empty-init flash, factory-vs-singleton migration placement, and the `_readOnly` bypass — and it is **entirely dark until M2 unhides the UI that drives those edits**. That argues for cutting M1a at the server boundary.

Three options:

- **Option A — full relocation in M1a (issue-literal).** Server store + resolver + routes **+ the client async-CRUD write-through rewire**. Largest surface; takes on all four Svelte hazards + Findings 2/3/4/5 now, all dark, with no UI exercising them until M2. Most faithful to the issue's M1a wording, but front-loads risk into a phase that can't visibly test it.
- **Option B — server scaffolding + one-time migration (recommended).** Server store + `ModelsFileSchema` + `POST /api/models` (migration target) + resolver + **boot cache-warm** + the **one-time localStorage→server migration** (client-side, singleton-scoped, `_readOnly`-gated, idempotent). The client CRUD (`useModels`) is **left unchanged** — it still writes localStorage, which is harmless because the UI is dark and nobody edits. Delivers a demonstrable end-to-end path (migrate → resolve) and keeps the issue's "migration in M1a" intent. Defers the async-CRUD write-through + its concurrency/reactivity work to **M2**, where the real UI exercises it.
- **Option C — pure server scaffolding.** Server store + resolver + boot-warm + `POST /api/models` + unit tests, **zero client changes**. Defers *both* migration and CRUD rewire to M2. Leanest and most purely additive/dark, but the route + migration go untested by a live client until M2.

**Recommendation: Option B.** It unblocks the resolver end-to-end and honors the issue's migration-in-M1a intent, while moving the genuinely risky async-CRUD reactivity rewire to the phase whose UI actually drives it. The rest of this plan is written to Option B; §6 marks what shifts under A or C.

**Why the client CRUD staleness isn't a bug under B:** with `useModels` unchanged, localStorage keeps taking edits — but every Models edit surface is hidden behind `BYO_MODELS_ENABLED=false`, so zero edits occur in M1a. After the one-time migration populates the server file, the server is the read authority; the (unused) localStorage copy goes stale harmlessly. M2 rewires `useModels` to write through, at which point the UI that produces edits and the server authority land together.

## 3. Design

### 3.1 Shared contract — `src/shared/models/contract.ts` (new)

Client and server must agree on the persisted shape. Mirror `src/shared/integrations/contract.ts`.

- `MODELS_SCHEMA_VERSION = 1 as const` (net-new file; no migrations yet, but scaffold `migrateUp` for parity).
- The persisted entry = the client `ModelRegistryEntry` (`src/client/hooks/useTandemSettings.ts:86-111`) **minus** transient/plaintext fields:
  - keep: `id`, `provider`, `displayName`, `modelId`, `apiKeyRef?`, `endpoint?`, `enabled`, `params?`
  - drop: `_legacyApiKey` (transient, never persisted) and any plaintext `apiKey` (lives in keychain).
- File wrapper: `{ schemaVersion: 1, models: ModelEntry[], defaultModelId: string | null }` — same shape as the client's `tandem:settings` `models` + `defaultModelId`, so migration is a projection, not a transform.
- Provider union reused from a shared source. **Today `ModelProvider` is defined client-side (`useTandemSettings.ts:63`).** M1a moves the union + `VALID_MODEL_PROVIDERS` allowlist into the shared contract and re-exports from the client hook (no behavior change; the client keeps importing the same names).

### 3.2 Server store — `src/server/models/store.ts` (new)

Mirror `src/server/integrations/storage.ts` beat-for-beat:
- `createModelStore(basePath)` — absolute-path assertion, file `models.json` under `resolveAppDataDir()` (`src/server/platform.ts:10`).
- Atomic write: temp `.models.json.<uuid>.tmp` (`wx`, `0o600`) → `rename`, with the EXDEV `writeViaOpen` fallback and POSIX `chmod` backstop copied from integrations.
- Read: ENOENT → empty file; malformed JSON **or version-too-new** → `backupBrokenFile` + empty. **Divergence from integrations (security Finding 2):** integrations *throws* on version-too-new (`storage.ts:104`), but that read is always inside an HTTP `try/catch`. The models store is read on the **synchronous resolver / boot-warm path with no error channel**, so throwing would crash the collaborator boot and violate "corrupt config never crashes startup." The models read path therefore **backs-up-and-empties on version-too-new too — it never throws.** Reuse the integrations broken-backup helper (parameterized by prefix); do not invent a new one.
- `migrateUp` scaffold (empty migrations array at v1) + Zod `safeParse` after migrate, throwing on post-migration validation failure (integrations pattern) — but see the boot-warm swallow in §3.4: any store read error surfaced to the resolver becomes `null`, not a crash.
- Referential-integrity pass: clear `defaultModelId` if it points at a missing/removed entry (mirrors integrations' `enforceReferentialIntegrity`).
- **Broken-backup startup sweep (security Finding 4):** wire a `sweepBrokenModelsBackupsOnStartup` (or parameterize the existing integrations sweep by prefix) alongside `src/server/index.ts:238`, so models broken-backups are pruned to the same `MAX_BROKEN_BACKUPS` cap and don't grow unbounded.

### 3.3 Routes — extend `src/server/models/api-routes.ts` (existing file)

This file already hosts the gated secrets routes (`POST/DELETE /api/models/secrets/:ref`) and the gate helpers pattern. Under Option B, M1a adds **one** route:

- **`POST /api/models`** — whole-file replace (the migration target). **Use `POST`, not `PUT` (security Finding 1):** `Access-Control-Allow-Methods` is hard-coded `GET, POST, DELETE, OPTIONS` (`src/server/mcp/api-routes.ts:125`) — a `PUT` preflight from the cross-origin `tauri.localhost` client is rejected by the browser. `POST` also matches the `POST /api/integrations` persist route this is modeled on and the existing `POST /api/models/secrets/:ref`. Gated in this exact order:
  1. `assertOriginAllowlisted(req, res, label)` (`src/server/integrations/api-routes.ts:287`)
  2. `assertLoopbackForMutation(req, res)` (`:264`)
  3. `ModelsFileSchema.safeParse(req.body)` → 400 on failure (defense-in-depth)
  4. `store.write(parsed.data)`

  No nonce/mutex needed (no cross-request confirmation handshake like `apply`; a whole-file idempotent replace). Follow the `POST /api/integrations` shape.
- **Route registration carries the DNS-rebinding guard (security Finding 5):** register through `registerModelsRoutes` with the LAN-aware `mw` middleware prepended (`app.post(PATH, mw, largeBody, handler)`, matching `models/api-routes.ts:62-64`), so the Host-header allowlist check (`api-routes.ts:115`) runs ahead of the handler. A hand-rolled `app.post` that skips `mw` silently drops the guard.
- **Schema is `.strict()` (security Finding 3):** `ModelsEntrySchema` and `ModelsFileSchema` reject unknown keys loudly (400), so a stray plaintext `apiKey` in a body can never be persisted — this is the enforcement point for the "no new plaintext surface" claim, not merely field selection.
- **`GET /api/models` moves to M2** — under Option B the client doesn't load from the server yet (`useModels` unchanged), so the read route isn't needed until M2's write-through rewire. The resolver reads the store in-process, not over HTTP.
- **License gate — stays OUT (confirmed).** `registerModelsRoutes` is not wrapped by `licenseGateMiddleware` today (`server.ts:477`), consistent with integrations. A registry-*config* write is not a document/annotation content write; the local model's actual content mutations are gated at the `tools.ts` dispatch boundary. Gating this route would let a restricted license block *reconfiguring* a model without blocking any content write — wrong. Keep it out.

### 3.4 The resolver — rewrite `resolveLocalModelConfig()` body only

Per the `config-source.ts` header contract, M1a swaps **only this file's body** — no collaborator change.

```
resolveLocalModelConfig():
  file = modelStore.read()            // server-authoritative
  entry = file.models.find(m => m.id === file.defaultModelId)
  if !entry || !entry.enabled: return null
  if !isLocalProvider(entry.provider): return null   // cloud default → inert (v1.1)
  if !entry.endpoint: return null
  transport = deriveTransport(entry.provider)
  if validateEndpoint(entry.endpoint).ok === false: return null  // defense-in-depth
  return { endpoint: entry.endpoint, modelId: entry.modelId, transport }
```

Store access must be synchronous-friendly for the resolver's `() => LocalModelConfig | null` signature. Keep an **in-memory cache** of the parsed file; the resolver reads the cache synchronously. This preserves the collaborator seam signature (no collaborator change, honoring the `config-source.ts` header contract).

**Boot cache-warm — the critical fix (architecture Finding 1).** The cache must be **primed from disk at boot, before `startLocalModelCollaborator()`**, not only refreshed on write. The collaborator resolves config exactly once, synchronously, at boot (`collaborator.ts:327`); with a write-only-refreshed cache, a fresh server run with a valid `models.json` on disk reads a **cold empty cache and returns `null`** — silently defeating the phase's entire "resolve without a browser session" premise (the file is real but invisible until some `POST` happens in that process, which needs a browser). Fix: add an **awaited** `primeModelStoreCache()` in `src/server/index.ts` ordered before `startLocalModelCollaborator()` (`index.ts:420-422`), exactly as `restoreCtrlSession()` / `restoreOpenDocuments()` are awaited before their dependents (`index.ts:399-408`). Cache is then written through on every `store.write`.

**Boot-warm and resolver both swallow store errors → `null` (security Finding 2).** `primeModelStoreCache()` and `resolveLocalModelConfig()` wrap store access so any read/parse error yields an empty cache / `null` config — the loop goes inert, boot never crashes. This is what lets §3.2's "never throw" contract hold on the error-channel-less resolver path.

*(Inert today regardless: `BYO_MODELS_ENABLED=false` short-circuits `start()` before `wire()` ever resolves — `collaborator.ts:338`. Both fixes are latent until M4 flips the flag, but must land in M1a since M1a owns the resolver + boot path.)*

### 3.5 Three sub-decisions (my calls; flagged for review)

- **Transport derivation.** The client entry has no `transport`; the loop needs `v1 | native`. Both Ollama and llama.cpp expose an OpenAI-compatible `/v1/chat/completions`. **Recommend `v1` for both local kinds** — the Ollama-native `/api/chat` path is an optimization, not required, and `v1` keeps one code path. Transport can become an optional per-entry field later (M2/M4) if native buys measurable value. *Open to reviewer disagreement.*
- **Cloud-default → inert.** If `defaultModelId` points at a cloud provider (`anthropic`/`openai`/`gemini`), the local loop stays inert — cloud BYO keys are v1.1 (ADR-039). Correct per scope; documented so it's not read as a bug.
- **`TODO(M1a)` at `collaborator.ts:302-305`** — flags that once config is dynamic, a config resolving null *after* a successful boot is indistinguishable from the dark no-op, because the boot breadcrumb fires once. Under Option B M1a makes **no collaborator change** (per the header contract), so it keeps the once-at-boot resolution. The architecture review confirmed this is **genuinely inert while dark** (`start()` never calls `wire()` at all) and distinct from the *first-resolve* boot bug in §3.4. **Decision: retag the breadcrumb `TODO(M4)`** — dynamic re-resolution + rate-limited misconfig logging land with the flag flip, when a live user can actually misconfigure. (Retagging a comment is not a behavior change.)

### 3.6 Client — one-time migration ONLY (Option B); CRUD write-through deferred to M2

Under Option B the **only** client change in M1a is a one-time localStorage→server migration. `useModels` CRUD stays synchronous-localStorage as it is today (dark, unedited). The async write-through rewire — and all its hazards — moves to M2 (§6).

**One-time migration** — project the client's `tandem:settings.models` + `defaultModelId` to the server file once:
- **Trigger:** server file empty/absent AND `tandem:settings.models` non-empty. Keychain refs already point at server-side secrets (service `tandem-models`), so no key re-entry. The projection drops `_legacyApiKey`/`apiKey`; only `apiKeyRef` + non-secret fields cross.
- **`_readOnly`-gated (architecture Finding 2 — a security guard, not a nicety):** the migration `POST` fires **only if `!settings._readOnly`**. The `_readOnly` forward-compat guard (`useTandemSettings.svelte.ts:91`) exists precisely so a downgraded client "cannot clobber a newer client's data (most notably the Models registry's plaintext API keys)" (`useTandemSettings.ts:220`). An ungated network write-through would reintroduce that vulnerability over HTTP. The gate must wrap the migration POST.
- **Singleton-scoped, not per-component (Svelte Hazard D):** `createModels()` is a **factory, not a singleton** — it's instantiated independently in `SettingsModelsTab` and `FirstRunModelPickerModal`. Placing the migration inside it would fire **once per mounting component → racing migration POSTs**. The migration must hang off the memoized `createTandemSettings` singleton (`useTandemSettings.svelte.ts:80`, `_instance`) or a module-level once-guard.
- **Idempotent + teardown-safe:** the "server empty" trigger + atomic server write make a re-run after partial failure safe (server stays empty → retried next boot) and make two same-source tabs write identical payloads (self-healing). Guard the async POST against component teardown (write no state after unmount — another reason it lives on the settings singleton, which outlives the components).
- **Accepted trade-off (architecture Finding 4):** in the narrow "server file already non-empty AND a *different* browser-origin's localStorage also has entries" case, migration correctly no-ops and those local-only entries are not merged. Given browser distribution is deprecated (#477 PR 2), realistic exposure is desktop-vs-legacy-browser or a manually reset `TANDEM_APP_DATA_DIR`; recorded as accepted, not silently ignored.
- **No client schema migration (architecture Finding 5):** M1a does **not** drop `models`/`defaultModelId` from `tandem:settings`. Those are non-optional `TandemSettings` fields with their own migration history; removing them is a real v17→v18 client migration (`REMOVED_FIELDS` pattern), which belongs to M2's rewrite, not here. M1a leaves the client schema untouched.
- Stays behind `BYO_MODELS_ENABLED` — no UI surface changes.

## 4. Security

- New mutation route (`PUT /api/models`) gated origin + loopback + safeParse, exactly the integrations mutating-route posture. `GET` LAN-scrubbed.
- Endpoint stays loopback-only via `validateEndpoint` (`config.ts:57`) at resolve time; the engine re-validates at fetch time (validate-at-use / TOCTOU). No LAN endpoints in v1.0 (ADR-039).
- No new plaintext key surface — the store holds `apiKeyRef` only; plaintext stays in the keychain (`tandem-models`).
- `security-reviewer` pass required on: the route gating, the LAN scrub, the store's broken-file handling, and confirmation that the license gate correctly excludes registry config.

## 5. Testing (Option B)

- `store.ts` unit tests mirroring integrations storage tests: atomic write, missing file → empty, malformed → backup + empty, **version-too-new → backup + empty (never throws)**, referential integrity clears stale `defaultModelId`, `.strict()` schema rejects an unknown `apiKey` key.
- Route tests (`POST /api/models`): rejects bad origin, rejects non-loopback (fail-closed), rejects malformed/unknown-key body (safeParse 400), round-trips a valid file; verify the route registers with `mw` so the Host-header guard runs.
- Resolver tests: local default → config; cloud default → null; disabled default → null; missing endpoint → null; non-loopback endpoint → null; transport derivation per provider; **store-read-error → null (no throw)**. Race-immune (seed store directly, not via a timed write).
- **Boot-warm test (guards Finding 1):** prime the cache from a seeded on-disk `models.json`, then assert the *first* synchronous `resolveLocalModelConfig()` (no prior write in-process) returns the seeded local default — the regression that a write-only cache would fail.
- Collaborator: existing dark-gating test still asserts `resolveConfig` is not called while the flag is false (`collaborator.test.ts`). Add: flag forced on via the test seam + seeded local default → loop resolves a non-null config.
- Client migration test: empty server + populated localStorage → one `POST` with the projected registry; **`_readOnly` settings → no POST**; re-run with non-empty server → no POST (idempotent).
- Full suite green; typecheck clean; `svelte-check` clean.

## 6. Out of scope (phase boundaries)

- **M2** — the **client async-CRUD write-through rewire** deferred from M1a lands here, alongside unhiding the Models UI for local providers (Settings→Models / default chip / first-run picker; wizard "coming soon" → setup path). This is where the review's convergent hazards get solved *with the UI that exercises them*:
  - `GET /api/models` load-on-init + `useModels` write-through (add/update/delete/toggle/setDefault → server).
  - **Concurrency (arch Finding 3 + Svelte Hazard A):** whole-file `POST` from a live CRUD surface across two tabs is last-writer-wins clobber. Add an optimistic-concurrency guard (version/etag on the file → 409 on mismatch) or a single-flight write queue; add interleaved-write tests.
  - **Optimistic feedback (Svelte Hazard B):** the native toggle/radio controls are controlled (`checked={…}` + `onchange`), so a pessimistic write-through makes them visibly bounce. Mandate optimistic-update-then-reconcile with rollback + an **error channel for the toggle/default path** (which has none today — `SettingsModelsTab.svelte:205,218`).
  - **Empty-init flash (Svelte Hazard C):** async `GET` on init makes the registry briefly `[]` → empty-state card / legacy banner / titlebar chip flash. Add a `loading` gate.
  - **Client schema migration:** if M2 drops `models`/`defaultModelId` from `tandem:settings`, that's the v17→v18 `REMOVED_FIELDS` migration (arch Finding 5).
  - Flag stays off through M2.
- **M3** — provider-keyed authorship, `agentLabel` wiring, authorship color, channel + solo/tandem semantics for a non-Claude agent.
- **M4** — flip `BYO_MODELS_ENABLED`; chat target selection; typing presence; tutorial/user-guide copy naming the tested-model floor; E2E vs a stub OpenAI-compatible server; close the deferred dynamic-re-resolution `TODO(M4)` (§3.5).

**Under Option A** the M2 client bullets above move into M1a. **Under Option C** the one-time migration (§3.6) also moves to M2, leaving M1a pure server scaffolding.

**Doc nit (fold into this PR):** `src/server/models/api-routes.ts:13` ("the client persists only the opaque `apiKeyRef` in `tandem:settings`") goes stale once the registry relocates — update it.

## 7. Decisions for Bryan

**The one that gates everything:**
1. **M1a scope (§2b)** — **Option B recommended** (server store + resolver + boot-warm + `POST` route + one-time migration; defer the async-CRUD rewire to M2). Option A = full relocation now; Option C = pure server scaffolding, migration also to M2.

**Settled by review unless you object (recorded so they're visible, not to relitigate):**
2. **Transport** — `v1` uniform for both local kinds; `native` becomes an optional per-entry field later if it earns its keep.
3. **Cloud-default → inert** — a cloud `defaultModelId` leaves the local loop inert (cloud is v1.1).
4. **`TODO(M1a)` → `TODO(M4)`** — dynamic re-resolution defers with the flag flip; M1a makes no collaborator change (§3.5).
5. **localStorage** — left untouched in M1a; the mirror-vs-drop client-schema decision is M2's (§3.6, arch Finding 5).

Everything else (POST-not-PUT, `.strict()` schema, backup-not-throw, boot-warm, `_readOnly` gate, broken-backup sweep, `mw` registration) is a folded-in review fix, not a fork.
