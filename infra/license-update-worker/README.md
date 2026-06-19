# Tandem license-update Worker (L3)

License-checked auto-update endpoint. Gates access to the signed release manifest
on a valid, in-window license id. Part of the licensing system (#1116, ADR-040 §7).

- **Source:** `src/worker.ts` (pure `handleUpdateRequest` + default `fetch` export).
- **Tests:** `tests/server/license-update-worker.test.ts` (mock KV + mock fetch — no Cloudflare runtime needed). Run with the normal `npm test`.
- **Deploy:** owner-only. See [`docs/licensing-operations.md`](../../docs/licensing-operations.md) §3.

## How it works

1. The Tauri updater (loopback) checks `GET /api/license/status`. If `gateActive && licenseId && updateWindowCurrent`, it points `updater_builder` at this Worker with an `X-Tandem-License-Id` header; otherwise it uses the public GitHub manifest.
2. The Worker looks the id up in the `LICENSE_KV` namespace (written by the issuance webhook on a real purchase).
3. Entitled + inside the update window → it proxies `PUBLIC_LATEST_JSON_URL` (the signed manifest; the minisign signature is unchanged and still verified by the Tauri client `pubkey`). Otherwise → **HTTP 204**, byte-identical for unknown ids and expired windows (no existence oracle).

It logs only `{ result, ts }` — never the license id.

## Deploy

```bash
npx wrangler kv namespace create LICENSE_KV   # paste the id into wrangler.toml
# edit wrangler.toml: PUBLIC_LATEST_JSON_URL → your release manifest
npx wrangler deploy
```

The webhook side needs `TANDEM_CF_ACCOUNT_ID`, `TANDEM_CF_KV_NAMESPACE_ID`, and a
`TANDEM_CF_KV_API_TOKEN` (scoped *Workers KV Storage: Edit*) to populate the namespace.
