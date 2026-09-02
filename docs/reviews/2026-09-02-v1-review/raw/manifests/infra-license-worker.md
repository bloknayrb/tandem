# Manifest: infra license workers review

## Primary (infra/)
- infra/license-issuance-worker/wrangler.toml
- infra/license-issuance-worker/README.md
- infra/license-issuance-worker/src/worker.ts
- infra/license-issuance-worker/src/crypto.ts
- infra/license-update-worker/wrangler.toml
- infra/license-update-worker/README.md
- infra/license-update-worker/src/worker.ts

## App seams
- src/server/license/verifier.ts, license-state.ts, license-types.ts, activation.ts,
  public-key.ts, kv-store.ts, paste.ts, paths.ts, gate-flag.ts, connection-gate.ts
- src/cli/license.ts
- src-tauri/src/lib.rs (~171, ~2205-2300: entitled_license_id / build_updater / check_for_update)

## Docs
- docs/licensing-operations.md
- docs/licensing-explained.md
- docs/decisions.md (ADR-040)

## Tests / CI
- any tests under tests/ touching license or infra
- .github/workflows/*.yml (does CI touch infra/ at all?)

## Checks
1. Issuance: signing key handling, canonicalization parity vs app verifier (run both on one fixture),
   KV entitlement/order ledger PII, webhook sig verification, idempotency/replay, refund path.
2. Update worker: reason enum, no-update byte-identity, X-Tandem-License-Id, latestJsonUrl fetch,
   caching, expired window, downgrade offer, {{target}}/{{arch}}/{{current_version}} templating.
3. wrangler.toml x2: KV namespace id match, secrets/vars naming, routes, compat dates, reproducibility.
4. Worker tests exist? run if cheap. CI coverage of infra/.
5. Ops doc vs code: every command/path/env var exists; "cannot update" runbook.
6. App side: header name literal match; minisign/updater pubkey + who signs latest.json.
