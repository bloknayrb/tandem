# PR #1156 review-fixes plan — on-device licensing gate

Source: 7-agent `/pr-review-toolkit:review-pr` pass on PR #1156 (head `84abaf9`).
Verdict from review: crypto core + both enforcement surfaces + central CRDT fix
are **sound**; findings are latent-behind-the-dark-flag but must be correct before
the v1.0 flag-flip. Every fix below has been grounded against the branch-head source.

**Invariant that gates the whole plan:** the build is byte-identical when
`__LICENSE_GATE_ENABLED__ = false`. Every in-app change here must be inert in a dark
build (the `force`-gate calls `licenseGate()`, which returns `null` when the gate is
dark). The three always-compiled changes (H2 worker, L1/L2/L3 verifier+webhook) are
behavior-preserving hardening, not gated behavior — called out per-item.

---

## Phase 1 — High (in-PR, must)

### H1 — Gate the destructive `force`-reload sub-path of open on BOTH transports
**Why:** `force` flows into `openFileByPath → clearAndReload`, which at
`file-opener.ts:1182` calls `await dropped.store.clear()` — **wiping the durable
annotation file** (comment at 1175-1178 confirms this is intentional for reload). A
*restricted* user (escape-hatch state) can thereby permanently destroy trial-era
annotations, violating the gate's own promise ("your documents stay open for reading and
export").

**Complete enumeration of the annotation-wiping (`clearAndReload`) callers** (verified —
so closure is provable, not implied):
1. `tandem_open(force:true)` — MCP, `document.ts:292` → `openFileByPath({force})`. **UNGATED → H1 fixes.**
2. `POST /api/open {force:true}` — `api-routes.ts:191` → `routes/open.ts:handleOpen` → `openFileByPath({force})`. **UNGATED → H1 fixes.**
3. `reloadDocumentFromMarkdown` (#1021 raw-markdown source-view edit, `file-opener.ts:375`→`403`) — reachable via `POST /api/document/reload` → `handleReloadFromMarkdown`. **ALREADY GATED** by `licenseGateMiddleware` at `api-routes.ts:224` — no change needed; listed so the set is provably complete.

Internal reloads (file-watcher `file-opener.ts:1495`, external-conflict resolve `:1594`)
route through `reloadFromDisk` (`:1338`), which **preserves and re-anchors** annotations
(no `store.clear`) and never touches `openFileByPath({force})`/`handleOpen` — so the H1
gate can never wrongly block them. All startup opens pass no `force`.

**Fix — gate the sub-path, not the tool:** `tandem_open` MUST stay on `withErrorBoundary`
(plain open is the escape hatch; the coverage test lists it UNGATED at line 75). So:
- `src/server/mcp/document.ts` `tandem_open` handler: place the gate at the **top of the handler, OUTSIDE the inner `try/catch` (between lines 292–293)** — `if (force === true) { const blocked = licenseGate(); if (blocked) return blocked; }` before the `try`/`openFileByPath`. (Placement matters: inside the try, a future throw would be re-categorized; `licenseGate()` never throws on the dark path so either is safe today, but outside is correct.) Import `licenseGate` from `./license-gate.js`.
- `routes/open.ts` `handleOpen`: after parsing `force`, `if (force === true && licenseGate() !== null) { sendLicenseRequired(res); return; }` before `openFileByPath`. Import `licenseGate`, `sendLicenseRequired`.
- Both reuse the existing `licenseGate()` primitive (`license-gate.ts:44`) — one policy, two transports, same pattern as `gatedTool`/`licenseGateMiddleware`.
- Dark-build inert: `licenseGate()` → `licenseGateResult({gateActive:false})` → `null`. ✓

**Tests (new, `tests/server/`):** `GATE_ENABLED` is **false under vitest by default**, so a
restricted test must force the gate — `vi.mock` `licenseGate`/`resolveLiveLicenseState`
to return restricted. `store.clear` is 3 layers deep and not exported, so assert at the
**`openFileByPath` boundary** instead:
- restricted + `force:true` → handler returns LICENSE_REQUIRED envelope **and `openFileByPath` was NOT called** (the robust, layer-correct proxy for "store.clear not reached").
- restricted + plain open (`force` absent/false) → `openFileByPath` IS called (escape hatch intact).
- trial + `force:true` and licensed + `force:true` → `openFileByPath` called.
- HTTP twin: `handleOpen` restricted + `force:true` → 403 LICENSE_REQUIRED, `openFileByPath` not called.

**Coverage-test note:** add a comment in `license-gate-coverage.test.ts` next to the
`tandem_open` UNGATED entry explaining it carries an **in-handler `force` gate** that
the wrapper-based regex cannot see — so the escape-hatch-vs-destructive split is
intentional and tested behaviorally elsewhere.

### H2 — Worker upstream fetch must degrade on a *thrown* fetch, not just a non-ok response
**Why:** `worker.ts:76` `const upstream = await fetchFn(...)` has no try/catch; the
default export (line 88) wraps nothing. A thrown/rejecting fetch (DNS, reset, timeout)
escapes as a Cloudflare **500 with an error body**. Because the fetch is reached only
*after* the entitlement + window gates, a prober distinguishes entitled+reachable (200)
/ entitled+upstream-down (204) / entitled+upstream-threw (500) — an **entitlement oracle**,
breaking the no-oracle invariant the file's own docstring claims. The existing
"degrades to 204 when upstream fails" test (`license-update-worker.test.ts:113`) uses a
*non-ok Response*, not a throw, so it gives false confidence.

**Fix:**
```ts
let upstream: Response;
try {
  upstream = await fetchFn(latestJsonUrl, { headers: { Accept: "application/json" } });
} catch {
  return reject();
}
if (!upstream.ok) return reject();
```
Always-compiled (infra worker, not flag-gated); behavior changes only on a thrown
fetch (previously 500 → now byte-identical 204). No app impact.

**Test:** add a case with `fetchFn: async () => { throw new Error("network"); }` for an
entitled in-window id, asserting status 204 + empty body + byte-identical to the
unknown-id path.

---

## Phase 2 — Medium (in-PR)

### M1 — Coverage test: assert union-completeness so a *new* unlisted mutator can't ship green
**Why:** `license-gate-coverage.test.ts` iterates only its hardcoded `GATED`(12) +
`UNGATED`(19) = 31 names. It does not assert that every registered tool is classified.
A future 32nd mutator registered with `withErrorBoundary` and forgotten in both lists
passes green — the exact fail-open class the test claims to prevent. (3-way converged:
security F3, annotation Finding 2, test-analyzer.)

**Fix:** add a test that extracts every wrapped tool name from `SRC`
(`/(?:gatedTool|withErrorBoundary)\(\s*"(tandem_\w+)"/g`), builds the set, and asserts
it equals `new Set([...GATED, ...UNGATED])`. Fails on any registered tool absent from
both lists (catches a new ungated mutator AND a new reader). Verify the current set is
exactly 31 so the assertion passes on this head; if a wrapped name legitimately isn't in
either list, that's a finding to resolve, not an exclusion to hardcode.

### M2 — Brand the two verifier return types (run-gate vs update-window)
**Why:** `verifyLicenseSignature` (run-forever) and `verifyLicense` (sig+expiry) both
return `LicenseMetadata`, and `resolveLicenseState`'s `verify?` seam (`license-state.ts:39`)
accepts either. Swapping `verify: verifyLicense` would throw on an expired license
(`verifier.ts:83`) → caught at `license-state.ts:67` → silently drop a **paying customer**
to `restricted`. Correct today (security confirmed no prod caller of the strict variant),
but a type-unprotected footgun whose blast radius is paid-user lockout.

**Fix (phantom brand, compile-time only):**
```ts
// license-types.ts (or verifier.ts) — string-literal brand for TS-version portability
export type SignatureVerified = LicenseMetadata & { readonly __runGateChecked: "signature" };
```
- `verifyLicenseSignature(): SignatureVerified` — one cast on the return at `verifier.ts:63` (`return signedLicense.metadata as SignatureVerified`); signature change at `verifier.ts:39`.
- Type `resolveLicenseState`'s seam as `verify?: (blob: string) => SignatureVerified` (`license-state.ts:39`).
- `verifyLicense` keeps returning `LicenseMetadata` → wiring it into the run gate becomes a
  compile error (TS2322, empirically confirmed on the repo's TS 5.9.3).
- **Brand portability:** prefer the string-literal brand above. An inline `unique symbol`
  in a type alias also works on 5.9.3 but is version-sensitive (older TS rejects it,
  TS1335); the string-literal form is portable and needs no declared `const`.
- **Precise touch set (NOT "a handful"):** exactly ONE test cast — `makeVerify`'s return in
  `license-state.test.ts:41-52` (all 5 injection sites at 138/154/170/188/202 funnel
  through it). `activateLicense` (`license-state.ts:138`) reads the branded value
  transparently — no change. `LicenseState.license: LicenseMetadata` accepts the branded
  value (subtype). No runtime field is constructed.

### M3 — Fix the operations runbook's Worker env var
**Why:** `docs/licensing-operations.md:93` says set Worker **secret** `LATEST_JSON`; the
Worker reads `env.PUBLIC_LATEST_JSON_URL` (`worker.ts:85,92`), a plaintext `[vars]` entry
(`wrangler.toml:19`, worker README). An operator following it verbatim makes every
entitled update check silently fail.

**Fix:** correct the name to `PUBLIC_LATEST_JSON_URL` and the mechanism to a `[vars]`
entry in `wrangler.toml` (not a secret), matching the worker README.

---

## Phase 3 — Test hardening (in-PR; these surfaces first execute on real users at flip)

### M4a — Surface A: test the `connection.readOnly = true` *outcome* (not just the predicate)
`provider.ts:152-160` performs the load-bearing assignment; only the pure
`connectionShouldBeReadOnly` predicate is tested today (the "callback fired, not outcome"
smell this PR was already bitten by). **Fix:** extract a tiny helper
`applyConnectionGate(connection, documentName, state)` that does the
predicate-then-assign, call it from `onAuthenticate` (inside the `GATE_ENABLED` guard),
and unit-test the outcome: restricted → doc-room connection `.readOnly === true`,
`CTRL_ROOM` connection `.readOnly` untouched; trial/licensed → untouched for both.

### M4b — `rebuildForLicenseChange()` outcome test
Assert the wired transition tears down + rebuilds (fresh provider/ydoc identities, or
`teardownAllTabs`/`startBootstrap` invoked) and does **not** use `connect()`/`reconnect()`
on a live socket — the exact seam where the CRITICAL bug regressed. Client test against a
fake provider set.

### M4c — Fail-CLOSED on corrupt license / trial files
`license-state.test.ts`: (a) corrupt `license.json` (`"{not json"`) → not licensed;
(b) corrupt `trial.json` → treated as day-0 trial (pin current behavior);
(c) `firstRunAt: "not-a-date"` → `restricted` (pin the NaN→closed behavior so a future
refactor can't flip it open).

### M4d — KV dropped-write log observability ("non-fatal but *loud*")
`license-kv-store.test.ts`: spy `console.error` in each of the three drop paths
(skip / non-ok HTTP / thrown fetch) and assert it fires with the license id and **never**
an email.

### M4e — Worker malformed-KV-entry byte-identity (third no-oracle branch)
`license-update-worker.test.ts`: add a 3rd arm to the byte-identity assertion with a KV
entry of `"{corrupt"`, asserting identical status + body to unknown-id / expired.

### M4f — Day-14 exact boundary (PR explicitly deferred this)
`license-state.test.ts`: at `nowMs === expiresAt` → `restricted` (strict `<`); at
`expiresAt - 1ms` → `trial`, `daysRemaining === 1`.

### M4g — `activateLicense` happy-path round-trip
`license-state.test.ts`: valid signed blob → persisted `license.json` → `licensed` state.
**Correction (plan-review):** the "real keypair, no surface change" option does NOT work —
`activateLicense` (`license-state.ts:138`) hardcodes `verifyLicenseSignature(blob)`, which
verifies against the **committed, pinned** `TANDEM_PUBLIC_KEY`; the matching private key is
not in the repo, so a `generateKeyPairSync` test key won't verify through it. So **make
`activateLicense` verifier-injectable** (add a `verify?` param mirroring
`resolveLicenseState`'s existing seam — small, symmetric, and removes the noted asymmetry),
then sign with a temp keypair as the crypto tests do. (Alternative: `vi.mock` the verifier
module — but the injectable seam is the cleaner parity fix.) Implement alongside M2 since
both touch the verifier wiring in `license-state.ts` (different regions, no conflict).

---

## Phase 4 — Low / Info hardening (in-PR, cheap, behavior-preserving)

### L1 — Bound decoded license length / recursion depth in the verifier
`verifier.ts`: after `const decoded = …`, reject `decoded.length > 4096` (real blobs <2KB
per the existing comment) so a deep-nested-array blob inside the 10 000-char input bound
can't `RangeError` `canonicalObject`. Catchable + loopback-only entry, so Low — but a
1-liner. Optionally a depth cap in `canonicalObject` (metadata is flat; depth >3 anomalous).

### L2 — Webhook 500 catch: static message
`webhook.ts:255-258`: return a static `"Webhook internal error"` and log the detail
server-side only (matches the activate-route posture). Defense-in-depth on Bryan's
webhook host where secrets exist.

### L3 — `__proto__` canonicalization hardening (Info)
`verifier.ts:14-16`: `sortedObj[key] = …` sets the prototype when `key === "__proto__"`.
Symmetric (signer == verifier) and the dropped key is never read, so non-exploitable —
but `const sortedObj = Object.create(null)` removes the foot-gun if the trusted field set
ever grows. Optional.

---

## Phase 5 — Foundational type refactor (DECISION 2026-06-18: FOLD INTO THIS PR)

Bryan chose completeness — implement in-PR. Sequence FIRST (the discriminated union is the
foundation M2/M4a/client all build on), get typecheck green, then layer the rest.

- **`LicenseState` → discriminated union** (type-design). Makes `trial`/`license` mutual
  exclusion compiler-checked and deletes the dark-build `{status:"licensed"}` sentinel
  (`license-state.ts:44`). Touches `deriveLicenseUi`, `connectionShouldBeReadOnly`,
  `licenseGateResult`, `formatLicenseStatus`, status route — mechanical (all switch on
  `status`) but broad. High value, separate concern.
- **Unify the two `Entitlement` shapes** (`kv-store.ts` `LicenseEntitlement` vs
  `worker.ts` `Entitlement`) into one shared type + zod-validate the disk/webhook
  boundaries (match the `integrations/` pattern). Low urgency.

---

## Sequencing & verification
1. Branch off `feat/1116-licensing-gate` head in the `tandem-licensing` worktree (work in-place on the PR branch).
2. Implement Phase 1 → 4 (Phase 5 = issues only).
3. `/simplify` pass on the diff.
4. Verify: `npm run typecheck` (tsc server + client + svelte-check), `npm test` (full
   suite; confirm the new license tests pass and 4275+ baseline holds), `cargo test`
   (unaffected — sanity). **Dark-build inertness is a reasoning/trace check, not a harness**
   (there is no byte-diff tooling in `scripts/`): by inspection, H1's force-gate, M2
   (type-only), and M1/M4 (tests) are inert when `GATE_ENABLED=false`; H2/L1/L2/L3 are
   always-compiled but behavior-preserving except on pathological/error inputs.
5. Rebase the two doc conflicts vs master (`CHANGELOG.md`, `CLAUDE.md` — bookkeeping only).
6. Push; update PR body with the fixes.

## Considered-and-dropped (visible, per review)
- **Lost edits in the teardown window → restricted-wall warning copy** (crdt LOW). Traced
  to a **non-issue**: `rebuildForLicenseChange` only drops *unsynced* local edits, and on a
  license transition the server-authoritative resync means synced edits survive; in
  restricted mode the connection is already read-only so there are no new local edits to
  lose. A restricted-wall "you may have lost edits" warning would be **inaccurate**, so it's
  deliberately NOT added. (Open question #3 below: file as a Phase-5 tracking issue, or
  leave dismissed here?)

## Open questions for Bryan
1. **M2 brand:** include now (recommended — cheap, prevents a future paid-user-lockout
   footgun) or defer? It defends against a swap that has *zero current callers*, so it's the
   most cuttable item — but it's ~6 lines + one test cast.
2. **Phase 5:** file as issues (recommended — one PR per concern, the discriminated-union
   refactor touches many consumers) or fold the refactor in now?
3. **Finding-18 (lost-edits copy):** file as a Phase-5 tracking issue for the trail, or
   leave dismissed in-plan as a verified non-issue?
